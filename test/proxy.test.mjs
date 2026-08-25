#!/usr/bin/env node
/**
 * test/proxy.test.mjs — meshy-proxy 모의 검증 (크레딧 0)
 *
 * 진짜 키를 소진시킬 수 없으니 가짜 업스트림(test/mock-upstream.mjs)을 꽂아
 * 잔액 소진 폴백 · task→키 라우팅 · 잔액 합산 · 상태 파일을 검증한다.
 *
 * 콘솔 출력은 ASCII 만 쓴다 — PowerShell 5.1 콘솔에서 한글이 깨지면 성공을 실패로 오독한다.
 *
 * 실행:  node test/proxy.test.mjs
 */
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_A = 'msy_test_a';
const KEY_B = 'msy_test_b';

const lib = mkdtempSync(path.join(os.tmpdir(), 'meshy-proxy-test-'));
let failures = 0;

function check(name, cond, detail) {
  if (cond) { console.log(`[OK]   ${name}`); return; }
  failures += 1;
  console.log(`[FAIL] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const proxy = spawn(process.execPath, [path.join(ROOT, 'scripts', 'meshy-proxy.mjs')], {
  env: {
    ...process.env,
    MESHY_FORGE_LIBRARY: lib,
    MESHY_API_KEYS: `${KEY_A},${KEY_B}`,
    // 업스트림을 가짜로 갈아끼운다.
    MESHY_MCP_COMMAND: process.execPath,
    MESHY_MCP_ARGS: path.join(ROOT, 'test', 'mock-upstream.mjs'),
    // key1 은 빈 계정, key2 는 크레딧이 남아 있다.
    [`MOCK_BALANCE_${KEY_A}`]: '0',
    [`MOCK_BALANCE_${KEY_B}`]: '200',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const waiting = new Map();
let buf = '';
proxy.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(myId); reject(new Error(`timeout: ${method}`)); }, 10000);
    waiting.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

function textOf(res) {
  return ((res.result && res.result.content) || []).map((c) => c.text || '').join('\n');
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize returns a result', !!(init.result && init.result.serverInfo), JSON.stringify(init).slice(0, 200));

  const tools = await rpc('tools/list', {});
  check('tools/list is a single set', !!(tools.result && tools.result.tools && tools.result.tools.length === 3),
    `count=${tools.result && tools.result.tools && tools.result.tools.length}`);

  const bal = await rpc('tools/call', { name: 'meshy_check_balance', arguments: {} });
  const balText = textOf(bal);
  check('balance is summed across keys', bal.result.structuredContent.balance === 200, `got ${bal.result.structuredContent.balance}`);
  check('balance lists both keys', balText.includes('key1: 0') && balText.includes('key2: 200'), balText);

  const gen = await rpc('tools/call', { name: 'meshy_text_to_3d', arguments: { prompt: 'a test cube' } });
  const genText = textOf(gen);
  check('generation succeeds via fallback', gen.result.isError !== true, genText);
  check('switch notice is prepended', genText.startsWith('[meshy-forge] key1'), genText.slice(0, 120));
  const taskId = gen.result.structuredContent && gen.result.structuredContent.task_id;
  check('task id came from key2', taskId === `${KEY_B}-task-1`, String(taskId));

  // key2 로 만든 task 를 조회하면 key2 로 라우팅돼야 한다. key1 로 갔다면 모의가 NotFound 를 준다.
  const status = await rpc('tools/call', { name: 'meshy_get_task_status', arguments: { task_id: taskId } });
  const statusText = textOf(status);
  check('task status routes to the owning key', status.result.isError !== true && statusText.includes(KEY_B), statusText);

  // 소유 키를 모르는 task 는 활성 키로 간다 — 활성은 이제 key2 다.
  const unknown = await rpc('tools/call', { name: 'meshy_get_task_status', arguments: { task_id: 'no-such-task' } });
  check('unknown task fails cleanly instead of hanging', unknown.result.isError === true, textOf(unknown));

  const state = JSON.parse(readFileSync(path.join(lib, 'key-state.json'), 'utf8'));
  check('active key switched to key2', state.activeIndex === 1, `activeIndex=${state.activeIndex}`);
  check('task ownership persisted', state.tasks[taskId] === 'key2', JSON.stringify(state.tasks));
}

main()
  .catch((e) => { failures += 1; console.log(`[FAIL] harness error -- ${e && e.message}`); })
  .finally(() => {
    try { proxy.stdin.end(); proxy.kill(); } catch { /* noop */ }
    try { rmSync(lib, { recursive: true, force: true }); } catch { /* noop */ }
    console.log(failures === 0 ? 'RESULT PASS' : `RESULT FAIL (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
