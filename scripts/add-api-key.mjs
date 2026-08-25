#!/usr/bin/env node
/**
 * scripts/add-api-key.mjs — `.mcp.json` 의 MESHY_API_KEYS 에 새 키를 덧붙인다
 *
 * 왜 따로 두는가:
 *   `mcp-setup.mjs --force` 는 키 전체를 환경변수로 다시 받아 파일을 새로 쓴다.
 *   키를 하나만 더 넣고 싶을 때 기존 키까지 다시 타이핑하게 만들면, 오타 한 번에
 *   멀쩡히 살아 있던 계정의 크레딧과 그 계정 소유 task 들이 통째로 접근 불능이 된다.
 *   그래서 이 스크립트는 **기존 키를 읽어서 그대로 두고 뒤에만 붙인다**.
 *
 * 입력 파일은 "한 줄에 키 하나", '#' 로 시작하는 줄은 주석이다.
 * 병합이 끝나면 입력 파일을 지운다 — 평문 키가 임시 파일로 남아 돌아다니면 안 된다.
 * (--keep 으로 보존 가능. 디버깅용이며 평소엔 쓰지 마라.)
 *
 * 사용:
 *   node scripts/add-api-key.mjs <입력파일> [--keep] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_FILE = path.join(PLUGIN_ROOT, '.mcp.json');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const dryRun = argv.includes('--dry-run');
const inputFile = argv.find((a) => !a.startsWith('--'));

if (!inputFile) {
  console.error('사용법: node scripts/add-api-key.mjs <입력파일> [--keep] [--dry-run]');
  process.exit(1);
}
if (!existsSync(inputFile)) {
  console.error(`입력 파일이 없습니다: ${inputFile}`);
  process.exit(1);
}
if (!existsSync(MCP_FILE)) {
  console.error(`.mcp.json 이 없습니다: ${MCP_FILE}  (먼저 scripts/mcp-setup.mjs 로 만드세요)`);
  process.exit(1);
}

// BOM 이 붙어 있어도(메모장 저장) 첫 키가 깨지지 않게 떼어낸다.
const rawInput = readFileSync(inputFile, 'utf8').replace(/^﻿/, '');
const added = rawInput
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const cfg = JSON.parse(readFileSync(MCP_FILE, 'utf8'));
const server = cfg.mcpServers && cfg.mcpServers.meshy;
if (!server || !server.env) {
  console.error('.mcp.json 에 mcpServers.meshy.env 가 없습니다. 형식을 확인하세요.');
  process.exit(1);
}

const existing = (server.env.MESHY_API_KEYS || server.env.MESHY_API_KEY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const merged = existing.slice();
const skipped = [];
const accepted = [];
for (const k of added) {
  if (!/^msy_/.test(k)) { skipped.push(`${mask(k)} (msy_ 로 시작하지 않음 — 오타로 보입니다)`); continue; }
  if (merged.includes(k)) { skipped.push(`${mask(k)} (이미 등록됨)`); continue; }
  merged.push(k);
  accepted.push(k);
}

function mask(k) {
  if (k.length <= 10) return `${k.slice(0, 4)}…`;
  return `${k.slice(0, 8)}…${k.slice(-4)} (${k.length}자)`;
}

console.log(`기존 키 ${existing.length}개는 그대로 유지합니다.`);
for (const [i, k] of merged.entries()) {
  const tag = i < existing.length ? '유지' : '추가';
  console.log(`  key${i + 1}  ${tag}  ${mask(k)}`);
}
for (const s of skipped) console.log(`  건너뜀  ${s}`);

if (accepted.length === 0) {
  console.log('추가된 키가 없습니다. .mcp.json 은 그대로 둡니다.');
  if (!keep && !dryRun) { try { unlinkSync(inputFile); } catch { /* noop */ } }
  process.exit(0);
}
if (dryRun) { console.log('dry-run — 저장하지 않았습니다.'); process.exit(0); }

// 단일 키 표기를 쓰고 있었다면 복수 키 표기로 승격한다.
delete server.env.MESHY_API_KEY;
server.env.MESHY_API_KEYS = merged.join(',');

const tmp = MCP_FILE + '.tmp';
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
renameSync(tmp, MCP_FILE);
console.log(`\n저장 완료: ${MCP_FILE} — 키 ${merged.length}개`);

if (!keep) {
  try { unlinkSync(inputFile); console.log(`입력 파일 삭제: ${inputFile} (평문 키를 남기지 않습니다)`); }
  catch (e) { console.log(`입력 파일 삭제 실패 — 직접 지우세요: ${inputFile} (${e && e.message})`); }
}

console.log('');
console.log('적용은 새 세션부터입니다. 설치 사본에도 반영하려면:');
console.log('  claude plugin marketplace update meshy-forge');
console.log('  claude plugin update meshy-forge@meshy-forge');
