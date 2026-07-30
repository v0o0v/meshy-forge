#!/usr/bin/env node
/**
 * scripts/reuse-guard.mjs — PreToolUse 훅(비차단)
 *
 * Meshy 생성 호출 직전에 실행돼 ① 이미 보관 중인 유사 모델과 ② 아직 안 받아 둔 만료 임박 task 를
 * 알린다. 절대 차단하지 않는다(exit 0) — 3D 는 미세한 형상 차이가 용도를 가르므로 재사용 강제는 해롭다.
 *
 * stdin: Claude Code 가 주는 tool 호출 정보 JSON(tool_name, tool_input, ...).
 */
import path from 'path';
import { resolveLibraryRoot, findMatches, absModelPath, hoursLeft, loadPending, REUSE_THRESHOLD, BackendUnavailableError } from './meshy-cache.mjs';

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
      if (process.stdin.isTTY) done(); // stdin 없는 수동 실행에서 무한 대기 방지
    } catch { done(); }
  });
}

function collectPrompts(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
  push(input.prompt);
  push(input.texture_prompt);
  push(input.text_style_prompt);
  return out;
}

async function run() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
  const toolName = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  if (!/^mcp__meshy__meshy_(text_to_3d|image_to_3d|multi_image_to_3d|retexture|remesh|rig|animate|creative_lab)/.test(toolName)) return;

  const { root } = resolveLibraryRoot();

  // ① 만료 임박 미보관 task — 새로 만들기 전에 이미 쓴 크레딧부터 건져라.
  try {
    const tasks = loadPending(root).tasks;
    const urgent = tasks.filter((t) => { const h = t.expiresAt ? hoursLeft(t.expiresAt) : null; return h != null && h > 0 && h < 48; });
    if (urgent.length) {
      process.stderr.write(`⏳ [meshy-forge] 미보관 task ${urgent.length}건 — 서버에서 곧 삭제된다(크레딧 증발).\n`);
      for (const t of urgent.slice(0, 3)) {
        process.stderr.write(`   ${(t.taskId || '(task id 미기록)')}  ${hoursLeft(t.expiresAt).toFixed(1)}h 남음  "${String(t.prompt).slice(0, 44)}"\n`);
      }
      process.stderr.write('   → meshy_download_model(task_id, format:"glb") 후 meshy-cache.mjs store 로 보관.\n');
    }
  } catch { /* pending 확인 실패는 무시(생성 미차단) */ }

  // ② 유사 보관본 — 훅은 rebuild 금지(allowRebuild:false), 신선한 인덱스일 때만 조회.
  let backendWarned = false;
  for (const desc of collectPrompts(input)) {
    let ranked;
    try {
      ranked = findMatches({ prompt: desc, tags: [] }, root, { top: 1, allowRebuild: false });
    } catch (e) {
      if (e instanceof BackendUnavailableError && !backendWarned) {
        process.stderr.write('⚠️ [meshy-forge] 검색 인덱스 백엔드 사용 불가 — 조회 건너뜀(생성은 계속). setup: node "<plugin>/scripts/meshy-cache.mjs" setup\n');
        backendWarned = true;
      }
      continue;
    }
    if (ranked.length && ranked[0].s >= REUSE_THRESHOLD) {
      const best = ranked[0];
      process.stderr.write(`♻️ [meshy-forge] 유사 보관본 (score ${best.s.toFixed(2)}): "${desc.slice(0, 56)}"\n`);
      process.stderr.write(`   ${absModelPath(best.e, root)}\n`);
      const exp = best.e.meshy && best.e.meshy.expiresAt;
      const h = exp ? hoursLeft(exp) : null;
      if (h != null && h > 0 && best.e.meshy.taskId) {
        process.stderr.write(`   색·재질만 다르면 meshy_retexture(input_task_id:"${best.e.meshy.taskId}") — 10크레딧, ${h.toFixed(1)}h 남음\n`);
      }
      process.stderr.write('   (차단 안 함 — 형상이 다르면 그대로 생성하라.)\n');
    }
  }
}

// 어떤 경우에도 tool 실행을 막지 않는다 — 항상 exit 0.
run().then(() => process.exit(0)).catch(() => process.exit(0));
