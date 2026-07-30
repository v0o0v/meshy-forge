#!/usr/bin/env node
/**
 * scripts/plugin-sync-check.mjs — 설치형 플러그인 사본 ↔ 소스 리포 동기화 판정 (무npm)
 *
 * 로컬 디렉터리 마켓플레이스 설치는 소스 리포를 `~/.claude/plugins/cache/...` 로 **복사**한다.
 * 즉 소스 리포를 고쳐도 다른 프로젝트에서 실행되는 건 설치 시점 스냅샷이다. 이 스크립트가
 * 설치 사본의 commit(installed_plugins.json 의 gitCommitSha)과 소스 리포 HEAD 를 비교해 안내한다.
 *
 * 판정: DEV(리포 직접 실행) | SYNCED | STALE | UNKNOWN
 * 명령: check(기본) | test(오프라인 셀프테스트)
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'meshy-forge@meshy-forge';
const MARKETPLACE = 'meshy-forge';

function pluginsDir(env = process.env) {
  return env.MESHY_PLUGINS_DIR || path.join(os.homedir(), '.claude', 'plugins');
}
function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

/** 설치 레지스트리에서 (installedSha, sourceRepo) 추출 — 파일 부재/형식 불일치는 null 필드로. */
export function readRegistry(dir) {
  const installed = readJson(path.join(dir, 'installed_plugins.json'));
  const markets = readJson(path.join(dir, 'known_marketplaces.json'));
  const entries = installed && installed.plugins && installed.plugins[PLUGIN_ID];
  const inst = Array.isArray(entries) && entries.length ? entries[0] : null;
  const mk = markets && (markets[MARKETPLACE] || (markets.marketplaces && markets.marketplaces[MARKETPLACE]));
  return {
    installedSha: (inst && inst.gitCommitSha) || null,
    installedVersion: (inst && inst.version) || null,
    sourceRepo: (mk && (mk.installLocation || (mk.source && mk.source.path))) || null,
  };
}

/** 순수 판정: 실행 위치/sha 비교 → 상태 문자열 */
export function evaluate({ pluginRoot, cacheDir, installedSha, repoSha }) {
  const underCache = pluginRoot && cacheDir && pluginRoot.toLowerCase().startsWith(cacheDir.toLowerCase());
  if (!underCache) return 'DEV';
  if (!installedSha || !repoSha) return 'UNKNOWN';
  return installedSha === repoSha ? 'SYNCED' : 'STALE';
}

function repoHead(repo) {
  if (!repo || !existsSync(path.join(repo, '.git'))) return null;
  const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function cmdCheck() {
  const dir = pluginsDir();
  const root = process.env.MESHY_FORCE_PLUGIN_ROOT || PLUGIN_ROOT;
  const { installedSha, installedVersion, sourceRepo } = readRegistry(dir);
  const status = evaluate({ pluginRoot: root, cacheDir: path.join(dir, 'cache'), installedSha, repoSha: repoHead(sourceRepo) });
  if (status === 'DEV') console.log('DEV — 소스 리포에서 직접 실행 중. 동기화 불필요.');
  else if (status === 'SYNCED') console.log(`SYNCED — 설치 사본(v${installedVersion})이 소스 리포 HEAD 와 일치.`);
  else if (status === 'STALE') {
    console.log(`STALE — 설치 사본(v${installedVersion}, ${String(installedSha).slice(0, 7)})이 소스 리포(${sourceRepo}) 최신과 다름.`);
    console.log('→ 갱신(로컬 작업, 자동 실행 OK):');
    console.log(`   claude plugin marketplace update ${MARKETPLACE}`);
    console.log(`   claude plugin update ${PLUGIN_ID}`);
    console.log('   (적용은 새 세션/재시작부터 — 현재 세션은 기존 스냅샷으로 계속)');
  } else console.log('UNKNOWN — 설치 레지스트리/소스 리포 확인 불가(타 기기 등). 통과.');
}

function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'meshy-sync-selftest-'));
  try {
    const cacheDir = path.join(tmp, 'cache');
    ok('리포 직접 실행 → DEV', evaluate({ pluginRoot: 'D:\\repo\\x', cacheDir, installedSha: 'a', repoSha: 'b' }) === 'DEV', '');
    const inCache = path.join(cacheDir, 'meshy-forge', 'meshy-forge', '0.1.0');
    ok('sha 일치 → SYNCED', evaluate({ pluginRoot: inCache, cacheDir, installedSha: 'abc', repoSha: 'abc' }) === 'SYNCED', '');
    ok('sha 불일치 → STALE', evaluate({ pluginRoot: inCache, cacheDir, installedSha: 'abc', repoSha: 'def' }) === 'STALE', '');
    ok('sha 미확인 → UNKNOWN', evaluate({ pluginRoot: inCache, cacheDir, installedSha: null, repoSha: 'def' }) === 'UNKNOWN', '');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, 'installed_plugins.json'), JSON.stringify({ plugins: { [PLUGIN_ID]: [{ gitCommitSha: 'sha1', version: '0.1.0' }] } }));
    writeFileSync(path.join(tmp, 'known_marketplaces.json'), JSON.stringify({ [MARKETPLACE]: { installLocation: 'D:\\some\\repo' } }));
    const reg = readRegistry(tmp);
    ok('레지스트리 파싱', reg.installedSha === 'sha1' && reg.installedVersion === '0.1.0' && reg.sourceRepo === 'D:\\some\\repo', JSON.stringify(reg));
    const reg2 = readRegistry(path.join(tmp, 'nope'));
    ok('레지스트리 부재 → null', reg2.installedSha === null && reg2.sourceRepo === null, JSON.stringify(reg2));
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`); if (r.pass) passed++; }
  console.log('─'.repeat(60));
  console.log(`${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

function main() {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'test') return selftest();
  return cmdCheck();
}

const isMain = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main();
