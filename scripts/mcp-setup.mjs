#!/usr/bin/env node
/**
 * scripts/mcp-setup.mjs — 번들용 `.mcp.json` 생성기
 *
 * 이 플러그인은 Meshy MCP 서버 설정을 **함께 제공한다**(로컬 디렉터리 마켓플레이스가 설치 사본으로 복사).
 * 다만 API 키는 리포에 커밋하면 안 되므로(.gitignore) 파일 자체는 각자 로컬에서 만든다.
 *
 * 사용(키는 환경변수로만 전달 — 명령 히스토리·로그에 남기지 않으려면 세션 변수로 넣어라):
 *   PowerShell:  $env:MESHY_API_KEY = "msy_..."; node scripts/mcp-setup.mjs
 *   bash:        MESHY_API_KEY=msy_... node scripts/mcp-setup.mjs
 *
 * 이미 파일이 있으면 덮어쓰지 않는다(--force 로 강제).
 */
import { writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(PLUGIN_ROOT, '.mcp.json');
const force = process.argv.includes('--force');

const key = process.env.MESHY_API_KEY;
if (!key) {
  console.error('MESHY_API_KEY 환경변수가 없습니다. Meshy 대시보드의 API 키를 환경변수로 넣고 다시 실행하세요.');
  console.error('  PowerShell:  $env:MESHY_API_KEY = "msy_..."; node scripts/mcp-setup.mjs');
  process.exit(1);
}
if (existsSync(dest) && !force) {
  console.error(`이미 존재합니다: ${dest}  (덮어쓰려면 --force)`);
  process.exit(1);
}

const cfg = {
  mcpServers: {
    meshy: {
      type: 'stdio',
      command: process.platform === 'win32' ? 'cmd' : 'npx',
      args: process.platform === 'win32'
        ? ['/c', 'npx', '-y', '@meshy-ai/meshy-mcp-server']
        : ['-y', '@meshy-ai/meshy-mcp-server'],
      env: { MESHY_API_KEY: key },
    },
  },
};
writeFileSync(dest, JSON.stringify(cfg, null, 2) + '\n');
console.log(`작성 완료: ${dest} (키 ${key.length}자 — gitignore 대상이라 커밋되지 않습니다)`);
console.log('플러그인을 재설치/갱신하면 이 파일이 설치 사본으로 복사돼 meshy MCP 가 함께 제공됩니다.');
console.log('⚠️ 기존에 user scope 로 등록된 meshy 서버가 있으면 이름이 겹칩니다: claude mcp remove meshy --scope user');
