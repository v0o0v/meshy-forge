#!/usr/bin/env node
/**
 * scripts/mcp-setup.mjs — 번들용 `.mcp.json` 생성기
 *
 * 이 플러그인은 Meshy MCP 서버 설정을 **함께 제공한다**(로컬 디렉터리 마켓플레이스가 설치 사본으로 복사).
 * 다만 API 키는 리포에 커밋하면 안 되므로(.gitignore) 파일 자체는 각자 로컬에서 만든다.
 *
 * 등록되는 것은 업스트림 서버가 아니라 `scripts/meshy-proxy.mjs` 프록시다.
 * 프록시가 키마다 업스트림을 하나씩 띄워 잔액 소진 시 자동 전환한다(README 참고).
 * 서버 이름은 `meshy` 그대로 유지해야 한다 — 바꾸면 툴 이름이 바뀌어 hooks.json 의
 * `mcp__.*meshy__.*` matcher 가 죽고 자동 보관이 통째로 멈춘다.
 *
 * 사용(키는 환경변수로만 전달 — 명령 히스토리·로그에 남기지 않으려면 세션 변수로 넣어라):
 *   PowerShell:  $env:MESHY_API_KEYS = "msy_a,msy_b"; node scripts/mcp-setup.mjs
 *   bash:        MESHY_API_KEYS=msy_a,msy_b node scripts/mcp-setup.mjs
 *
 * 키가 하나뿐이면 MESHY_API_KEY 하나만 넣어도 된다(그대로 동작한다).
 * 이미 파일이 있으면 덮어쓰지 않는다(--force 로 강제).
 */
import { writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseKeys } from './key-state.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(PLUGIN_ROOT, '.mcp.json');
const force = process.argv.includes('--force');

const keys = parseKeys();
if (keys.length === 0) {
  console.error('MESHY_API_KEYS(또는 MESHY_API_KEY) 환경변수가 없습니다. Meshy 대시보드의 API 키를 환경변수로 넣고 다시 실행하세요.');
  console.error('  PowerShell:  $env:MESHY_API_KEYS = "msy_a,msy_b"; node scripts/mcp-setup.mjs');
  console.error('  bash:        MESHY_API_KEYS=msy_a,msy_b node scripts/mcp-setup.mjs');
  process.exit(1);
}
if (existsSync(dest) && !force) {
  console.error(`이미 존재합니다: ${dest}  (덮어쓰려면 --force)`);
  process.exit(1);
}

// 프록시 경로는 절대경로로 박는다. 설치 사본이 이 파일을 복사해 가도 소스 리포의 스크립트를
// 실행하게 되는데, 라이브러리 해석(resolveLibraryRoot)도 마켓플레이스 소스 리포를 가리키므로 일관된다.
const proxy = path.join(PLUGIN_ROOT, 'scripts', 'meshy-proxy.mjs');

const cfg = {
  mcpServers: {
    meshy: {
      type: 'stdio',
      command: 'node',
      args: [proxy],
      env: { MESHY_API_KEYS: keys.map((k) => k.key).join(',') },
    },
  },
};
writeFileSync(dest, JSON.stringify(cfg, null, 2) + '\n');
console.log(`작성 완료: ${dest} — 키 ${keys.length}개(${keys.map((k) => `${k.label} ${k.key.length}자`).join(', ')}), gitignore 대상이라 커밋되지 않습니다`);
if (keys.length === 1) console.log('키가 하나입니다 — 폴백은 키를 하나 더 넣어야 의미가 생깁니다.');
console.log('');
console.log('설치 사본은 이 파일을 아직 갖고 있지 않습니다. 아래 두 명령으로 다시 복사해야 플러그인이 MCP 를 제공합니다:');
console.log('(update 는 plugin.json 의 version 이 달라야 실제로 복사한다 — 같으면 "이미 최신"이라며 no-op)');
console.log('  claude plugin marketplace update meshy-forge');
console.log('  claude plugin update meshy-forge@meshy-forge');
console.log('(적용은 새 세션부터. 기존에 user scope 로 등록된 meshy 서버가 있으면 이름이 겹치니 먼저 제거: claude mcp remove meshy --scope user)');
