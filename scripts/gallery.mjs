#!/usr/bin/env node
/**
 * scripts/gallery.mjs — 보관 모델 웹 갤러리(로컬 http 서버 + <model-viewer>)
 *
 * 왜 필요한가: 3D 는 정지 썸네일 한 장으로 판단이 안 된다(뒷면·실루엣·재질). 그래서 목록은 썸네일로
 * 훑고, 고를 때는 브라우저에서 **실물 GLB 를 직접 돌려 본다**. 사용자에게 이미지를 보여줄 때는
 * 파일 전송이 아니라 브라우저 탭으로 연다는 전역 규칙과도 맞는다.
 *
 * 사용:
 *   node scripts/gallery.mjs [--port 8791] [--open] [--tags a,b] [--style <프리셋>]
 *
 * 주의: <model-viewer> 는 CDN 에서 로드한다(오프라인이면 뷰어가 안 뜨고 썸네일만 보인다).
 * Meshy 자체가 온라인 서비스라 실사용 맥락에서는 문제가 되지 않는다.
 */
import http from 'http';
import { readFileSync, existsSync, statSync, createReadStream } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { realpathSync } from 'fs';
import { resolveLibraryRoot, loadIndex, entryFile, entryStyle, hoursLeft } from './meshy-cache.mjs';

const MIME = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n == null ? '?' : (n / 1048576).toFixed(2) + 'MB');

function renderPage(entries, root) {
  const cards = entries.map((e) => {
    const exp = e.meshy && e.meshy.expiresAt;
    const h = exp ? hoursLeft(exp) : null;
    const expTxt = h == null ? '만료일 미상'
      : h < 0 ? `서버 만료됨 — 변형 불가`
        : `변형 가능 ${h.toFixed(1)}h`;
    const g = e.geometry || {};
    return `
    <article class="card">
      <model-viewer src="/models/${encodeURIComponent(entryFile(e))}"
        ${e.thumbnail ? `poster="/thumbs/${encodeURIComponent(e.thumbnail)}"` : ''}
        camera-controls auto-rotate touch-action="pan-y" shadow-intensity="1"
        alt="${esc(e.prompt)}"></model-viewer>
      <h3>${esc(e.id)}</h3>
      <p class="prompt">${esc(e.prompt)}</p>
      <p class="meta">${mb(g.bytes)} · ${g.triangles ?? '?'} tri · tex ${mb(g.textureBytes)}</p>
      <p class="meta">${esc(entryStyle(e) || '스타일 미지정')} · ${(e.tags || []).map(esc).join(', ') || '태그 없음'}</p>
      <p class="meta ${h != null && h < 0 ? 'dead' : 'live'}">${esc(expTxt)}${e.meshy && e.meshy.taskId ? ' · ' + esc(e.meshy.taskId) : ''}</p>
    </article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>Meshy Forge 라이브러리 (${entries.length}건)</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script type="module" src="https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #14161a; color: #e8eaed; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .root { font-size: 12px; color: #9aa0a6; margin: 0 0 16px; word-break: break-all; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
  .card { background: #1e2126; border: 1px solid #2c3038; border-radius: 10px; padding: 10px; }
  model-viewer { width: 100%; height: 220px; background: #0e1013; border-radius: 8px; }
  h3 { font-size: 14px; margin: 8px 0 4px; }
  .prompt { font-size: 12px; color: #c8ccd2; margin: 0 0 6px; }
  .meta { font-size: 11px; color: #9aa0a6; margin: 2px 0; }
  .live { color: #7fd18a; } .dead { color: #e0777a; }
  .empty { color: #9aa0a6; }
</style></head>
<body>
  <h1>Meshy Forge 라이브러리 — ${entries.length}건</h1>
  <p class="root">${esc(root)}</p>
  ${entries.length ? `<div class="grid">${cards}</div>` : '<p class="empty">보관된 모델이 없습니다. store 로 등록하세요.</p>'}
</body></html>`;
}

function serve(root, entries, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '/index.html') {
      const html = renderPage(entries, root);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const m = /^\/(models|thumbs)\/(.+)$/.exec(url);
    if (m) {
      // 경로 탈출 방지: basename 만 사용한다(라이브러리 밖 파일은 절대 서빙하지 않는다).
      const file = path.join(root, m[1], path.basename(m[2]));
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': statSync(file).size,
        });
        createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root } = resolveLibraryRoot();
  let entries = loadIndex(root).entries;
  if (args.tags && args.tags !== 'true') {
    const want = String(args.tags).split(',').map((t) => t.toLowerCase());
    entries = entries.filter((e) => want.every((t) => (e.tags || []).map((x) => String(x).toLowerCase()).includes(t)));
  }
  if (args.style && args.style !== 'true') entries = entries.filter((e) => entryStyle(e) === args.style);
  let port = Number(args.port) || 8791;
  let server;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { server = await serve(root, entries, port); break; } catch (e) {
      if (e && e.code === 'EADDRINUSE') { port++; continue; }
      throw e;
    }
  }
  if (!server) { console.error('빈 포트를 찾지 못했습니다.'); process.exit(1); }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`갤러리 ${entries.length}건 → ${url}`);
  console.log(`라이브러리 ${root}`);
  console.log('종료: Ctrl+C');
  if (args.open === 'true' || args.open === undefined) openBrowser(url);
}

const isMain = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main();
export { renderPage };
