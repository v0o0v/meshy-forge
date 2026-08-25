#!/usr/bin/env node
/**
 * scripts/meshy-cache.mjs — Meshy 3D 모델 로컬 보관·검색 코어 CLI
 *
 * 왜 있나: Meshy 는 비-Enterprise 생성물을 **3일 뒤 서버에서 삭제**하고 서명 URL 도 3일에 만료된다
 * (https://docs.meshy.ai/en/api/asset-retention). 즉 다운로드를 놓치면 20~30크레딧이 그대로 증발하고,
 * `retexture`/`remesh` 가 받는 `input_task_id` 도 함께 죽는다(변형 창 = 생성 후 3일).
 * 이 CLI 는 ① 만료 전 원본을 로컬로 긁어와 영구 보관하고 ② 프롬프트로 다시 찾아 쓰게 만든다.
 *
 * 라이브러리(단일 전역, 로컬 전용 — git 에 올리지 않는다):
 *   <root>/index.json      원장(진실의 원천)
 *   <root>/models/<id>.glb 원본 GLB(풀 텍스처 그대로)
 *   <root>/thumbs/<id>.*   썸네일(Meshy thumbnail_url 을 만료 전에 함께 받아 둔 것)
 *   <root>/pending.json    아직 보관되지 않은 생성 task(만료 시계)
 *   <root>/index.sqlite    FTS5 파생 인덱스(재빌드 가능)
 *
 * root 해석 우선순위(설치 사본에 갇히는 사고 방지 — 아래 resolveLibraryRoot 주석 참조):
 *   1. MESHY_FORGE_LIBRARY
 *   2. ~/.claude/meshy-forge.json 의 "library"
 *   3. 마켓플레이스 등록 소스 디렉터리(known_marketplaces.json)의 <소스리포>/library
 *   4. <PLUGIN_ROOT>/library
 *
 * 명령:
 *   init | config | find | list | get | store | pending | export | prune | setup | rebuild | test
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync, statSync, rmSync, mkdtempSync, utimesSync, realpathSync,
} from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import {
  ensureFresh, getCandidates, rebuild as rebuildIndex, upsertOne, removeIds,
  closeAll, BackendUnavailableError,
  verifyBackend, BACKEND_OK, BACKEND_MISSING, BACKEND_BROKEN,
} from './meshy-index.mjs';

export { BackendUnavailableError } from './meshy-index.mjs';

/** 재사용 "후보 제시" 경계값. pixellab-forge 와 달리 강제가 아니다 — 3D 는 미세한 형상 차이가 용도를 가른다. */
export const REUSE_THRESHOLD = 0.6;
/** Meshy 비-Enterprise 보관 기간(일). 이 창을 넘기면 원본 재다운로드도 task id 변형도 불가능하다. */
export const RETENTION_DAYS = 3;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STOPWORDS = new Set('a an the with and or of for to in on at is are be as by from into over under single centered model mesh 3d low poly lowpoly game asset render'.split(/\s+/));

// ── 어휘 유사도 ─────────────────────────────────────────────────────────────
export function tokenize(s) {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length > 1 && !STOPWORDS.has(w));
}
// 태그 전용 토큰화: STOPWORD 미적용(`boss`,`lowpoly` 등 의미있는 태그 보존), 특수문자 제거(FTS 주입 차단).
export function tokenizeTag(s) {
  return String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 1);
}
function jaccard(aArr, bArr) {
  const a = new Set(aArr), b = new Set(bArr);
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function overlapRatio(aArr, bArr) {
  const a = new Set(aArr), b = new Set(bArr);
  if (a.size === 0) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / a.size;
}
function blendSim(aArr, bArr) { return 0.5 * jaccard(aArr, bArr) + 0.5 * overlapRatio(aArr, bArr); }

// ── 원장 스키마 접근자 ───────────────────────────────────────────────────────
export function entryStyle(e) { return (e.style && e.style.style) || undefined; }
export function entryPolycount(e) { return e.style && e.style.polycount != null ? Number(e.style.polycount) : undefined; }
export function entryTextured(e) { return e.style && e.style.textured != null ? !!e.style.textured : undefined; }
export function entryFile(e) { return (e.files && e.files[0]) || (e.id + '.glb'); }
export function promptText(e) { return [e.prompt || '', e.texturePrompt || ''].filter(Boolean).join(' '); }

/**
 * score(query, entry) ∈ [0,1]
 *   기본 = prompt(형상+텍스처 문구) 어휘 유사도. 질의 태그가 있으면 0.7×prompt + 0.3×태그겹침.
 *   3D facet 보정: 스타일 프리셋(세트 일관성) ±0.05, 폴리곤 규모 ±0.03, 텍스처 유무 ±0.02.
 */
export function score(query, entry) {
  const qTok = tokenize(query.prompt), eTok = tokenize(promptText(entry));
  const qTags = (query.tags || []).map((t) => String(t).toLowerCase());
  const eTags = (entry.tags || []).map((t) => String(t).toLowerCase());
  const promptSim = blendSim(qTok, eTok);
  let s = qTags.length ? (0.7 * promptSim + 0.3 * overlapRatio(qTags, eTags)) : promptSim;
  const es = entryStyle(entry), ep = entryPolycount(entry), et = entryTextured(entry);
  if (query.style && es) s += (query.style === es) ? 0.05 : -0.05;
  if (query.polycount && ep) {
    const ratio = Math.max(query.polycount, ep) / Math.max(1, Math.min(query.polycount, ep));
    s += ratio <= 1.5 ? 0.03 : -0.03;
  }
  if (query.textured != null && et != null) s += (query.textured === et) ? 0.02 : -0.02;
  return Math.max(0, Math.min(1, s));
}

function styleCompatible(query, entry) {
  const es = entryStyle(entry), ep = entryPolycount(entry), et = entryTextured(entry);
  if (query.style && es && query.style !== es) return false;
  if (query.textured != null && et != null && query.textured !== et) return false;
  if (query.polycount && ep) {
    const ratio = Math.max(query.polycount, ep) / Math.max(1, Math.min(query.polycount, ep));
    if (ratio > 3) return false;
  }
  return true;
}

// ── 라이브러리 루트 해석 ────────────────────────────────────────────────────
function readJsonSafe(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

/**
 * 왜 `<PLUGIN_ROOT>/library` 를 기본값으로 쓰지 않는가:
 * 로컬 디렉터리 마켓플레이스로 설치하면 플러그인이 `~/.claude/plugins/cache/...` 로 **복사**된다.
 * pixellab-forge 에서 실제로 이 함정을 밟았다 — "전역 라이브러리"가 사실 설치 사본이라 생성분이
 * 소스 리포에 안 올라간 채 방치됐다. 여기서는 라이브러리가 git 에도 안 올라가므로 그 사본이 유일본이 되고,
 * 플러그인 재설치 한 번에 GLB 원본이 통째로 사라질 수 있다. 그래서 설치 레지스트리에서 **소스 리포 경로**를
 * 역추적해 거기의 library 를 쓴다.
 */
export function resolveLibraryRoot(env = process.env) {
  if (env.MESHY_FORGE_LIBRARY) return { root: env.MESHY_FORGE_LIBRARY, from: 'MESHY_FORGE_LIBRARY' };
  const userCfg = readJsonSafe(path.join(os.homedir(), '.claude', 'meshy-forge.json'));
  if (userCfg && userCfg.library) return { root: userCfg.library, from: '~/.claude/meshy-forge.json' };
  const markets = readJsonSafe(path.join(env.MESHY_PLUGINS_DIR || path.join(os.homedir(), '.claude', 'plugins'), 'known_marketplaces.json'));
  const mk = markets && (markets['meshy-forge'] || (markets.marketplaces && markets.marketplaces['meshy-forge']));
  const src = mk && (mk.installLocation || (mk.source && mk.source.path));
  if (src && existsSync(src)) return { root: path.join(src, 'library'), from: '마켓플레이스 소스 리포' };
  return { root: path.join(PLUGIN_ROOT, 'library'), from: 'PLUGIN_ROOT(폴백)' };
}

function rootPaths(root) {
  return {
    index: path.join(root, 'index.json'),
    models: path.join(root, 'models'),
    thumbs: path.join(root, 'thumbs'),
    pending: path.join(root, 'pending.json'),
  };
}

export function loadIndex(root) {
  const { index } = rootPaths(root);
  if (!existsSync(index)) return { _doc: 'Meshy 보관 모델 원장', version: 1, reuseThreshold: REUSE_THRESHOLD, entries: [] };
  try {
    const idx = JSON.parse(readFileSync(index, 'utf8'));
    if (!Array.isArray(idx.entries)) idx.entries = [];
    return idx;
  } catch (e) { throw new Error(`index.json 파싱 오류 (${index}): ${e.message}`); }
}
function saveIndex(root, idx) {
  mkdirSync(root, { recursive: true });
  writeFileSync(rootPaths(root).index, JSON.stringify(idx, null, 2));
}
export function hashFile(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}
export function absModelPath(entry, root) { return path.join(root, 'models', entryFile(entry)); }
export function absThumbPath(entry, root) { return entry.thumbnail ? path.join(root, 'thumbs', entry.thumbnail) : null; }

// ── GLB 실측(지오메트리 vs 텍스처) ──────────────────────────────────────────
/**
 * glbStats(file) → { bytes, triangles, textureBytes, images[] }
 * GLB = 12바이트 헤더 + 청크(JSON/BIN). "왜 무거운가"는 지오메트리인지 텍스처인지에 따라 처방이 갈리므로
 * 다운로드 크기만 보지 말고 갈라서 기록한다(실측 예: 13.5MB 중 13.1MB 가 2K 텍스처 두 장).
 */
export function glbStats(file) {
  const b = readFileSync(file);
  const out = { bytes: b.length, triangles: null, textureBytes: null, images: [] };
  if (b.length < 12 || b.readUInt32LE(0) !== 0x46546c67) return out; // 'glTF' 아님(비-GLB)
  let off = 12;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) { // 'JSON'
      let j;
      try { j = JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8')); } catch { return out; }
      let tri = 0;
      for (const m of (j.meshes || [])) {
        for (const p of (m.primitives || [])) {
          const acc = p.indices != null ? j.accessors[p.indices] : (p.attributes && p.attributes.POSITION != null ? j.accessors[p.attributes.POSITION] : null);
          if (acc) tri += Math.floor(acc.count / 3);
        }
      }
      out.triangles = tri;
      let texBytes = 0;
      for (const im of (j.images || [])) {
        const bv = im.bufferView != null ? (j.bufferViews || [])[im.bufferView] : null;
        const size = bv ? bv.byteLength : 0;
        texBytes += size;
        out.images.push({ mimeType: im.mimeType || 'unknown', bytes: size });
      }
      out.textureBytes = texBytes;
      break;
    }
    off += 8 + len;
  }
  return out;
}

// ── 만료 시계 ────────────────────────────────────────────────────────────────
const DAY_MS = 86400000;
export function expiryOf(createdAtIso, retentionDays = RETENTION_DAYS) {
  const t = Date.parse(createdAtIso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + retentionDays * DAY_MS).toISOString();
}
/** 남은 시간(시간 단위). 음수면 이미 만료. */
export function hoursLeft(expiresAtIso, nowMs = Date.now()) {
  const t = Date.parse(expiresAtIso);
  if (!Number.isFinite(t)) return null;
  return (t - nowMs) / 3600000;
}
function expiryLabel(expiresAt, nowMs = Date.now()) {
  const h = hoursLeft(expiresAt, nowMs);
  if (h == null) return '만료일 미상';
  if (h < 0) return `만료됨(${Math.floor(-h)}시간 경과) — 원본 재다운로드·task id 변형 불가`;
  return `만료까지 ${h.toFixed(1)}시간 — 이 창 안에서만 retexture/remesh 가능`;
}

// ── 검색 ────────────────────────────────────────────────────────────────────
/** 현 알고리즘 보존 — 회귀 등가(ground truth) 기준. 전량 로드 + 선형 score(). */
export function findMatchesLinear(query, root, opts = {}) {
  const top = opts.top || 5;
  let entries = loadIndex(root).entries;
  if (opts.styleStrict) entries = entries.filter((e) => styleCompatible(query, e));
  return entries.map((e) => {
    let s = score(query, e);
    if (query.contentHash && e.contentHash && e.contentHash === query.contentHash) s = 1;
    return { e, s };
  }).sort((x, y) => y.s - x.s).slice(0, top);
}

/** 검색 핫패스: FTS5 로 후보를 추린 뒤 기존 score() 로만 재랭킹(판정 의미는 linear 와 등가). */
export function findMatches(query, root, opts = {}) {
  const top = opts.top || 5;
  const allowRebuild = opts.allowRebuild ?? true;
  const kMax = opts.candidateK || Number(process.env.MESHY_CANDIDATE_K) || 5000;
  if (!existsSync(path.join(root, 'index.json')) && !existsSync(path.join(root, 'index.sqlite'))) return [];
  const fr = ensureFresh(root, { allowRebuild }); // 백엔드 부재 시 throw
  if (!fr.fresh) return []; // 훅(allowRebuild:false)에서 stale/부재 → 조회 skip
  let ents = getCandidates(root, query, kMax);
  if (opts.styleStrict) ents = ents.filter((e) => styleCompatible(query, e));
  return ents.map((e) => {
    let s = score(query, e);
    if (query.contentHash && e.contentHash && e.contentHash === query.contentHash) s = 1;
    return { e, s };
  }).sort((x, y) => y.s - x.s).slice(0, top);
}

// ── 보관(store) ─────────────────────────────────────────────────────────────
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * storeEntry(root, opts) — GLB 를 models/ 로 복사하고 원장에 upsert.
 * opts: { id, prompt, texturePrompt, file, thumbFile, tags[], style{...}, meshy{...}, project,
 *         license{license,author,source}, createdAt }
 * 반환: { entry, duplicateOf, total }
 */
export function storeEntry(root, opts) {
  if (!opts.id || !opts.prompt || !opts.file) throw new Error('storeEntry 필수: id, prompt, file');
  if (!existsSync(opts.file)) throw new Error(`파일 없음: ${opts.file}`);
  const idx = loadIndex(root);
  const contentHash = hashFile(opts.file);
  const dup = idx.entries.find((e) => e.contentHash && e.contentHash === contentHash && e.id !== opts.id);
  const { models, thumbs } = rootPaths(root);
  mkdirSync(models, { recursive: true });
  const ext = (path.extname(opts.file) || '.glb').toLowerCase();
  const destName = opts.id + ext;
  copyFileSync(opts.file, path.join(models, destName));
  let thumbName;
  if (opts.thumbFile && existsSync(opts.thumbFile)) {
    mkdirSync(thumbs, { recursive: true });
    thumbName = opts.id + (path.extname(opts.thumbFile) || '.png').toLowerCase();
    copyFileSync(opts.thumbFile, path.join(thumbs, thumbName));
  }
  const stats = glbStats(path.join(models, destName));
  const createdAt = opts.createdAt || new Date().toISOString();
  const meshy = opts.meshy || {};
  const entry = {
    id: opts.id,
    prompt: opts.prompt,
    texturePrompt: opts.texturePrompt || undefined,
    style: compact({
      style: opts.style && opts.style.style || undefined,
      aiModel: opts.style && opts.style.aiModel || undefined,
      polycount: opts.style && opts.style.polycount != null ? Number(opts.style.polycount) : undefined,
      topology: opts.style && opts.style.topology || undefined,
      textured: opts.style && opts.style.textured != null ? !!opts.style.textured : undefined,
      pbr: opts.style && opts.style.pbr != null ? !!opts.style.pbr : undefined,
    }),
    tags: opts.tags || [],
    project: opts.project || undefined,
    meshy: compact({
      taskId: meshy.taskId || undefined,
      previewTaskId: meshy.previewTaskId || undefined,
      sourceTaskId: meshy.sourceTaskId || undefined,
      taskType: meshy.taskType || undefined,
      // 어느 API 키(계정)로 만들었는지. task 는 계정에 귀속되므로 이 값이 없으면
      // 복수 키 환경에서 input_task_id 기반 retexture/remesh 를 어느 키로 보낼지 알 수 없다.
      // 키 값이 아니라 라벨(key1/key2)만 적는다 — 원장은 평문이다.
      keyLabel: meshy.keyLabel || undefined,
      credits: meshy.credits != null ? Number(meshy.credits) : undefined,
      // 서버 보관 만료 — 이 시각을 넘기면 원본 재다운로드도, input_task_id 기반 변형도 불가능하다.
      expiresAt: meshy.expiresAt || expiryOf(createdAt) || undefined,
    }),
    geometry: compact({
      triangles: stats.triangles ?? undefined,
      bytes: stats.bytes,
      textureBytes: stats.textureBytes ?? undefined,
    }),
    files: [destName],
    thumbnail: thumbName,
    license: compact({
      license: opts.license && opts.license.license || undefined,
      author: opts.license && opts.license.author || undefined,
      source: opts.license && opts.license.source || undefined,
    }),
    contentHash,
    createdAt,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  const at = idx.entries.findIndex((e) => e.id === opts.id);
  if (at >= 0) idx.entries[at] = entry; else idx.entries.push(entry);
  saveIndex(root, idx);
  return { entry, duplicateOf: dup ? dup.id : null, total: idx.entries.length };
}

// ── 미보관 task 원장(pending) ────────────────────────────────────────────────
export function loadPending(root) {
  const { pending } = rootPaths(root);
  if (!existsSync(pending)) return { _doc: '아직 보관되지 않은 Meshy 생성 task(만료 시계)', tasks: [] };
  const j = readJsonSafe(pending);
  if (!j || !Array.isArray(j.tasks)) return { _doc: '아직 보관되지 않은 Meshy 생성 task(만료 시계)', tasks: [] };
  return j;
}
function savePending(root, p) {
  mkdirSync(root, { recursive: true });
  writeFileSync(rootPaths(root).pending, JSON.stringify(p, null, 2));
}
/**
 * recordPending(root, rec) — 생성 호출을 원장에 남긴다(PostToolUse 훅이 호출).
 * rec: { tool, prompt, texturePrompt, credits, taskId?, createdAt? }
 * 호출 시점에는 task_id 를 아직 모를 수 있다(훅은 도구 응답 전/후 어느 쪽이든 될 수 있고, 응답 형식도
 * 도구마다 다르다). 그래서 taskId 없이도 기록해 두고, store 시점에 prompt 로 매칭해 정리한다.
 */
export function recordPending(root, rec) {
  const p = loadPending(root);
  const createdAt = rec.createdAt || new Date().toISOString();
  p.tasks.push({
    tool: rec.tool || undefined,
    taskId: rec.taskId || undefined,
    prompt: rec.prompt || '',
    texturePrompt: rec.texturePrompt || undefined,
    credits: rec.credits != null ? Number(rec.credits) : undefined,
    createdAt,
    expiresAt: expiryOf(createdAt),
  });
  // 만료된 지 7일 넘은 기록은 잘라 낸다(원장이 무한히 자라지 않도록).
  const cut = Date.now() - 7 * DAY_MS;
  p.tasks = p.tasks.filter((t) => (Date.parse(t.expiresAt || t.createdAt) || 0) > cut);
  savePending(root, p);
  return p.tasks.length;
}
/** markStored — taskId 또는 prompt 로 pending 항목을 제거(보관 완료). */
export function markStored(root, { taskId, prompt }) {
  const p = loadPending(root);
  const before = p.tasks.length;
  p.tasks = p.tasks.filter((t) => {
    if (taskId && t.taskId && t.taskId === taskId) return false;
    if (!taskId && prompt && t.prompt && t.prompt.trim() === String(prompt).trim()) return false;
    return true;
  });
  if (p.tasks.length !== before) savePending(root, p);
  return before - p.tasks.length;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}
const str = (v) => (v && v !== 'true' ? String(v) : undefined);
const num = (v) => (v && v !== 'true' ? Number(v) : undefined);
const bool = (v) => (v === undefined ? undefined : v === 'true' || v === '1' || v === 'yes');
function relToCwd(p) { return path.relative(process.cwd(), p).replace(/\\/g, '/') || p; }
const mb = (n) => (n == null ? '?' : (n / 1048576).toFixed(2) + 'MB');

function cmdInit() {
  const { root, from } = resolveLibraryRoot();
  const rp = rootPaths(root);
  mkdirSync(rp.models, { recursive: true });
  mkdirSync(rp.thumbs, { recursive: true });
  if (!existsSync(rp.index)) saveIndex(root, loadIndex(root));
  if (!existsSync(rp.pending)) savePending(root, loadPending(root));
  console.log(`라이브러리 ${root}  (경로 출처: ${from})`);
  console.log('초기화 완료 — models/ thumbs/ index.json pending.json');
}

function cmdConfig() {
  const { root, from } = resolveLibraryRoot();
  console.log('Meshy Forge 설정');
  console.log('─'.repeat(64));
  console.log(`라이브러리 루트   ${root}`);
  console.log(`경로 출처         ${from}`);
  console.log(`REUSE_THRESHOLD   ${REUSE_THRESHOLD} (후보 제시 경계 — 강제 아님)`);
  console.log(`서버 보관         ${RETENTION_DAYS}일 (비-Enterprise, docs.meshy.ai/en/api/asset-retention)`);
  console.log('─'.repeat(64));
  console.log('환경변수:');
  console.log(`  MESHY_FORGE_LIBRARY = ${process.env.MESHY_FORGE_LIBRARY || '(미설정)'}`);
  const n = existsSync(rootPaths(root).index) ? loadIndex(root).entries.length : 0;
  const pend = loadPending(root).tasks.length;
  let bytes = 0;
  const mdir = rootPaths(root).models;
  if (existsSync(mdir)) for (const f of readdirSync(mdir)) { try { bytes += statSync(path.join(mdir, f)).size; } catch { /* skip */ } }
  console.log(`보관 ${n}건 (${mb(bytes)}), 미보관 pending ${pend}건`);
}

function buildQuery(args) {
  return {
    prompt: args._[0] || '',
    tags: args.tags ? String(args.tags).split(',') : [],
    style: str(args.style),
    polycount: num(args.polycount),
    textured: args.textured !== undefined ? bool(args.textured) : undefined,
    contentHash: (args.file && args.file !== 'true' && existsSync(args.file)) ? hashFile(args.file) : undefined,
  };
}

function cmdFind(args) {
  const { root } = resolveLibraryRoot();
  const query = buildQuery(args);
  if (!query.prompt && query.tags.length === 0 && !query.contentHash) {
    console.error('사용법: find "<영문 설명>" [--tags a,b] [--style <프리셋>] [--polycount 8000] [--textured true] [--file ref.glb] [--style-strict] [--top N]');
    process.exit(1);
  }
  let ranked;
  try {
    ranked = findMatches(query, root, { top: Number(args.top || 5), styleStrict: args['style-strict'] === 'true' });
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
  console.log(`질의: "${query.prompt}"${query.tags.length ? ' tags=[' + query.tags.join(',') + ']' : ''}${query.style ? ' style=' + query.style : ''}`);
  console.log('─'.repeat(64));
  if (ranked.length === 0) {
    console.log('🆕 신규 생성 권장: 질의와 겹치는 보관 모델 없음');
    return;
  }
  for (const { e, s } of ranked) {
    console.log(`${s.toFixed(2)}  ${e.id}  {${(e.tags || []).slice(0, 6).join(', ')}}`);
    console.log(`      prompt: ${e.prompt}`);
    console.log(`      file:   ${relToCwd(absModelPath(e, root))}  ${mb(e.geometry && e.geometry.bytes)} tri:${(e.geometry && e.geometry.triangles) ?? '?'} tex:${mb(e.geometry && e.geometry.textureBytes)}`);
    const exp = e.meshy && e.meshy.expiresAt;
    if (exp) console.log(`      meshy:  ${expiryLabel(exp)}${e.meshy.taskId ? ' (task ' + e.meshy.taskId + ')' : ''}`);
  }
  console.log('─'.repeat(64));
  const best = ranked[0];
  if (best.s >= REUSE_THRESHOLD) {
    const exact = query.contentHash && best.e.contentHash === query.contentHash;
    console.log(`♻️ 재사용 후보: score ${best.s.toFixed(2)} ≥ ${REUSE_THRESHOLD}${exact ? ' (정확 중복 — 동일 바이트)' : ''}`);
    console.log(`   → ${absModelPath(best.e, root)}`);
    console.log('   그대로 쓰거나 export 로 복사. 형상은 맞는데 색·재질만 다르면:');
    const exp = best.e.meshy && best.e.meshy.expiresAt;
    const h = exp ? hoursLeft(exp) : null;
    if (h != null && h > 0) console.log(`   meshy_retexture(input_task_id: "${(best.e.meshy && best.e.meshy.taskId) || '<task id>'}") — 10크레딧, ${h.toFixed(1)}시간 남음`);
    else console.log('   ⚠️ task 만료 — 변형 경로는 닫혔다. 재사용하거나 새로 생성해야 한다.');
  } else {
    console.log(`🆕 신규 생성 권장: 최고 score ${best.s.toFixed(2)} < ${REUSE_THRESHOLD}`);
  }
}

function cmdList(args) {
  const { root } = resolveLibraryRoot();
  let entries = loadIndex(root).entries;
  const filterTags = args.tags ? String(args.tags).split(',').map((t) => t.toLowerCase()) : null;
  if (filterTags) entries = entries.filter((e) => filterTags.every((t) => (e.tags || []).map((x) => String(x).toLowerCase()).includes(t)));
  const styleF = str(args.style);
  if (styleF) entries = entries.filter((e) => entryStyle(e) === styleF);
  console.log(`보관 모델 ${entries.length}건${filterTags ? ' tags=' + filterTags.join(',') : ''}${styleF ? ' style=' + styleF : ''}:`);
  for (const e of entries) {
    console.log(`  ${e.id.padEnd(28)} ${mb(e.geometry && e.geometry.bytes).padStart(8)}  tri:${String((e.geometry && e.geometry.triangles) ?? '?').padStart(7)}  ${(e.tags || []).slice(0, 4).join(',')}`);
  }
}

function cmdGet(args) {
  const { root } = resolveLibraryRoot();
  const id = args._[0];
  const e = loadIndex(root).entries.find((x) => x.id === id);
  if (!e) { console.error(`없음: ${id}`); process.exit(1); }
  console.log(JSON.stringify({
    ...e,
    _modelPath: absModelPath(e, root),
    _thumbPath: absThumbPath(e, root),
    _expiry: e.meshy && e.meshy.expiresAt ? expiryLabel(e.meshy.expiresAt) : undefined,
  }, null, 2));
}

function loadStylePreset(name) {
  if (!name) return null;
  const f = path.join(PLUGIN_ROOT, 'styles', `${name}.json`);
  return existsSync(f) ? readJsonSafe(f) : null;
}

/**
 * 썸네일 내려받기 — Meshy 의 `thumbnail_url` 도 서명 URL 이라 3일이면 만료된다.
 * 즉 GLB 와 **같은 시점에** 받아 두지 않으면 목록 미리보기를 영영 잃는다(재생성 불가).
 */
async function downloadThumb(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
  const tmpFile = path.join(os.tmpdir(), `meshy-thumb-${id}${ext}`);
  writeFileSync(tmpFile, buf);
  return tmpFile;
}

async function cmdStore(args) {
  if (!args.id || !args.prompt || !args.file) {
    console.error('필수: --id --prompt --file <glb>');
    console.error('선택: --texture-prompt --thumb <png> --thumb-url <url> --task-id --preview-task-id --source-task-id --task-type');
    console.error('      --style <프리셋> --ai-model --polycount --topology --textured --pbr --credits');
    console.error('      --tags a,b --project <이름> --license --author --source --created <ISO>');
    process.exit(1);
  }
  const { root } = resolveLibraryRoot();
  try {
    ensureFresh(root, { allowRebuild: true });
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
  const preset = loadStylePreset(str(args.style));
  let thumbFile = str(args.thumb);
  const thumbUrl = str(args['thumb-url']);
  if (!thumbFile && thumbUrl) {
    try { thumbFile = await downloadThumb(thumbUrl, args.id); } catch (e) {
      console.log(`⚠️ 썸네일 다운로드 실패(${e.message}) — 모델만 보관한다. 갤러리에서 첫 프레임으로 대체된다.`);
    }
  }
  const res = storeEntry(root, {
    id: args.id,
    prompt: args.prompt,
    texturePrompt: str(args['texture-prompt']),
    file: args.file,
    thumbFile,
    tags: args.tags ? String(args.tags).split(',') : [],
    project: str(args.project),
    style: {
      style: str(args.style),
      aiModel: str(args['ai-model']) || (preset && preset.aiModel),
      polycount: num(args.polycount) ?? (preset && preset.targetPolycount),
      topology: str(args.topology) || (preset && preset.topology),
      textured: args.textured !== undefined ? bool(args.textured) : undefined,
      pbr: args.pbr !== undefined ? bool(args.pbr) : undefined,
    },
    meshy: {
      taskId: str(args['task-id']),
      previewTaskId: str(args['preview-task-id']),
      sourceTaskId: str(args['source-task-id']),
      taskType: str(args['task-type']),
      credits: num(args.credits),
    },
    license: { license: str(args.license), author: str(args.author), source: str(args.source) },
    createdAt: str(args.created),
  });
  upsertOne(root, res.entry);
  const cleared = markStored(root, { taskId: str(args['task-id']), prompt: args.prompt });
  const g = res.entry.geometry || {};
  console.log(`보관: ${args.id} → ${absModelPath(res.entry, root)}`);
  console.log(`  ${mb(g.bytes)} (지오메트리 ${g.triangles ?? '?'} 삼각형, 텍스처 ${mb(g.textureBytes)})  총 ${res.total}건`);
  if (res.entry.meshy && res.entry.meshy.expiresAt) console.log(`  서버 ${expiryLabel(res.entry.meshy.expiresAt)}`);
  if (cleared) console.log(`  pending ${cleared}건 정리됨`);
  if (res.duplicateOf) console.log(`⚠️ 동일 바이트 기존 항목: ${res.duplicateOf} (중복 보관)`);
  if (!str(args['task-id'])) console.log('⚠️ --task-id 미지정 — 만료 전 변형(retexture/remesh) 경로를 잃는다. 가능하면 기록하라.');
}

function cmdPending(args) {
  const { root } = resolveLibraryRoot();
  const sub = args._[0] || 'list';
  if (sub === 'clear') {
    const n = markStored(root, { taskId: str(args['task-id']), prompt: str(args.prompt) });
    console.log(`pending ${n}건 정리`);
    return;
  }
  const tasks = loadPending(root).tasks;
  if (!tasks.length) { console.log('미보관 task 없음 — 전부 로컬에 보관됨.'); return; }
  console.log(`미보관 task ${tasks.length}건 (서버 보관 ${RETENTION_DAYS}일):`);
  const sorted = tasks.slice().sort((a, b) => Date.parse(a.expiresAt || 0) - Date.parse(b.expiresAt || 0));
  for (const t of sorted) {
    const h = t.expiresAt ? hoursLeft(t.expiresAt) : null;
    const mark = h == null ? '  ' : (h < 0 ? '💀' : (h < 24 ? '🔥' : '  '));
    console.log(`${mark} ${(t.taskId || '(task id 미기록)').padEnd(38)} ${h == null ? '?' : h.toFixed(1) + 'h'}  ${String(t.prompt).slice(0, 50)}`);
  }
  console.log('→ 아직 안 받았으면 지금 받아라: meshy_download_model(task_id, format:"glb") → store');
}

function cmdExport(args) {
  const { root } = resolveLibraryRoot();
  const id = str(args.id) || args._[0];
  const to = str(args.to);
  if (!id || !to) { console.error('사용법: export --id <id> --to <대상 경로|디렉터리>'); process.exit(1); }
  const e = loadIndex(root).entries.find((x) => x.id === id);
  if (!e) { console.error(`없음: ${id}`); process.exit(1); }
  const src = absModelPath(e, root);
  if (!existsSync(src)) { console.error(`원본 파일 없음(원장에는 있음): ${src}`); process.exit(1); }
  const isDir = existsSync(to) ? statSync(to).isDirectory() : !path.extname(to);
  const dest = isDir ? path.join(to, entryFile(e)) : to;
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  const g = e.geometry || {};
  console.log(`복사: ${dest} (${mb(g.bytes)})`);
  if (g.textureBytes && g.textureBytes > 2 * 1048576) {
    console.log(`⚠️ 텍스처가 ${mb(g.textureBytes)} — 웹/게임 반입 전 표시 해상도에 맞춰 축소하라(소비 프로젝트 빌드 파이프라인 담당).`);
  }
}

function cmdPrune() {
  const { root } = resolveLibraryRoot();
  const { models } = rootPaths(root);
  const idx = loadIndex(root);
  const before = idx.entries.length;
  const removedIds = idx.entries.filter((e) => !existsSync(path.join(models, entryFile(e)))).map((e) => e.id);
  idx.entries = idx.entries.filter((e) => existsSync(path.join(models, entryFile(e))));
  if (removedIds.length) {
    saveIndex(root, idx);
    try { removeIds(root, removedIds); } catch (e) { if (!(e instanceof BackendUnavailableError)) throw e; }
  }
  let bytes = 0;
  if (existsSync(models)) for (const f of readdirSync(models)) { try { bytes += statSync(path.join(models, f)).size; } catch { /* skip */ } }
  console.log(`원장 ${idx.entries.length}건 (파일 없는 항목 ${before - idx.entries.length}건 정리), models ${mb(bytes)} — ${root}`);
  // 고아 파일(원장에 없는데 디스크에 있는 것) — 지우지 않고 알리기만 한다(유일본이라 삭제는 위험).
  const known = new Set(idx.entries.map((e) => entryFile(e)));
  const orphans = existsSync(models) ? readdirSync(models).filter((f) => !known.has(f)) : [];
  if (orphans.length) console.log(`⚠️ 원장에 없는 파일 ${orphans.length}건(삭제 안 함): ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ' …' : ''}`);
}

// ── 백엔드 배선 ─────────────────────────────────────────────────────────────
function backendHint() {
  const cli = path.join(PLUGIN_ROOT, 'scripts', 'meshy-cache.mjs');
  return [
    'better-sqlite3(검색 인덱스 백엔드)를 쓸 수 없습니다(미설치 또는 네이티브 바인딩 로드 실패).',
    `  setup 실행:  node "${cli}" setup`,
    `  수동 복구:   cd "${PLUGIN_ROOT}" && npm rebuild better-sqlite3   (설치돼 있는데 로드 실패할 때)`,
    `  수동 설치:   cd "${PLUGIN_ROOT}" && npm install                  (아예 없을 때)`,
  ].join('\n');
}
function npmRun(args) {
  return spawnSync('npm', args, { cwd: PLUGIN_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}
const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

/** setup — 백엔드를 실제로 쓸 수 있는 상태로 만든다. 자동 npm 실행은 이 명령에서만(find/store/훅은 절대 X). */
function cmdSetup() {
  let v = verifyBackend();
  if (v.status === BACKEND_BROKEN) {
    // 패키지는 있는데 바인딩이 없거나 ABI 불일치. npm install 은 아무것도 안 하므로 rebuild 가 유일한 처방.
    console.log(`better-sqlite3 로드 실패 → npm rebuild 실행 (${PLUGIN_ROOT}) ...`);
    console.log(`  사유: ${firstLine(v.detail)}`);
    npmRun(['rebuild', 'better-sqlite3']);
    v = verifyBackend();
  }
  if (v.status === BACKEND_MISSING) {
    console.log(`better-sqlite3 미설치 → npm install 실행 (${PLUGIN_ROOT}) ...`);
    npmRun(['install', '--omit=dev']);
    v = verifyBackend();
    if (v.status === BACKEND_BROKEN) {
      console.log('설치 후에도 바인딩 로드 실패 → npm rebuild 재시도 ...');
      npmRun(['rebuild', 'better-sqlite3']);
      v = verifyBackend();
    }
  }
  if (v.status !== BACKEND_OK) {
    console.error(`백엔드 사용 불가(${v.status}): ${v.detail}`);
    console.error(backendHint());
    process.exit(1);
  }
  console.log(`better-sqlite3 사용 가능 — ${v.detail}`);
  const { root } = resolveLibraryRoot();
  mkdirSync(rootPaths(root).models, { recursive: true });
  if (!existsSync(rootPaths(root).index)) saveIndex(root, loadIndex(root));
  try {
    rebuildIndex(root);
    console.log(`인덱스 rebuild 확인 완료(FTS5 동작) — ${root}`);
  } catch (e) {
    console.error(`인덱스 rebuild 실패: ${e.message}`);
    console.error(backendHint());
    process.exit(1);
  }
  process.exit(0);
}

function cmdRebuild() {
  const { root } = resolveLibraryRoot();
  try {
    if (!existsSync(rootPaths(root).index)) { console.log(`index.json 없음 — 건너뜀 (${root})`); return; }
    rebuildIndex(root);
    console.log(`인덱스 재구성 완료 (${loadIndex(root).entries.length}건) ${path.join(root, 'index.sqlite')}`);
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
}

// ── 셀프테스트(결정적, os.tmpdir 격리) ──────────────────────────────────────
/** 최소 유효 GLB 생성기 — JSON 청크에 meshes/accessors/images 를 넣어 glbStats 를 실측 가능하게 만든다. */
function makeGlb(triangles = 12, textureBytes = 64, salt = 0) {
  const json = {
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ indices: 0 }] }],
    accessors: [{ count: triangles * 3 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: textureBytes }],
    images: [{ mimeType: 'image/png', bufferView: 0 }],
    buffers: [{ byteLength: textureBytes }],
    extras: { salt },
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let bin = Buffer.alloc(textureBytes, salt & 0xff);
  while (bin.length % 4 !== 0) bin = Buffer.concat([bin, Buffer.from([0])]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(jsonBuf.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jc, jsonBuf, bc, bin]);
}

function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'meshy-forge-selftest-'));
  let seq = 0;
  const mkGlbFile = (tri = 12, tex = 64) => {
    const p = path.join(tmp, `m${seq++}.glb`);
    writeFileSync(p, makeGlb(tri, tex, seq));
    return p;
  };
  const subRoot = (n) => path.join(tmp, n);
  try {
    const rA = subRoot('a');
    const fileA = mkGlbFile(1000, 4096);
    const st = storeEntry(rA, {
      id: 'boss_kargon', prompt: 'a hulking volcanic fortress boss with lava cracks',
      file: fileA, tags: ['boss', 'planet-blitz'], style: { style: 'pb-boss', polycount: 8000, textured: true },
      meshy: { taskId: 'task-123', credits: 30 }, createdAt: new Date().toISOString(),
    });
    // (a) 보관 왕복 + GLB 실측
    ok('a) 보관 왕복 + GLB 실측',
      st.entry.geometry.triangles === 1000 && st.entry.geometry.textureBytes === 4096 && existsSync(path.join(rA, 'models', 'boss_kargon.glb')),
      `tri=${st.entry.geometry.triangles} tex=${st.entry.geometry.textureBytes}`);
    // (b) 만료일 자동 계산(생성 +3일)
    const h = hoursLeft(st.entry.meshy.expiresAt);
    ok('b) 만료 시계(+3일)', h > 71 && h <= 72, `${h && h.toFixed(2)}h`);
    // (c) 유사 설명 → 재사용 후보
    const rc = findMatches({ prompt: 'volcanic fortress boss with lava', tags: [] }, rA, {});
    ok('c) 유사설명 재사용후보(≥0.6)', rc.length && rc[0].s >= REUSE_THRESHOLD, `score=${rc[0] && rc[0].s.toFixed(3)}`);
    // (d) 무관 설명 → 신규
    const rd = findMatches({ prompt: 'a small wooden chair', tags: [] }, rA, {});
    ok('d) 무관설명 신규(<0.6)', !rd.length || rd[0].s < REUSE_THRESHOLD, `score=${rd[0] ? rd[0].s.toFixed(3) : 'none'}`);
    // (e) 동일 바이트 재보관 → 중복 감지 + find --file score 1.0
    const dup = storeEntry(rA, { id: 'boss_kargon_copy', prompt: 'unrelated words', file: fileA });
    const re = findMatches({ prompt: 'zzz nothing matches', contentHash: hashFile(fileA) }, rA, {});
    ok('e) 정확중복 감지 + hash score=1.0', dup.duplicateOf === 'boss_kargon' && re.length && re[0].s === 1, `dupOf=${dup.duplicateOf} s=${re[0] && re[0].s}`);
    // (f) FTS 경로 ≡ 선형 경로 등가(후보집합·판정·best)
    const rF = subRoot('f');
    storeEntry(rF, { id: 'ship', prompt: 'a sleek interceptor spaceship with twin engines', file: mkGlbFile(), tags: ['ship'], style: { style: 'pb-ship' } });
    storeEntry(rF, { id: 'turret', prompt: 'a heavy defense turret with rotating barrel', file: mkGlbFile(), tags: ['defense'], style: { style: 'pb-ship' } });
    storeEntry(rF, { id: 'rock', prompt: 'a jagged asteroid rock chunk', file: mkGlbFile(), tags: ['prop'], style: { style: 'pb-env' } });
    const battery = [
      { prompt: 'interceptor spaceship', tags: [] },
      { prompt: 'defense turret barrel', tags: ['defense'] },
      { prompt: 'asteroid', tags: [] },
      { prompt: '', tags: ['ship'] },
      { prompt: 'qwxyz nonexistent', tags: [] },
      { prompt: 'spaceship', tags: [], style: 'pb-ship' },
    ];
    let eqAll = true, eqDetail = `${battery.length} 질의 등가`;
    for (const q of battery) {
      const a = findMatches(q, rF, { top: 999 }).filter((x) => x.s > 0.10).map((x) => `${x.e.id}:${x.s.toFixed(6)}`);
      const b = findMatchesLinear(q, rF, { top: 999 }).filter((x) => x.s > 0.10).map((x) => `${x.e.id}:${x.s.toFixed(6)}`);
      if (JSON.stringify(a) !== JSON.stringify(b)) { eqAll = false; eqDetail = `q="${q.prompt}" fts=${JSON.stringify(a)} lin=${JSON.stringify(b)}`; break; }
    }
    ok('f) FTS≡선형 등가', eqAll, eqDetail);
    // (g) 스타일 프리셋 보정 + --style-strict 배제
    const qg = { prompt: 'a sleek interceptor spaceship with twin engines', tags: [], style: 'pb-ship' };
    const g1 = findMatches(qg, rF, { top: 5 });
    const g2 = findMatches({ ...qg, style: 'pb-env' }, rF, { top: 5, styleStrict: true });
    ok('g) 스타일 보정 + strict 배제',
      g1[0].e.id === 'ship' && g2.every((x) => entryStyle(x.e) === 'pb-env'),
      `best=${g1[0].e.id} strictIds=[${g2.map((x) => x.e.id).join(',')}]`);
    // (h) db 삭제 → 다음 find 자동 rebuild
    closeAll();
    for (const suf of ['', '-wal', '-shm']) { try { rmSync(path.join(rF, 'index.sqlite' + suf), { force: true }); } catch { /* ignore */ } }
    const fr = ensureFresh(rF, { allowRebuild: true });
    const h2 = findMatches({ prompt: 'interceptor spaceship', tags: [] }, rF, {});
    ok('h) db 삭제 후 자동 rebuild', fr.rebuilt === true && h2.length && h2[0].e.id === 'ship', `rebuilt=${fr.rebuilt}`);
    // (i) mtime churn → rebuild 생략 / 내용 변경 → rebuild
    const rI = subRoot('i');
    storeEntry(rI, { id: 'x', prompt: 'a wooden crate prop', file: mkGlbFile() });
    ensureFresh(rI, { allowRebuild: true });
    const i1 = ensureFresh(rI, { allowRebuild: true });
    storeEntry(rI, { id: 'y', prompt: 'a metal barrel prop', file: mkGlbFile() }); // index.json 변경(db 미갱신)
    const i2 = ensureFresh(rI, { allowRebuild: true });
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(rI, 'index.json'), future, future);
    const i3 = ensureFresh(rI, { allowRebuild: true });
    ok('i) staleness(내용변경 rebuild / mtime churn 생략)',
      i1.rebuilt === false && i2.rebuilt === true && i3.rebuilt === false && i3.reason === 'mtime-churn',
      `${i1.rebuilt}/${i2.rebuilt}/${i3.rebuilt}(${i3.reason})`);
    // (j) pending 기록 → store 로 정리
    const rJ = subRoot('j');
    recordPending(rJ, { tool: 'mcp__meshy__meshy_text_to_3d', prompt: 'a crystal spire', credits: 20, taskId: 't-9' });
    const p1 = loadPending(rJ).tasks.length;
    storeEntry(rJ, { id: 'spire', prompt: 'a crystal spire', file: mkGlbFile(), meshy: { taskId: 't-9' } });
    markStored(rJ, { taskId: 't-9' });
    ok('j) pending 기록 → 보관 시 정리', p1 === 1 && loadPending(rJ).tasks.length === 0, `before=${p1} after=${loadPending(rJ).tasks.length}`);
    // (k) 훅 degrade: 백엔드 부재/정상 모두 exit 0
    const guard = path.join(PLUGIN_ROOT, 'scripts', 'reuse-guard.mjs');
    const rK = subRoot('k');
    storeEntry(rK, { id: 'spire', prompt: 'a crystal spire tower', file: mkGlbFile() });
    findMatches({ prompt: 'crystal spire', tags: [] }, rK, {});
    closeAll();
    const payload = JSON.stringify({ tool_name: 'mcp__meshy__meshy_text_to_3d', tool_input: { prompt: 'a crystal spire tower' } });
    const envBase = { ...process.env, MESHY_FORGE_LIBRARY: rK };
    const k1 = spawnSync(process.execPath, [guard], { input: payload, encoding: 'utf8', env: { ...envBase, MESHY_FORGE_FORCE_NO_BACKEND: '1' } });
    const k2 = spawnSync(process.execPath, [guard], { input: payload, encoding: 'utf8', env: envBase });
    ok('k) 훅 degrade 항상 exit 0', k1.status === 0 && k2.status === 0, `noBackend=${k1.status} backend=${k2.status} warn=${/유사 보관/.test(k2.stderr || '')}`);
    // (l) PostToolUse 훅이 pending 을 남긴다
    const record = path.join(PLUGIN_ROOT, 'scripts', 'pending-record.mjs');
    const rL = subRoot('l');
    const lPayload = JSON.stringify({
      tool_name: 'mcp__meshy__meshy_text_to_3d',
      tool_input: { prompt: 'a molten core golem', ai_model: 'meshy-6' },
      tool_response: { content: [{ type: 'text', text: 'task_id: 7f3c1a90-1111-2222-3333-444455556666 status PENDING' }] },
    });
    const l1 = spawnSync(process.execPath, [record], { input: lPayload, encoding: 'utf8', env: { ...process.env, MESHY_FORGE_LIBRARY: rL } });
    const lt = loadPending(rL).tasks;
    ok('l) PostToolUse pending 기록(task id 추출)',
      l1.status === 0 && lt.length === 1 && lt[0].taskId === '7f3c1a90-1111-2222-3333-444455556666' && lt[0].expiresAt,
      `status=${l1.status} n=${lt.length} id=${lt[0] && lt[0].taskId}`);
    // (m) 백엔드 판정 3분류
    const vOk = verifyBackend();
    process.env.MESHY_FORGE_FORCE_NO_BACKEND = '1';
    const vOff = verifyBackend();
    delete process.env.MESHY_FORGE_FORCE_NO_BACKEND;
    ok('m) verifyBackend 로드+FTS5 스모크', vOk.status === BACKEND_OK && vOff.status === BACKEND_MISSING, `ok=${vOk.status} forced=${vOff.status}`);
    // (n) 다운로드 훅이 자동 보관한다 — MCP 서버 이름이 플러그인 스코프(mcp__plugin_…_meshy__)여도 걸려야 한다.
    //     이 접두사 불일치로 훅 3종이 통째로 침묵해 캐릭터 6종이 원장에 안 남은 사고가 있었다(2026-08-19).
    const autoStore = path.join(PLUGIN_ROOT, 'scripts', 'auto-store.mjs');
    const rN = subRoot('n');
    const nGlb = mkGlbFile();
    const nTask = '9c2d5661-b6d1-41ed-7cae-acae11112222';
    recordPending(rN, { tool: 'meshy_image_to_3d', taskId: nTask, prompt: 'a brass diving helmet', credits: 30 });
    const nPayload = JSON.stringify({
      tool_name: 'mcp__plugin_meshy-forge_meshy__meshy_download_model',
      tool_input: { task_id: nTask, task_type: 'image-to-3d' },
      tool_response: { content: [{ type: 'text', text: `{"local_path":"${nGlb.replace(/\\/g, '\\\\')}","file_size_bytes":9}` }] },
    });
    const nEnv = { ...process.env, MESHY_FORGE_LIBRARY: rN };
    const n1 = spawnSync(process.execPath, [autoStore], { input: nPayload, encoding: 'utf8', env: nEnv });
    const nEnt = loadIndex(rN).entries;
    ok('n) 다운로드 훅 자동 보관(플러그인 스코프 이름)',
      n1.status === 0 && nEnt.length === 1 && nEnt[0].prompt === 'a brass diving helmet'
        && nEnt[0].meshy.taskId === nTask && loadPending(rN).tasks.length === 0,
      `status=${n1.status} n=${nEnt.length} pending=${loadPending(rN).tasks.length}`);
    // (o) 같은 task 재다운로드 — 파일명 폴백이 이미 적어 둔 프롬프트·크레딧을 덮으면 안 된다.
    const o1 = spawnSync(process.execPath, [autoStore], { input: nPayload, encoding: 'utf8', env: nEnv });
    const oEnt = loadIndex(rN).entries;
    ok('o) 재다운로드 시 메타 보존',
      o1.status === 0 && oEnt.length === 1 && oEnt[0].prompt === 'a brass diving helmet' && oEnt[0].meshy.credits === 30,
      `n=${oEnt.length} prompt="${oEnt[0] && oEnt[0].prompt}" credits=${oEnt[0] && oEnt[0].meshy.credits}`);
    // (p) 이미지 다운로드·무관 도구는 조용히 지나간다(원장 오염 금지).
    const rP = subRoot('p');
    const pEnv = { ...process.env, MESHY_FORGE_LIBRARY: rP };
    const imgRun = spawnSync(process.execPath, [autoStore], {
      input: JSON.stringify({
        tool_name: 'mcp__plugin_meshy-forge_meshy__meshy_download_model',
        tool_response: { content: [{ type: 'text', text: '{"local_path":"/tmp/preview.png"}' }] },
      }), encoding: 'utf8', env: pEnv,
    });
    const otherRun = spawnSync(process.execPath, [autoStore], {
      input: JSON.stringify({ tool_name: 'mcp__plugin_meshy-forge_meshy__meshy_check_balance', tool_response: 'ok' }),
      encoding: 'utf8', env: pEnv,
    });
    ok('p) 이미지·무관 도구는 보관 안 함',
      imgRun.status === 0 && otherRun.status === 0 && loadIndex(rP).entries.length === 0,
      `status=${imgRun.status}/${otherRun.status} n=${loadIndex(rP).entries.length}`);
  } finally {
    try { closeAll(); } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`); if (r.pass) passed++; }
  console.log('─'.repeat(64));
  console.log(`${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

// store 가 async(썸네일 다운로드)라 main 도 async 다 — 그래야 비동기 실패도 같은 안내로 수렴한다.
async function main() {
  try { return await route(); } catch (e) {
    if (e instanceof BackendUnavailableError) {
      console.error(e.message);
      console.error(backendHint());
      process.exit(1);
    }
    throw e;
  }
}

function route() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === 'test' || cmd === '--selftest') return selftest();
  switch (cmd) {
    case 'init': return cmdInit();
    case 'config': return cmdConfig();
    case 'find': return cmdFind(args);
    case 'list': return cmdList(args);
    case 'get': return cmdGet(args);
    case 'store': return cmdStore(args);
    case 'pending': return cmdPending(args);
    case 'export': return cmdExport(args);
    case 'prune': return cmdPrune();
    case 'setup': return cmdSetup();
    case 'rebuild': case 'reindex': return cmdRebuild();
    default:
      console.log('Meshy Forge — 3일 만료 방어 + 로컬 모델 보관·검색');
      console.log('명령: init | config | find | list | get | store | pending | export | prune | setup | rebuild | test');
      console.log('  find "a volcanic fortress boss" --style pb-boss --top 5');
      console.log('  store --id boss_kargon --prompt "..." --file out.glb --task-id <id> --credits 30 --style pb-boss --tags boss');
      console.log('  pending            (미보관 task 와 남은 시간)');
      console.log('  export --id boss_kargon --to D:/game/assets/models');
      console.log(`  서버 보관 ${RETENTION_DAYS}일 — 놓치면 크레딧이 증발한다.`);
  }
}

// 정션/심링크 경유 실행 지원: ESM 의 import.meta.url 은 실경로라 argv[1] 도 실경로로 비교해야 한다.
const isMain = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main();
