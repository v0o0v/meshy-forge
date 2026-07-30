#!/usr/bin/env node
/**
 * scripts/meshy-index.mjs — 보관 모델 검색용 SQLite FTS5 파생 인덱스 백엔드
 *
 * pixellab-forge 의 pixellab-index.mjs 를 이식했다(구조·판정 의미 동일, 스코프 계층만 단일화).
 *
 * 역할:
 *   - `index.json`(원장·진실의 원천)으로부터 결정론적으로 재구성 가능한 파생 인덱스(`<root>/index.sqlite`).
 *   - FTS5 = 온디스크 토큰 역색인(후보 추림 전용). bm25 랭킹은 미사용.
 *   - 후보 추림 = 질의 토큰(prompt `tokenize` ∪ 태그 `tokenizeTag`)과 1개 이상 겹치는 매칭 id 전량
 *     + `content_hash` 정확일치. 최종 랭킹·판정은 `meshy-cache.mjs` 의 `score()` 가 소유한다.
 *   - 매칭 수가 K_MAX 를 초과할 때만 절단하고 stderr 경고 1줄.
 *
 * better-sqlite3 미설치/바인딩 실패 시 `BackendUnavailableError`. 이 모듈은 절대 자동 npm install 하지
 * 않는다(자동 설치는 CLI `setup` 서브커맨드에서만).
 */
import { readFileSync, existsSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
// 순환 import: meshy-cache.mjs 도 이 모듈을 import 한다. 아래 심볼은 모두 함수 선언(hoisted)이며
// 런타임(함수 본문)에서만 호출하므로 ESM 순환 의존에서 안전하다.
import { tokenize, tokenizeTag, loadIndex } from './meshy-cache.mjs';

// 토큰화·인덱싱 로직이 바뀌면 BUILDER_VERSION 을 올려 전량 rebuild 를 강제한다.
const SCHEMA_VERSION = 1;
const BUILDER_VERSION = 1;

export class BackendUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'BackendUnavailableError'; }
}

/**
 * 백엔드 상태 3분류. 미설치와 "설치는 됐는데 못 쓰는 상태"는 처방이 다르다.
 * - `missing`: 패키지 자체가 없다 → `npm install`.
 * - `broken` : 패키지는 있는데 네이티브 바인딩이 없거나 Node ABI 가 안 맞아 로드가 실패한다.
 *              이때 `npm install` 은 아무것도 하지 않는다 → `npm rebuild better-sqlite3` 가 유일한 처방.
 */
export const BACKEND_OK = 'ok';
export const BACKEND_MISSING = 'missing';
export const BACKEND_BROKEN = 'broken';

let _Database = null;

/** 백엔드를 실제로 로드하고 FTS5 까지 굴려 상태를 판정한다(`{ status, detail }`). */
export function verifyBackend() {
  if (process.env.MESHY_FORGE_FORCE_NO_BACKEND === '1') {
    return { status: BACKEND_MISSING, detail: 'MESHY_FORGE_FORCE_NO_BACKEND=1 (강제 비활성)' };
  }
  const require = createRequire(import.meta.url);
  try {
    require.resolve('better-sqlite3');
  } catch (e) {
    return { status: BACKEND_MISSING, detail: e.message };
  }
  try {
    const Database = require('better-sqlite3');
    // 인메모리 스모크: 생성자 + FTS5 가상테이블까지 확인한다(FTS5 미포함 빌드도 걸러낸다).
    const db = new Database(':memory:');
    try { db.exec('CREATE VIRTUAL TABLE __smoke USING fts5(x)'); } finally { db.close(); }
    _Database = Database;
    return { status: BACKEND_OK, detail: `better-sqlite3 ${require('better-sqlite3/package.json').version}` };
  } catch (e) {
    return { status: BACKEND_BROKEN, detail: e.message };
  }
}

function loadDatabaseCtor() {
  // 테스트 seam: 백엔드 부재를 결정적으로 모의.
  if (process.env.MESHY_FORGE_FORCE_NO_BACKEND === '1') {
    throw new BackendUnavailableError('better-sqlite3 강제 비활성(MESHY_FORGE_FORCE_NO_BACKEND=1)');
  }
  if (_Database) return _Database;
  try {
    const require = createRequire(import.meta.url);
    _Database = require('better-sqlite3');
    return _Database;
  } catch (e) {
    const v = verifyBackend();
    const fix = v.status === BACKEND_BROKEN
      ? 'better-sqlite3 는 설치돼 있으나 네이티브 바인딩 로드 실패(Node ABI 불일치 또는 prebuild 부재) — `npm rebuild better-sqlite3` 또는 CLI `setup` 실행 필요'
      : 'better-sqlite3 미설치 — CLI `setup` 실행 필요';
    throw new BackendUnavailableError(`${fix}: ${e.message}`);
  }
}

// ── 연결 캐시(경로별 1회 open) ───────────────────────────────────────────────
const _conns = new Map(); // resolved(root) -> { db }
function dbPath(root) { return path.join(root, 'index.sqlite'); }

export function openDb(root) {
  const key = path.resolve(root);
  const cached = _conns.get(key);
  if (cached) return cached;
  const Database = loadDatabaseCtor(); // 부재 시 BackendUnavailableError
  mkdirSync(root, { recursive: true });
  // better-sqlite3 는 네이티브 바인딩을 생성자에서 로드한다 — require() 성공은 사용 가능의 증거가 아니다.
  let db;
  try {
    db = new Database(dbPath(root));
  } catch (e) {
    const v = verifyBackend();
    if (v.status !== BACKEND_OK) {
      throw new BackendUnavailableError(
        v.status === BACKEND_BROKEN
          ? `better-sqlite3 네이티브 바인딩 로드 실패 — \`npm rebuild better-sqlite3\` 또는 CLI \`setup\` 실행 필요: ${v.detail}`
          : `better-sqlite3 미설치 — CLI \`setup\` 실행 필요: ${v.detail}`,
      );
    }
    throw e; // 백엔드는 멀쩡한데 이 DB 파일만 문제(권한·손상 등)
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS assets(
      id TEXT PRIMARY KEY,
      ord INTEGER,
      prompt TEXT,
      tags_json TEXT,
      style_json TEXT,
      content_hash TEXT,
      entry_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
      id UNINDEXED, prompt_tokens, tag_tokens, tokenize='unicode61'
    );
  `);
  const ent = { db };
  _conns.set(key, ent);
  return ent;
}

export function closeAll() {
  for (const ent of _conns.values()) { try { ent.db.close(); } catch { /* ignore */ } }
  _conns.clear();
}

// ── meta 입출력 ──────────────────────────────────────────────────────────────
function getMeta(db) {
  const rows = db.prepare('SELECT key, value FROM meta').all();
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}
function writeMeta(db, obj) {
  const stmt = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of Object.keys(obj)) stmt.run(k, String(obj[k]));
}

function sha256File(file) { return crypto.createHash('sha256').update(readFileSync(file)).digest('hex'); }

function sourceSig(root) {
  const idxPath = path.join(root, 'index.json');
  if (!existsSync(idxPath)) return { size: -1, mtime: -1, exists: false, idxPath };
  const st = statSync(idxPath);
  return { size: st.size, mtime: st.mtimeMs, exists: true, idxPath };
}

function tagTokensOf(tags) {
  const out = [];
  for (const t of (tags || [])) for (const tok of tokenizeTag(t)) out.push(tok);
  return out;
}

// prompt 인덱싱 대상 텍스트: 형상 프롬프트 + 텍스처 프롬프트(둘 다 "무엇을 만들었나"의 일부).
function promptTextOf(e) {
  return [e.prompt || '', e.texturePrompt || ''].filter(Boolean).join(' ');
}

// ── 신선도 검사 ──────────────────────────────────────────────────────────────
export function ensureFresh(root, opts = {}) {
  const allowRebuild = opts.allowRebuild ?? true;
  const { db } = openDb(root); // 백엔드 부재 시 BackendUnavailableError
  const meta = getMeta(db);
  const sig = sourceSig(root);
  const schemaOk = meta.schema_version === String(SCHEMA_VERSION)
    && meta.builder_version === String(BUILDER_VERSION);
  // fast-path: size+mtime 일치 → 신선(원본 미독).
  if (schemaOk
    && meta.index_json_size === String(sig.size)
    && meta.index_json_mtime === String(sig.mtime)) {
    return { fresh: true, rebuilt: false, reason: 'sig-match' };
  }
  // size/mtime 불일치 → sha256 권위 판정(git mtime churn 이면 rebuild 생략).
  if (sig.exists && schemaOk) {
    const sha = sha256File(sig.idxPath);
    if (meta.index_json_sha256 === sha) {
      writeMeta(db, { index_json_size: sig.size, index_json_mtime: sig.mtime });
      return { fresh: true, rebuilt: false, reason: 'mtime-churn' };
    }
  }
  if (!allowRebuild) return { fresh: false, rebuilt: false, reason: 'stale-no-rebuild' };
  rebuild(root);
  return { fresh: true, rebuilt: true, reason: 'rebuilt' };
}

// ── 전량 재구성(단일 트랜잭션) ───────────────────────────────────────────────
export function rebuild(root) {
  const { db } = openDb(root);
  const idx = loadIndex(root);
  const entries = Array.isArray(idx.entries) ? idx.entries : [];
  const sig = sourceSig(root);
  const insA = db.prepare('INSERT OR REPLACE INTO assets(id,ord,prompt,tags_json,style_json,content_hash,entry_json) VALUES(?,?,?,?,?,?,?)');
  const insF = db.prepare('INSERT INTO assets_fts(id,prompt_tokens,tag_tokens) VALUES(?,?,?)');
  const tx = db.transaction(() => {
    db.exec('DELETE FROM assets; DELETE FROM assets_fts;');
    let ord = 0;
    for (const e of entries) {
      insA.run(
        e.id, ord, e.prompt || '', JSON.stringify(e.tags || []),
        JSON.stringify(e.style || {}), e.contentHash || null, JSON.stringify(e),
      );
      insF.run(e.id, tokenize(promptTextOf(e)).join(' '), tagTokensOf(e.tags).join(' '));
      ord++;
    }
    writeMeta(db, {
      index_json_size: sig.size,
      index_json_mtime: sig.mtime,
      index_json_sha256: sig.exists ? sha256File(sig.idxPath) : '',
      entry_count: entries.length,
      schema_version: SCHEMA_VERSION,
      builder_version: BUILDER_VERSION,
    });
  });
  tx();
}

// ── 증분 upsert(O(1)) + meta 시그니처 재동기화 ───────────────────────────────
export function upsertOne(root, entry) {
  const { db } = openDb(root);
  const meta = getMeta(db);
  const schemaOk = meta.schema_version === String(SCHEMA_VERSION)
    && meta.builder_version === String(BUILDER_VERSION);
  if (!schemaOk || meta.entry_count === undefined) { rebuild(root); return; }
  const insA = db.prepare('INSERT OR REPLACE INTO assets(id,ord,prompt,tags_json,style_json,content_hash,entry_json) VALUES(?,?,?,?,?,?,?)');
  const delF = db.prepare('DELETE FROM assets_fts WHERE id = ?');
  const insF = db.prepare('INSERT INTO assets_fts(id,prompt_tokens,tag_tokens) VALUES(?,?,?)');
  const getOrd = db.prepare('SELECT ord FROM assets WHERE id = ?');
  const maxOrd = db.prepare('SELECT MAX(ord) AS m FROM assets');
  const cntStmt = db.prepare('SELECT COUNT(*) AS c FROM assets');
  const sig = sourceSig(root);
  const tx = db.transaction(() => {
    const existing = getOrd.get(entry.id);
    const ord = existing ? existing.ord : (((maxOrd.get() || {}).m ?? -1) + 1);
    insA.run(
      entry.id, ord, entry.prompt || '', JSON.stringify(entry.tags || []),
      JSON.stringify(entry.style || {}), entry.contentHash || null, JSON.stringify(entry),
    );
    delF.run(entry.id);
    insF.run(entry.id, tokenize(promptTextOf(entry)).join(' '), tagTokensOf(entry.tags).join(' '));
    writeMeta(db, {
      index_json_size: sig.size,
      index_json_mtime: sig.mtime,
      index_json_sha256: sig.exists ? sha256File(sig.idxPath) : '',
      entry_count: cntStmt.get().c,
      schema_version: SCHEMA_VERSION,
      builder_version: BUILDER_VERSION,
    });
  });
  tx();
}

// ── prune 증분 삭제 ──────────────────────────────────────────────────────────
export function removeIds(root, ids) {
  if (!ids || !ids.length) return;
  const { db } = openDb(root);
  const delA = db.prepare('DELETE FROM assets WHERE id = ?');
  const delF = db.prepare('DELETE FROM assets_fts WHERE id = ?');
  const cntStmt = db.prepare('SELECT COUNT(*) AS c FROM assets');
  const sig = sourceSig(root);
  const tx = db.transaction(() => {
    for (const id of ids) { delA.run(id); delF.run(id); }
    writeMeta(db, {
      index_json_size: sig.size,
      index_json_mtime: sig.mtime,
      index_json_sha256: sig.exists ? sha256File(sig.idxPath) : '',
      entry_count: cntStmt.get().c,
      schema_version: SCHEMA_VERSION,
      builder_version: BUILDER_VERSION,
    });
  });
  tx();
}

// ── 후보 추림(매칭-집합) ─────────────────────────────────────────────────────
function queryTerms(query) {
  const set = new Set();
  for (const t of tokenize(query.prompt || '')) set.add(t);
  for (const tag of (query.tags || [])) for (const tok of tokenizeTag(tag)) set.add(tok);
  return [...set];
}

/**
 * getCandidates(root, query, kMax) → entry[]
 *   - 질의 토큰과 1개 이상 겹치는 매칭 id 전량 + content_hash 정확일치.
 *   - 반환 순서: assets.ord(= index.json 배열 순서) 오름차순 — 안정 정렬 tie-order 등가 보장.
 */
export function getCandidates(root, query, kMax) {
  const cap = Number(kMax) > 0 ? Number(kMax) : 5000;
  const { db } = openDb(root);
  const ids = new Set();
  const terms = queryTerms(query);
  if (terms.length) {
    // term 은 [a-z0-9]+ 로 정규화돼 있어 인용만으로 FTS 구문 주입이 불가능하다.
    const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
    const rows = db.prepare('SELECT id FROM assets_fts WHERE assets_fts MATCH ? LIMIT ?').all(matchExpr, cap + 1);
    if (rows.length > cap) {
      process.stderr.write(`⚠️ [meshy-forge] 매칭이 K_MAX(${cap}) 초과 — 근사 후보로 절단(정확 등가 아님). MESHY_CANDIDATE_K 상향 권장.\n`);
      rows.length = cap;
    }
    for (const r of rows) ids.add(r.id);
  }
  if (query.contentHash) {
    const hrows = db.prepare('SELECT id FROM assets WHERE content_hash = ?').all(query.contentHash);
    for (const r of hrows) ids.add(r.id);
  }
  if (ids.size === 0) return [];
  const idList = [...ids];
  const rows = [];
  const CH = 900;
  for (let i = 0; i < idList.length; i += CH) {
    const chunk = idList.slice(i, i + CH);
    const ph = chunk.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT ord, entry_json FROM assets WHERE id IN (${ph})`).all(...chunk)) rows.push(r);
  }
  rows.sort((a, b) => a.ord - b.ord);
  return rows.map((r) => JSON.parse(r.entry_json));
}

/** allIds(root) → id[] — 전체 id 집합(경량 조회). 호출 전제: ensureFresh 완료. */
export function allIds(root) {
  const { db } = openDb(root);
  return db.prepare('SELECT id FROM assets').all().map((r) => r.id);
}
