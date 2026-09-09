import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFor } from './tests/fixtures.mjs';

const root = fileURLToPath(new URL('../s3_cpu_gate/src/worker/assets/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const profile = String(process.env.PHASE6_VISUAL_PREVIEW_ROLE || '').trim().toLowerCase();
const dataMode = String(process.env.PHASE6_VISUAL_PREVIEW_DATA_MODE || '').trim().toLowerCase();
const enabled = ['waleed','khalid'].includes(profile) && ['demo','clean'].includes(dataMode);
const port = Number(process.env.PHASE6_VISUAL_PREVIEW_PORT || 4179);
const identity = profile === 'khalid'
  ? { uid: 'uid-two', role: 'person_2', identityMode: 'D028_TARGET', dataMode: dataMode.toUpperCase(), email: 'khalid.preview@example.test' }
  : { uid: 'uid-one', role: 'person_1', identityMode: 'D028_TARGET', dataMode: dataMode.toUpperCase(), email: 'waleed.preview@example.test' };

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;
  if (path === '/__health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('ok');
    return;
  }
  if (path === '/__preview-health') {
    response.writeHead(enabled ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(enabled ? 'ok' : 'preview-not-configured');
    return;
  }
  if (enabled && path === '/app-config.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`window.__PRIVATE_WORK_APP_CONFIG__ = { apiBaseUrl: '', s8ExportModuleUrl: '/assets/s8-export.mjs', getIdToken: async () => 'synthetic-phase6-preview-token', signOut: async () => {}, email: ${JSON.stringify(identity.email)}, phase6VisualPreview: true, phase6PreviewDataMode: ${JSON.stringify(identity.dataMode)} };`);
    return;
  }
  if (enabled && (path === '/private/ping' || path.startsWith('/api/'))) {
    if ((request.method || 'GET').toUpperCase() !== 'GET') {
      json(response, 409, { ok: false, code: 'PREVIEW_READ_ONLY' });
      return;
    }
    json(response, 200, { ok: true, data: dataFor(path, 'GET', identity) });
    return;
  }
  const relative = path === '/' ? 'index.html' : path.replace(/^\/assets\//, '').replace(/^\//, '');
  const target = normalize(join(root, relative));
  if (!target.startsWith(normalize(root))) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404); response.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  if (enabled) {
    console.log(`PHASE6_VISUAL_PREVIEW_URL = http://127.0.0.1:${port}/`);
    console.log(`PROFILE = ${profile === 'khalid' ? 'Khalid' : 'Waleed'}`);
    console.log(`DATA_MODE = ${dataMode.toUpperCase()}`);
    console.log('PRODUCTION_CLOUD_WRITE = NONE');
  }
});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
