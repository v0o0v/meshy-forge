#!/usr/bin/env node
/**
 * scripts/meshy-proxy.mjs — 복수 Meshy API 키를 하나의 MCP 서버처럼 보이게 하는 stdio 프록시
 *
 * 문제:
 *   업스트림 `@meshy-ai/meshy-mcp-server` 는 프로세스 하나당 키 하나(MESHY_API_KEY)다.
 *   키가 여러 개면 서버를 여러 개 등록해야 하는데, 그러면 ①툴이 배로 늘어 컨텍스트를 먹고
 *   ②툴 이름이 `mcp__meshy-a__…` 로 바뀌어 hooks.json 의 `mcp__.*meshy__.*` matcher 가 죽는다
 *   (2026-08-19 에 정확히 이 matcher 불일치로 모델 6종·180크레딧이 원장에서 유실됐다).
 *
 * 해법:
 *   이 프록시가 유일한 MCP 서버로 등록되고(서버 이름 `meshy` 유지 → 툴 이름·훅 그대로),
 *   내부에서 키마다 업스트림 자식 프로세스를 하나씩 상시 띄워 JSON-RPC 를 중계한다.
 *
 * 라우팅 규칙:
 *   - meshy_check_balance          → 모든 키에 물어 합산·병기
 *   - input_task_id / task_id 있음 → 그 task 를 **만든 키**로 라우팅(task 는 계정 귀속이다)
 *   - 그 외(생성 계열)             → 활성 키. 잔액 부족이면 다음 키로 같은 요청 재시도 후 활성 키 전환
 *
 * 잔액 부족 감지(업스트림 0.4.0 소스 확인 결과):
 *   JSON-RPC `error` 로 오지 않는다. 성공 응답 안에 `isError: true` 와
 *   오류 텍스트로 온다(dist/services/error-handler.js).
 *   그래서 error 필드가 아니라 **result 본문**을 본다. 접두 정확 매칭이라
 *   check_balance 응답의 "credit" 같은 단어에는 걸리지 않는다.
 *
 *   **문구는 버전마다 다르다.** 실측 두 가지를 다 받는다:
 *     0.4.0  "Error: Insufficient credits. Use `meshy_check_balance` ..."
 *     이후   "Error: API request failed with status 402. Insufficient funds"
 *   2026-08-26 에 뒤엣것을 못 알아봐 전환이 안 됐고, 사용자에게는 그냥 402 에러로
 *   보였다(캐릭터 3D 9건이 여기서 멈춰 REST 우회로 돌았다). 새 문구가 또 나오면
 *   여기 정규식과 test/mock-upstream.mjs 의 MOCK_INSUFFICIENT_STYLE 에 같이 추가한다.
 *
 * 환경변수:
 *   MESHY_API_KEYS       "msy_a,msy_b" (콤마 구분). 없으면 MESHY_API_KEY 단일 키(하위호환).
 *   MESHY_MCP_COMMAND    업스트림 실행 명령 오버라이드(모의 검증용).
 *   MESHY_MCP_ARGS       업스트림 인자 오버라이드(공백 구분, 모의 검증용).
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
  parseKeys, loadState, saveState, rememberTask, lookupTask, resolveLibraryRoot,
} from './key-state.mjs';

const LIB_ROOT = resolveLibraryRoot();
const state = loadState(LIB_ROOT);
const KEYS = parseKeys();

function log(msg) {
  try { process.stderr.write(`[meshy-forge/proxy] ${msg}\n`); } catch { /* noop */ }
}

if (KEYS.length === 0) {
  log('MESHY_API_KEYS 도 MESHY_API_KEY 도 비어 있습니다. .mcp.json 의 env 를 확인하세요.');
  process.exit(1);
}
if (state.activeIndex >= KEYS.length) state.activeIndex = 0; // 키를 줄이면 인덱스가 범위를 벗어난다.

// ── 업스트림 자식 프로세스 ────────────────────────────────────────────────

const isWin = process.platform === 'win32';
const UP_COMMAND = process.env.MESHY_MCP_COMMAND || (isWin ? 'cmd' : 'npx');
const UP_ARGS = process.env.MESHY_MCP_ARGS
  ? process.env.MESHY_MCP_ARGS.split(' ').filter(Boolean)
  : (isWin ? ['/c', 'npx', '-y', '@meshy-ai/meshy-mcp-server'] : ['-y', '@meshy-ai/meshy-mcp-server']);

const MAX_RESPAWN = 3;

function makeChild(label, key) {
  const child = { label, key, proc: null, pending: new Map(), seq: 0, buf: '', respawns: 0, initMsg: null };
  spawnUpstream(child);
  return child;
}

function spawnUpstream(child) {
  const env = { ...process.env, MESHY_API_KEY: child.key };
  delete env.MESHY_API_KEYS; // 자식이 이 값을 보고 혼동하지 않게.
  const proc = spawn(UP_COMMAND, UP_ARGS, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  child.proc = proc;
  child.buf = '';
  proc.stdout.on('data', (chunk) => onChildData(child, chunk));
  proc.on('error', (e) => log(`${child.label} 업스트림 실행 실패: ${e && e.message}`));
  proc.on('exit', (code) => onChildExit(child, code));
}

function onChildExit(child, code) {
  // 대기 중이던 요청은 응답이 영영 안 온다 — 붙잡고 있으면 클라이언트가 무한정 멈춘다.
  for (const [, entry] of child.pending) {
    entry.reject(new Error(`${child.label} 업스트림이 종료됨(code ${code})`));
  }
  child.pending.clear();
  if (shuttingDown) return;
  if (child.respawns >= MAX_RESPAWN) {
    log(`${child.label} 업스트림이 반복 종료되어 재기동을 포기합니다(code ${code}).`);
    return;
  }
  child.respawns += 1;
  log(`${child.label} 업스트림 종료(code ${code}) — 재기동 ${child.respawns}/${MAX_RESPAWN}`);
  spawnUpstream(child);
  // 재기동한 자식은 초기화되지 않은 상태다. 최초 initialize 를 그대로 다시 태운다.
  if (child.initMsg) sendToChild(child, { ...child.initMsg, id: `${child.label}#reinit` }).catch(() => {});
}

function onChildData(child, chunk) {
  child.buf += chunk.toString('utf8');
  let nl;
  while ((nl = child.buf.indexOf('\n')) >= 0) {
    const line = child.buf.slice(0, nl).trim();
    child.buf = child.buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log(`${child.label} 파싱 불가 라인 무시: ${line.slice(0, 200)}`); continue; }
    const entry = msg && msg.id !== undefined && msg.id !== null ? child.pending.get(msg.id) : undefined;
    if (entry) {
      child.pending.delete(msg.id);
      entry.resolve(msg);
      continue;
    }
    if (msg && msg.method && (msg.id === undefined || msg.id === null)) {
      // 자식이 보낸 알림 — 활성 자식 것만 올려보낸다(둘 다 올리면 클라이언트가 중복으로 본다).
      if (child === children[state.activeIndex]) writeClient(msg);
      continue;
    }
    log(`${child.label} 처리하지 않는 메시지 무시: ${line.slice(0, 200)}`);
  }
}

/** 자식에 요청을 보내고 응답을 기다린다. id 는 자식별 고유 id 로 갈아끼운다. */
function sendToChild(child, msg) {
  return new Promise((resolve, reject) => {
    if (!child.proc || !child.proc.stdin.writable) { reject(new Error(`${child.label} 업스트림이 없습니다`)); return; }
    const childId = `${child.label}#${++child.seq}`;
    child.pending.set(childId, { resolve, reject });
    try {
      child.proc.stdin.write(JSON.stringify({ ...msg, id: childId }) + '\n');
    } catch (e) {
      child.pending.delete(childId);
      reject(e);
    }
  });
}

/** 응답이 필요 없는 알림을 자식에 흘려보낸다. */
function notifyChild(child, msg) {
  try {
    if (child.proc && child.proc.stdin.writable) child.proc.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) { log(`${child.label} 알림 전달 실패: ${e && e.message}`); }
}

const children = KEYS.map((k) => makeChild(k.label, k.key));

function childByLabel(label) {
  return children.find((c) => c.label === label);
}

// ── 잔액 부족 감지 · 응답 가공 ────────────────────────────────────────────

/**
 * 잔액 부족 문구는 업스트림 버전마다 다르다. 실측 두 가지를 다 받는다:
 *   0.4.0  "Error: Insufficient credits. Use `meshy_check_balance` ..."
 *   이후   "Error: API request failed with status 402. Insufficient funds"
 * 접두 `Error:` 를 요구해 check_balance 본문의 "credit" 같은 단어에는 안 걸린다.
 */
const INSUFFICIENT_RE = /^Error:\s*(?:Insufficient (?:credits|funds)|API request failed with status 402)/m;
/** JSON-RPC error 경로는 SDK 문구가 접두를 덮으므로 문면만 본다. */
const INSUFFICIENT_LOOSE_RE = /Insufficient (?:credits|funds)|status 402/i;

function resultText(res) {
  const content = res && res.result && Array.isArray(res.result.content) ? res.result.content : [];
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

function isInsufficient(res) {
  if (!res) return false;
  if (res.error && typeof res.error.message === 'string') return INSUFFICIENT_LOOSE_RE.test(res.error.message);
  if (!res.result || res.result.isError !== true) return false;
  return INSUFFICIENT_RE.test(resultText(res));
}

/** 툴 응답 맨 앞에 안내 한 줄을 끼워 넣는다 — 전환이 조용히 일어나면 사용자가 소진을 모른 채 지나간다. */
function annotate(res, note) {
  if (!res || !res.result) return res;
  const content = Array.isArray(res.result.content) ? res.result.content.slice() : [];
  const first = content[0];
  if (first && typeof first.text === 'string') content[0] = { ...first, text: `${note}\n\n${first.text}` };
  else content.unshift({ type: 'text', text: note });
  return { ...res, result: { ...res.result, content } };
}

// ── task → 키 소유 조회 ───────────────────────────────────────────────────

let indexCache = { mtimeMs: -1, map: new Map() };

/**
 * key-state.json 에 없는 task 는 원장에서 찾는다.
 * 자동 보관이 keyLabel 을 원장에 적어 두므로, 상태 파일이 날아가도 보관된 모델은 재가공 경로가 산다.
 */
function indexOwners() {
  const file = path.join(LIB_ROOT, 'index.json');
  if (!existsSync(file)) return indexCache.map;
  let mtimeMs;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return indexCache.map; }
  if (mtimeMs === indexCache.mtimeMs) return indexCache.map;
  const map = new Map();
  try {
    const idx = JSON.parse(readFileSync(file, 'utf8'));
    for (const e of idx.entries || []) {
      const m = e && e.meshy;
      if (!m || !m.keyLabel) continue;
      for (const t of [m.taskId, m.previewTaskId, m.sourceTaskId]) if (t) map.set(t, m.keyLabel);
    }
  } catch { /* 원장이 깨져도 프록시는 계속 돈다 */ }
  indexCache = { mtimeMs, map };
  return map;
}

function ownerOf(taskId) {
  return lookupTask(state, taskId) || indexOwners().get(taskId);
}

function extractTaskIds(res) {
  const ids = new Set();
  const sc = res && res.result && res.result.structuredContent;
  if (sc && typeof sc.task_id === 'string') ids.add(sc.task_id);
  const text = resultText(res);
  for (const m of text.matchAll(/\*\*Task ID\*\*:\s*([0-9a-zA-Z_-]+)/g)) ids.add(m[1]);
  return [...ids];
}

function recordTasks(child, res) {
  let dirty = false;
  for (const id of extractTaskIds(res)) if (rememberTask(state, id, child.label)) dirty = true;
  if (dirty) persist();
}

function persist() {
  try { saveState(state, LIB_ROOT); } catch (e) { log(`상태 저장 실패: ${e && e.message}`); }
}

// ── 클라이언트 요청 처리 ──────────────────────────────────────────────────

function writeClient(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { log(`클라이언트 쓰기 실패: ${e && e.message}`); }
}

function errorResponse(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32603, message } };
}

function restoreId(res, id) {
  return { ...res, id };
}

async function handleInitialize(msg) {
  // 모든 자식을 초기화해 둔다 — 폴백 순간에야 초기화하면 그 호출이 느려지거나 실패한다.
  const results = await Promise.allSettled(children.map((c) => {
    c.initMsg = msg;
    return sendToChild(c, msg);
  }));
  const ok = results.find((r) => r.status === 'fulfilled' && r.value && r.value.result);
  if (!ok) {
    const why = results.map((r, i) => `${children[i].label}: ${r.status === 'rejected' ? (r.reason && r.reason.message) : '응답 없음'}`).join(' / ');
    return errorResponse(msg.id, `업스트림 초기화 실패 — ${why}`);
  }
  for (const [i, r] of results.entries()) {
    if (r.status !== 'fulfilled' || !r.value || !r.value.result) log(`${children[i].label} 초기화 실패 — 이 키로는 폴백이 안 됩니다.`);
  }
  return restoreId(ok.value, msg.id);
}

async function handleCheckBalance(msg) {
  const results = await Promise.allSettled(children.map((c) => sendToChild(c, msg)));
  const lines = [];
  let total = 0;
  let anyOk = false;
  for (const [i, r] of results.entries()) {
    const label = children[i].label;
    const active = i === state.activeIndex ? '  ← 현재 활성' : '';
    if (r.status !== 'fulfilled' || !r.value || !r.value.result) {
      lines.push(`- ${label}: 조회 실패 (${r.status === 'rejected' ? (r.reason && r.reason.message) : '응답 없음'})${active}`);
      continue;
    }
    const res = r.value;
    const sc = res.result.structuredContent;
    let balance = sc && typeof sc.balance === 'number' ? sc.balance : undefined;
    if (balance === undefined) {
      const m = /(-?\d[\d,]*)/.exec(resultText(res));
      if (m) balance = Number(m[1].replace(/,/g, ''));
    }
    if (res.result.isError === true || balance === undefined) {
      lines.push(`- ${label}: 조회 실패 — ${resultText(res).split('\n')[0] || '알 수 없음'}${active}`);
      continue;
    }
    anyOk = true;
    total += balance;
    lines.push(`- ${label}: ${balance}${active}`);
  }
  const text = `# Meshy 크레딧 잔액 (키 ${children.length}개)\n\n${lines.join('\n')}\n\n**합계**: ${total}`;
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      content: [{ type: 'text', text }],
      // 하위 스키마(balance: number)를 깨지 않도록 structuredContent 는 합계만 담는다.
      structuredContent: { balance: total },
      ...(anyOk ? {} : { isError: true }),
    },
  };
}

async function handleToolCall(msg) {
  const params = msg.params || {};
  const name = params.name;
  const args = params.arguments || {};

  if (name === 'meshy_check_balance') return handleCheckBalance(msg);

  // task 를 지목한 호출은 그 task 를 만든 키로만 성립한다(계정 귀속).
  const taskId = args.input_task_id || args.task_id;
  const owner = taskId ? ownerOf(taskId) : undefined;
  if (owner) {
    const c = childByLabel(owner);
    if (c) {
      const res = await sendToChild(c, msg);
      recordTasks(c, res);
      return restoreId(res, msg.id);
    }
    log(`task ${taskId} 의 소유 키 ${owner} 가 현재 키 목록에 없습니다 — 활성 키로 시도합니다.`);
  }

  // 생성 계열 — 활성 키로 시도하고, 잔액 부족이면 다음 키로 같은 요청을 재시도한다.
  let res = await sendToChild(children[state.activeIndex], msg);
  if (!isInsufficient(res)) {
    recordTasks(children[state.activeIndex], res);
    return restoreId(res, msg.id);
  }

  let exhausted = children[state.activeIndex].label;
  for (let j = state.activeIndex + 1; j < children.length; j++) {
    const next = children[j];
    const attempt = await sendToChild(next, msg);
    if (isInsufficient(attempt)) { exhausted = next.label; res = attempt; continue; }
    state.activeIndex = j;
    persist();
    recordTasks(next, attempt);
    log(`${exhausted} 잔액 부족 → ${next.label} 로 전환`);
    return restoreId(annotate(attempt, `[meshy-forge] ${exhausted} 잔액 부족 → ${next.label} 로 전환`), msg.id);
  }
  return restoreId(annotate(res, `[meshy-forge] 키 ${children.length}개가 모두 잔액 부족입니다 — 충전하거나 키를 추가하세요.`), msg.id);
}

async function handleRequest(msg) {
  if (msg.method === 'initialize') return handleInitialize(msg);
  if (msg.method === 'tools/call') return handleToolCall(msg);
  // tools/list 등 나머지는 활성 키 하나면 충분하다(키가 달라도 툴 정의는 같다).
  const res = await sendToChild(children[state.activeIndex], msg);
  return restoreId(res, msg.id);
}

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined || msg.id === null) {
    // 알림 — 두 자식의 상태가 어긋나지 않게 모두에게 전달한다.
    for (const c of children) notifyChild(c, msg);
    return;
  }
  try {
    writeClient(await handleRequest(msg));
  } catch (e) {
    writeClient(errorResponse(msg.id, `프록시 처리 실패: ${e && e.message}`));
  }
}

// ── stdin 루프 ────────────────────────────────────────────────────────────

let shuttingDown = false;
let inBuf = '';

process.stdin.on('data', (chunk) => {
  inBuf += chunk.toString('utf8');
  let nl;
  while ((nl = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, nl).trim();
    inBuf = inBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log(`클라이언트 파싱 불가 라인 무시: ${line.slice(0, 200)}`); continue; }
    if (Array.isArray(msg)) { for (const m of msg) dispatch(m); continue; }
    dispatch(msg);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.proc && c.proc.kill(); } catch { /* noop */ } }
  process.exit(0);
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`키 ${children.length}개(${children.map((c) => c.label).join(', ')}) — 활성 ${children[state.activeIndex].label}, 상태 ${path.join(LIB_ROOT, 'key-state.json')}`);
