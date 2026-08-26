#!/usr/bin/env node
/**
 * test/mock-upstream.mjs — `@meshy-ai/meshy-mcp-server` 를 흉내 내는 가짜 업스트림
 *
 * 진짜 키를 소진시키지 않고 폴백 경로를 검증하기 위한 것이다.
 * 응답 모양은 업스트림 0.4.0 소스에서 그대로 베꼈다:
 *   - 잔액 부족은 JSON-RPC error 가 아니라 `isError: true` + 오류 텍스트.
 *     문구는 업스트림 버전마다 다르다 — MOCK_INSUFFICIENT_STYLE_<키> 로 고른다:
 *       credits (기본) "Error: Insufficient credits. ..."      (0.4.0)
 *       402            "Error: API request failed with status 402. Insufficient funds" (2026-08 실측)
 *   - task 생성 응답은 markdown 본문에 "**Task ID**: <id>" 와 structuredContent.task_id
 *   - task 는 계정 귀속이라 남의 task 를 조회하면 NotFound
 *
 * 어느 키로 떴는지는 MESHY_API_KEY 로 구분한다. 잔액은 MOCK_BALANCE_<키> 로 준다.
 */
const KEY = process.env.MESHY_API_KEY || '';
const BALANCE = Number(process.env[`MOCK_BALANCE_${KEY}`] ?? 0);
/** 이 모의 서버가 소유한 task 들 — 자기가 만든 것만 조회에 성공한다. */
const owned = new Set((process.env[`MOCK_OWNED_${KEY}`] || '').split(',').filter(Boolean));
/** 잔액 부족 문구 — 업스트림 버전 차이를 재현한다. */
const INSUFFICIENT_TEXT = (process.env[`MOCK_INSUFFICIENT_STYLE_${KEY}`] || 'credits') === '402'
  ? 'Error: API request failed with status 402. Insufficient funds'
  : 'Error: Insufficient credits. Use `meshy_check_balance` to check your balance. Upgrade at https://meshy.ai/pricing';
let seq = 0;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id, content, structuredContent) { send({ jsonrpc: '2.0', id, result: { content, ...(structuredContent ? { structuredContent } : {}) } }); }
function fail(id, text) { send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 알림은 조용히 삼킨다.
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-meshy', version: '0.0.0', key: KEY } } });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'meshy_text_to_3d' }, { name: 'meshy_check_balance' }, { name: 'meshy_get_task_status' }] } });
    return;
  }
  if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } }); return; }

  const name = params && params.name;
  const args = (params && params.arguments) || {};

  if (name === 'meshy_check_balance') {
    ok(id, [{ type: 'text', text: `# Credit Balance\n\n**Balance**: ${BALANCE} credits` }], { balance: BALANCE });
    return;
  }
  if (name === 'meshy_get_task_status') {
    if (!owned.has(args.task_id)) { fail(id, 'Error: Resource not found. Please verify the task ID is correct.'); return; }
    ok(id, [{ type: 'text', text: `# Task Status\n\n**Task ID**: ${args.task_id}\n**Status**: SUCCEEDED\n**Owner Key**: ${KEY}` }], { task_id: args.task_id, status: 'SUCCEEDED' });
    return;
  }
  // 생성 계열 — 잔액이 없으면 업스트림과 같은 문구로 거절한다.
  if (BALANCE <= 0) {
    fail(id, INSUFFICIENT_TEXT);
    return;
  }
  const taskId = `${KEY}-task-${++seq}`;
  owned.add(taskId);
  ok(id, [{ type: 'text', text: `# 3D Generation Task Created\n\n**Task ID**: ${taskId}\n**Status**: PENDING\n**Estimated Time**: 2 minutes` }], { task_id: taskId, status: 'PENDING' });
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* 무시 */ }
  }
});
process.stdin.on('end', () => process.exit(0));
