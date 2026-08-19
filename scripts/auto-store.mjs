#!/usr/bin/env node
/**
 * scripts/auto-store.mjs — PostToolUse 훅(비차단)
 *
 * `meshy_download_model` 이 성공하면 내려받은 파일을 **자동으로 라이브러리에 보관**한다.
 * 보관을 사람 손(수동 `meshy-cache.mjs store`)에 맡기면 반드시 빠뜨린다 — 실제로
 * 2026-08-19 세션에서 캐릭터 6종을 받아 놓고 원장에 한 건도 안 남긴 사고가 있었다.
 * 보관 시점을 "다운로드 직후"로 고정해 사람 개입을 없앤다.
 *
 * 하는 일:
 *   1. 응답에서 local_path 를 뽑는다(json/markdown 무관, 3D 포맷만).
 *   2. pending 원장에서 같은 task 를 찾아 프롬프트·크레딧·도구를 복원한다.
 *   3. storeEntry 로 보관하고 pending 에서 지운다(markStored).
 *
 * 프롬프트를 못 찾으면 파일 이름으로라도 보관한다 — 원장에 없는 것보다 낫다.
 * 나중에 `meshy-cache.mjs store --id <같은 id> --prompt "..."` 로 덮어쓰면 정리된다.
 */
import path from 'path';
import { existsSync } from 'fs';
import { resolveLibraryRoot, loadIndex, loadPending, storeEntry, markStored } from './meshy-cache.mjs';

const MODEL_EXT = new Set(['.glb', '.fbx', '.obj', '.usdz', '.stl', '.3mf', '.blend']);
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

function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

/** 응답 텍스트에서 내려받은 모델 파일의 절대 경로를 뽑는다(json 키·markdown 표기 모두 대응). */
function extractLocalPath(text) {
  if (!text) return undefined;
  // 구분자(따옴표·콜론) 주변에 이스케이프 백슬래시가 섞여 있어도 통과시킨다:
  // MCP 응답이 객체면 content[].text 안에 json 이 한 겹 더 들어가 `local_path\":\"C:\\\\...` 꼴이 된다.
  const re = /local_path[\\"']*\s*[:=]\s*[\\"']*([A-Za-z]:[\\/][^"'\n,)]+|\/[^"'\n,)]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 중첩 이스케이프로 백슬래시가 2·4배로 불어난다 — 경로 중간의 연속 백슬래시는 정상 케이스가 없으므로 하나로 접는다.
    const p = m[1].replace(/\\{2,}/g, '\\').replace(/[\s"'\\]+$/, '');
    if (MODEL_EXT.has(path.extname(p).toLowerCase())) return p;
  }
  return undefined;
}

/** 파일 이름 → 라이브러리 id. 이미 다른 모델이 쓰는 id 면 task id 꼬리를 붙여 덮어쓰기를 막는다. */
function makeId(root, file, taskId) {
  const base = path.basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'model';
  const entries = loadIndex(root).entries;
  const clash = entries.find((e) => e.id === base);
  if (!clash) return base;
  // 같은 task 를 다시 받은 것이면 같은 id 로 갱신하는 게 맞다.
  if (clash.meshy && taskId && clash.meshy.taskId === taskId) return base;
  return `${base}_${String(taskId || '').slice(0, 8) || 'x'}`;
}

async function run() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
  const toolName = payload.tool_name || payload.toolName || '';
  const short = toolName.replace(/^mcp__.*?meshy__/, '');
  if (short !== 'meshy_download_model') return;

  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const responseText = flatten(payload.tool_response || payload.toolResponse || payload.response);

  const file = extractLocalPath(responseText) || (typeof input.save_to === 'string' ? input.save_to : undefined);
  if (!file || !existsSync(file)) return; // 이미지 다운로드·실패 응답은 조용히 지나간다.
  if (!MODEL_EXT.has(path.extname(file).toLowerCase())) return;

  const taskId = input.task_id || (UUID_RE.exec(responseText) || [])[0];
  const { root } = resolveLibraryRoot();

  // pending 에 남은 생성 기록에서 프롬프트·크레딧을 되살린다.
  let rec;
  try {
    const tasks = loadPending(root).tasks;
    rec = tasks.find((t) => taskId && t.taskId === taskId) || undefined;
  } catch { /* pending 손상은 보관을 막지 않는다 */ }

  const id = makeId(root, file, taskId);
  // 같은 id 를 다시 받는 경우(재다운로드·포맷 변경) 이미 적어 둔 프롬프트·태그를 파일명 폴백으로 덮지 않는다.
  const prev = loadIndex(root).entries.find((e) => e.id === id);
  const fallbackPrompt = path.basename(file, path.extname(file));
  const prompt = (rec && rec.prompt) || (prev && prev.prompt) || fallbackPrompt;
  const res = storeEntry(root, {
    id,
    file,
    prompt,
    texturePrompt: (rec && rec.texturePrompt) || (prev && prev.texturePrompt),
    tags: (prev && prev.tags && prev.tags.length) ? prev.tags : ['auto-store'],
    style: prev && prev.style,
    project: prev && prev.project,
    license: prev && prev.license,
    meshy: {
      taskId: taskId || (prev && prev.meshy && prev.meshy.taskId),
      taskType: input.task_type || (rec && rec.tool) || (prev && prev.meshy && prev.meshy.taskType),
      credits: (rec && rec.credits) != null ? rec.credits : (prev && prev.meshy && prev.meshy.credits),
      expiresAt: (rec && rec.expiresAt) || (prev && prev.meshy && prev.meshy.expiresAt),
    },
  });
  if (taskId || rec) markStored(root, { taskId, prompt: rec && rec.prompt });

  const dup = res.duplicateOf ? ` (내용 동일: ${res.duplicateOf})` : '';
  const vague = prompt === fallbackPrompt
    ? ` — 프롬프트 미상(파일명으로 기록). 정리하려면: meshy-cache.mjs store --id ${id} --prompt "..."`
    : '';
  process.stderr.write(`💾 [meshy-forge] 자동 보관: ${id} → ${path.join(root, 'models')}${dup} (총 ${res.total}건)${vague}\n`);
}

// 훅 실패가 작업을 막지 않는다 — 항상 exit 0.
run().then(() => process.exit(0)).catch((e) => {
  try { process.stderr.write(`⚠️ [meshy-forge] 자동 보관 실패(작업은 계속): ${e && e.message}\n`); } catch { /* noop */ }
  process.exit(0);
});
