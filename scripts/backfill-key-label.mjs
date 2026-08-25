#!/usr/bin/env node
/**
 * scripts/backfill-key-label.mjs — 원장의 기존 엔트리에 meshy.keyLabel 을 채운다
 *
 * 복수 키를 도입하기 전에 보관된 모델은 전부 첫 번째 키(key1) 계정으로 만든 것이다.
 * 라벨이 비어 있으면 프록시가 소유 키를 몰라 활성 키로 보내고, 활성 키가 key2 로 넘어간 뒤에는
 * 옛 모델의 input_task_id 기반 retexture/remesh 가 NotFound 로 조용히 실패한다.
 *
 * 이미 라벨이 있는 엔트리는 건드리지 않는다. 여러 번 실행해도 안전하다.
 *
 * 사용:  node scripts/backfill-key-label.mjs [--label key1] [--dry-run]
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import path from 'path';
import { resolveLibraryRoot } from './key-state.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const labelAt = argv.indexOf('--label');
const label = labelAt >= 0 ? argv[labelAt + 1] : 'key1';

const root = resolveLibraryRoot();
const file = path.join(root, 'index.json');
const idx = JSON.parse(readFileSync(file, 'utf8'));

let filled = 0;
let skipped = 0;
for (const e of idx.entries || []) {
  if (!e.meshy || !e.meshy.taskId) { skipped += 1; continue; } // task 가 없으면 라우팅할 일도 없다.
  if (e.meshy.keyLabel) { skipped += 1; continue; }
  e.meshy.keyLabel = label;
  filled += 1;
}

console.log(`[backfill] library: ${root}`);
console.log(`[backfill] entries=${(idx.entries || []).length} filled=${filled} skipped=${skipped} label=${label}`);
if (dryRun) { console.log('[backfill] dry-run, no write'); process.exit(0); }
if (filled === 0) { console.log('[backfill] nothing to write'); process.exit(0); }

const tmp = file + '.tmp';
writeFileSync(tmp, JSON.stringify(idx, null, 2) + '\n');
renameSync(tmp, file);
console.log('[backfill] done');
