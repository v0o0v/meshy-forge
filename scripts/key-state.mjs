#!/usr/bin/env node
/**
 * scripts/key-state.mjs — 복수 API 키 상태(현재 키 + task→키 매핑)
 *
 * 왜 필요한가:
 *   Meshy 의 task 는 **계정에 귀속**된다. a 키로 만든 task 를 b 키로 조회하면 NotFound 다.
 *   retexture/remesh 의 실용 경로가 `input_task_id` 뿐이고(`model_url` 은 3일 뒤 만료),
 *   다운로드도 task 기반이라 "이 task 는 어느 키 소유인가"를 잃어버리면 크레딧이 그대로 증발한다.
 *   그래서 매핑을 파일로 남긴다.
 *
 * 왜 라이브러리 안에 두는가:
 *   library/ 는 이미 gitignore 이고 이 PC 유일본이라 디스크 백업 대상이다.
 *   모델과 같은 운명을 공유해야 복구가 의미를 갖는다(모델만 살고 소유 키를 잃으면 재가공 불가).
 *
 * 왜 meshy-cache.mjs 의 resolveLibraryRoot 를 import 하지 않는가:
 *   meshy-cache 는 meshy-index(better-sqlite3 네이티브 바인딩)를 top-level 로 끌고 온다.
 *   이 모듈은 MCP 프록시의 **부팅 경로**에서 로드되므로, 로드 실패가 곧 meshy 전체 사망이다.
 *   짧은 중복을 감수하고 무의존으로 유지한다. resolveLibraryRoot 를 고치면 여기도 같이 고쳐라.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_VERSION = 1;
/** 매핑이 무한정 자라지 않도록 유지하는 최근 task 수. 서버 보관이 3일이라 이 정도면 충분히 넉넉하다. */
const MAX_TASKS = 2000;

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** meshy-cache.mjs 의 resolveLibraryRoot 와 같은 규칙(중복 주의 — 위 주석 참고). */
export function resolveLibraryRoot(env = process.env) {
  if (env.MESHY_FORGE_LIBRARY) return env.MESHY_FORGE_LIBRARY;
  const userCfg = readJsonSafe(path.join(os.homedir(), '.claude', 'meshy-forge.json'));
  if (userCfg && userCfg.library) return userCfg.library;
  const markets = readJsonSafe(path.join(env.MESHY_PLUGINS_DIR || path.join(os.homedir(), '.claude', 'plugins'), 'known_marketplaces.json'));
  const mk = markets && (markets['meshy-forge'] || (markets.marketplaces && markets.marketplaces['meshy-forge']));
  const src = mk && (mk.installLocation || (mk.source && mk.source.path));
  if (src && existsSync(src)) return path.join(src, 'library');
  return path.join(PLUGIN_ROOT, 'library');
}

export function stateFile(root = resolveLibraryRoot()) {
  return path.join(root, 'key-state.json');
}

export function emptyState() {
  return { _doc: 'Meshy 복수 API 키 상태 — 현재 활성 키와 task→키 매핑', version: STATE_VERSION, activeIndex: 0, tasks: {} };
}

export function loadState(root = resolveLibraryRoot()) {
  const s = readJsonSafe(stateFile(root));
  if (!s || typeof s !== 'object') return emptyState();
  if (typeof s.activeIndex !== 'number' || s.activeIndex < 0) s.activeIndex = 0;
  if (!s.tasks || typeof s.tasks !== 'object') s.tasks = {};
  s.version = STATE_VERSION;
  return s;
}

/** 원자적 저장 — 프록시가 죽는 순간 반쯤 쓰인 JSON 을 남기면 다음 세션이 매핑을 통째로 잃는다. */
export function saveState(state, root = resolveLibraryRoot()) {
  const dest = stateFile(root);
  mkdirSync(path.dirname(dest), { recursive: true });
  const keys = Object.keys(state.tasks || {});
  if (keys.length > MAX_TASKS) {
    // 삽입 순서가 곧 시간 순서다(JSON 객체 키 순서 보존). 오래된 쪽부터 버린다.
    for (const k of keys.slice(0, keys.length - MAX_TASKS)) delete state.tasks[k];
  }
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, dest);
  return dest;
}

/** task 가 어느 키 소유인지 기록한다. 이미 있으면 덮지 않는다 — 소유는 바뀌지 않는다. */
export function rememberTask(state, taskId, keyLabel) {
  if (!taskId || !keyLabel) return false;
  if (state.tasks[taskId] === keyLabel) return false;
  if (state.tasks[taskId]) return false;
  state.tasks[taskId] = keyLabel;
  return true;
}

export function lookupTask(state, taskId) {
  return (taskId && state.tasks[taskId]) || undefined;
}

/** 키 목록 파싱 — MESHY_API_KEYS(콤마) 우선, 없으면 단일 MESHY_API_KEY(하위호환). */
export function parseKeys(env = process.env) {
  const raw = env.MESHY_API_KEYS || env.MESHY_API_KEY || '';
  const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (seen.has(k)) continue; // 같은 키를 두 번 적으면 폴백이 무의미하다.
    seen.add(k);
    out.push({ label: `key${out.length + 1}`, key: k });
  }
  return out;
}
