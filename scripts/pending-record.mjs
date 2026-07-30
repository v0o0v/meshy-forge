#!/usr/bin/env node
/**
 * scripts/pending-record.mjs — PostToolUse 훅(비차단)
 *
 * Meshy 생성 호출이 끝나면 task 를 pending 원장에 남긴다. 목적은 하나다:
 * **생성했는데 안 받아 둔 것**을 놓치지 않게 하는 것. Meshy 는 비-Enterprise 생성물을 3일 뒤 삭제하므로
 * 다운로드를 빼먹으면 20~30크레딧이 그대로 사라진다.
 *
 * 응답에서 task_id 를 찾을 수 있으면 함께 적는다(도구·형식마다 달라 UUID 패턴으로 추출).
 * 못 찾아도 프롬프트·시각만으로 기록한다 — "무언가 만들었는데 안 받았다"는 사실 자체가 경고 근거다.
 */
import { resolveLibraryRoot, recordPending } from './meshy-cache.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(raw); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      if (process.stdin.isTTY) done();
    } catch { done(); }
  });
}

/** 응답 전체를 문자열로 눌러 UUID 를 찾는다(markdown/json 어느 형식이든 동일하게 동작). */
function extractTaskId(response) {
  if (!response) return undefined;
  let text;
  try { text = typeof response === 'string' ? response : JSON.stringify(response); } catch { return undefined; }
  const m = UUID_RE.exec(text);
  return m ? m[0] : undefined;
}

// 크레딧은 MCP 서버 지침의 고지 표와 같은 값(사후 회계가 아니라 "얼마를 잃을 뻔했나"의 눈금).
const CREDITS = {
  meshy_text_to_3d: 20,
  meshy_text_to_3d_refine: 10,
  meshy_image_to_3d: 20,
  meshy_multi_image_to_3d: 30,
  meshy_retexture: 10,
  meshy_remesh: 5,
  meshy_rig: 5,
  meshy_animate: 3,
};

async function run() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
  const toolName = payload.tool_name || payload.toolName || '';
  if (!/^mcp__meshy__meshy_(text_to_3d|text_to_3d_refine|image_to_3d|multi_image_to_3d|retexture|remesh|rig|animate)/.test(toolName)) return;
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const response = payload.tool_response || payload.toolResponse || payload.response;

  const short = toolName.replace('mcp__meshy__', '');
  const { root } = resolveLibraryRoot();
  const n = recordPending(root, {
    tool: short,
    taskId: extractTaskId(response),
    prompt: input.prompt || input.texture_prompt || input.text_style_prompt || `(${short})`,
    texturePrompt: input.texture_prompt || undefined,
    credits: CREDITS[short],
  });
  process.stderr.write(`📥 [meshy-forge] 생성 task 기록 — 3일 안에 다운로드·보관해야 한다(미보관 ${n}건). 완료되면 바로: meshy_download_model → meshy-cache.mjs store\n`);
}

// 훅 실패가 작업을 막지 않는다 — 항상 exit 0.
run().then(() => process.exit(0)).catch(() => process.exit(0));
