import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { quotaView } from './quota.mjs';
import { createThemeStore } from './theme.mjs';
import { createDisplayStore, IMAGE_SIZE } from './display.mjs';
import { normalizeTheme, paletteHex, palette565 } from './public/theme-utils.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/console.js', ['console.js', 'text/javascript; charset=utf-8']],
  ['/theme-utils.js', ['theme-utils.js', 'text/javascript; charset=utf-8']],
  ['/image-utils.js', ['image-utils.js', 'text/javascript; charset=utf-8']],
].map(([route, [file, type]]) => [route, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]));

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function localConsoleRequest(request) {
  const host = request.headers.host?.toLowerCase();
  const port = request.socket.localPort;
  return isLoopback(request.socket.remoteAddress) &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

function send(response, status, value, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(type.startsWith('application/json') ? JSON.stringify(value) : value);
  response.writeHead(status, {
    'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  response.end(body);
}

function readBody(request, limit = 4096, json = true) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    request.on('data', chunk => {
      length += chunk.length;
      if (length <= limit) chunks.push(chunk);
      else chunks.length = 0;
    });
    request.on('error', reject);
    request.on('end', () => {
      if (length > limit) { reject(Object.assign(new Error('request_too_large'), { status: 413 })); return; }
      try { resolve(json ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : Buffer.concat(chunks)); }
      catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); }
    });
  });
}

export function createQuotaServer(config, state, { themeStore = createThemeStore(), displayStore = createDisplayStore() } = {}) {
  const expected = Buffer.from(`Bearer ${config.deviceToken}`);
  const device = { lastSeenAt: null, supportsTheme: false, supportsImages: false };
  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname;
    if (assets.has(route) || ['/api/console', '/api/settings', '/api/display', '/api/console/image'].includes(route)) {
      if (!localConsoleRequest(request)) { send(response, 403, { error: 'local_console_only' }); return; }
      if (assets.has(route)) {
        if (request.method !== 'GET') { send(response, 405, { error: 'method_not_allowed' }); return; }
        const asset = assets.get(route);
        send(response, 200, asset.body, asset.type); return;
      }
      if (request.method === 'GET') {
        if (route === '/api/console/image') {
          const pixels = displayStore.image();
          if (!pixels) { send(response, 404, { error: 'no_image' }); return; }
          if (url.searchParams.has('revision') && url.searchParams.get('revision') !== displayStore.get().image.revision) { send(response, 409, { error: 'image_changed' }); return; }
          send(response, 200, pixels, 'application/octet-stream'); return;
        }
        if (route === '/api/display') { send(response, 200, { display: displayStore.get() }); return; }
        const theme = themeStore.get();
        const result = { theme, palette: paletteHex(theme) };
        if (route === '/api/console') Object.assign(result, {
          bridge: { name: 'codex-quota-display', pid: process.pid },
          quota: quotaView(state, config.staleSeconds), device: { ...device }, display: displayStore.get(),
        });
        send(response, 200, result); return;
      }
      if (request.method !== 'PUT' || !['/api/settings', '/api/display', '/api/console/image'].includes(route)) {
        send(response, 405, { error: 'method_not_allowed' }); return;
      }
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-console-request'] !== '1') {
        send(response, 403, { error: 'invalid_origin' }); return;
      }
      if (route === '/api/console/image') {
        if (request.headers['content-type'] !== 'application/octet-stream') { send(response, 415, { error: 'binary_image_required' }); return; }
        const pixels = await readBody(request, IMAGE_SIZE, false);
        if (pixels.length !== IMAGE_SIZE) { send(response, 422, { error: 'invalid_image_size' }); return; }
        send(response, 200, { display: displayStore.upload(pixels) }); return;
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        send(response, 415, { error: 'json_required' }); return;
      }
      const body = await readBody(request);
      if (route === '/api/display') {
        if (!body || Object.keys(body).length !== 1 || !['quota', 'image'].includes(body.mode) || (body.mode === 'image' && !displayStore.get().image)) {
          send(response, 422, { error: '请先上传图片，并选择额度或图片模式' }); return;
        }
        send(response, 200, { display: displayStore.setMode(body) }); return;
      }
      let theme;
      try { theme = normalizeTheme(body); }
      catch (error) { send(response, 422, { error: error.message }); return; }
      try { theme = themeStore.set(theme); }
      catch { send(response, 500, { error: '主题保存失败，请检查文件写入权限' }); return; }
      send(response, 200, { theme, palette: paletteHex(theme) }); return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(response, 401, { error: 'unauthorized' }); return;
    }
    if (request.method !== 'GET' || !['/api/quota', '/api/image'].includes(route)) {
      send(response, 404, { error: 'not_found' }); return;
    }
    const protocol = request.headers['x-display-protocol'];
    if (protocol === '2' || protocol === '3' || !isLoopback(request.socket.remoteAddress)) {
      device.lastSeenAt = Date.now();
      device.supportsTheme = protocol === '2' || protocol === '3';
      device.supportsImages = protocol === '3';
    }
    if (route === '/api/image') {
      const pixels = displayStore.image();
      if (!pixels) { send(response, 404, { error: 'no_image' }); return; }
      if (url.searchParams.get('revision') !== displayStore.get().image.revision) { send(response, 409, { error: 'image_changed' }); return; }
      send(response, 200, pixels, 'application/octet-stream'); return;
    }
    send(response, 200, { ...quotaView(state, config.staleSeconds), theme: palette565(themeStore.get()), display: displayStore.get() });
  }
  return createServer({ requestTimeout: 10000 }, (request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent) send(response, error.status ?? 500, { error: error.status ? error.message : 'internal_error' });
      else response.end();
    });
  });
}
