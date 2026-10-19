import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createDisplayStore, IMAGE_SIZE } from '../display.mjs';
import { createQuotaServer } from '../http.mjs';
import { SIDE, encode565, decode565, fitRect } from '../public/image-utils.js';

test('image conversion uses the same RGB565 little-endian pixels as the firmware', () => {
  const pixels = new Uint8ClampedArray(SIDE * SIDE * 4);
  pixels.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const bytes = encode565(pixels);
  assert.equal(bytes.length, IMAGE_SIZE);
  assert.deepEqual([...bytes.slice(0, 8)], [0, 248, 224, 7, 31, 0, 255, 255]);
  assert.deepEqual([...decode565(bytes).slice(0, 16)], [...pixels.slice(0, 16)]);
  assert.throws(() => decode565(bytes.slice(1)));
});

test('wide and tall pictures retain aspect ratio when fitted or cropped', () => {
  assert.deepEqual(fitRect(480, 240), { x: 0, y: 60, width: 240, height: 120 });
  assert.deepEqual(fitRect(480, 240, 'cover'), { x: -120, y: 0, width: 480, height: 240 });
  assert.deepEqual(fitRect(240, 480), { x: 60, y: 0, width: 120, height: 240 });
});

test('image and mode survive a service restart; invalid updates preserve the image', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codex-display-'));
  const file = path.join(directory, 'display.json');
  try {
    const store = createDisplayStore(file);
    assert.deepEqual(store.get(), { mode: 'quota', image: null });
    assert.throws(() => store.setMode({ mode: 'image' }));
    const pixels = Buffer.alloc(IMAGE_SIZE, 0x5a);
    const first = store.upload(pixels);
    pixels[0] = 0;
    assert.equal(store.image()[0], 0x5a);
    assert.deepEqual(createDisplayStore(file).get(), first);
    assert.equal(store.upload(Buffer.alloc(IMAGE_SIZE, 0x5a)).image.revision, first.image.revision);
    assert.throws(() => store.upload(Buffer.alloc(IMAGE_SIZE - 1)));
    assert.throws(() => store.setMode({ mode: 'video' }));
    assert.throws(() => store.setMode({ mode: 'image', extra: true }));
    store.setMode({ mode: 'quota' });
    const restored = createDisplayStore(file);
    assert.equal(restored.get().mode, 'quota');
    assert.equal(restored.get().image.revision, first.image.revision);
    assert.deepEqual(restored.image(), Buffer.alloc(IMAGE_SIZE, 0x5a));
    restored.setMode({ mode: 'image' });
    assert.equal(createDisplayStore(file).get().mode, 'image');
  } finally { if (existsSync(file)) unlinkSync(file); rmdirSync(directory); }
});

test('failed disk write leaves the active display unchanged', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codex-display-'));
  const store = createDisplayStore(path.join(directory, 'missing', 'display.json'));
  try {
    assert.throws(() => store.upload(Buffer.alloc(IMAGE_SIZE)));
    assert.deepEqual(store.get(), { mode: 'quota', image: null });
  } finally { rmdirSync(directory); }
});

test('console uploads and switches modes; authenticated device gets exact image without quota', async () => {
  const token = 'd'.repeat(48);
  const server = createQuotaServer({ deviceToken: token, staleSeconds: 180 }, { quota: null, updatedAt: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'X-Console-Request': '1', 'Content-Type': 'application/octet-stream' };
  const auth = { Authorization: `Bearer ${token}`, 'X-Display-Protocol': '3' };
  const pixels = Buffer.alloc(IMAGE_SIZE, 0x9c);
  try {
    assert.equal((await fetch(base + '/api/console/image')).status, 404);
    assert.equal((await fetch(base + '/api/display', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"mode":"image"}' })).status, 422);
    const uploaded = await fetch(base + '/api/console/image', { method: 'PUT', headers, body: pixels });
    assert.equal(uploaded.status, 200);
    const { display } = await uploaded.json();
    assert.equal(display.mode, 'image');
    const manifest = await (await fetch(base + '/api/quota', { headers: auth })).json();
    assert.equal(manifest.status, 'unavailable');
    assert.deepEqual(manifest.display, display);
    assert.ok(JSON.stringify(manifest).length < 4096);
    const image = await fetch(base + '/api/image?revision=' + display.image.revision, { headers: auth });
    assert.equal(image.status, 200);
    assert.equal(Number(image.headers.get('content-length')), IMAGE_SIZE);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), pixels);
    assert.equal((await fetch(base + '/api/image?revision=old', { headers: auth })).status, 409);
    const consoleView = await (await fetch(base + '/api/console')).json();
    assert.equal(consoleView.device.supportsImages, true);
    assert.equal(consoleView.device.supportsTheme, true);
    assert.equal(JSON.stringify(consoleView).includes(token), false);
    assert.deepEqual(Buffer.from(await (await fetch(base + '/api/console/image?revision=' + display.image.revision)).arrayBuffer()), pixels);
    const switched = await fetch(base + '/api/display', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"mode":"quota"}' });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).display.mode, 'quota');
    assert.equal((await (await fetch(base + '/api/display')).json()).display.image.revision, display.image.revision);
    // Old firmware continues to receive quota/theme and is flagged for upgrade.
    await fetch(base + '/api/quota', { headers: { ...auth, 'X-Display-Protocol': '2' } });
    assert.equal((await (await fetch(base + '/api/console')).json()).device.supportsImages, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('image endpoints reject cross-origin, rebinding, invalid lengths and missing auth', async () => {
  const server = createQuotaServer({ deviceToken: 'e'.repeat(48), staleSeconds: 180 }, { quota: null, updatedAt: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'X-Console-Request': '1', 'Content-Type': 'application/octet-stream' };
  try {
    for (const bad of [{ ...headers, Origin: 'http://other.example' }, { ...headers, 'X-Console-Request': '' }]) {
      assert.equal((await fetch(base + '/api/console/image', { method: 'PUT', headers: bad, body: Buffer.alloc(IMAGE_SIZE) })).status, 403);
    }
    const forged = await new Promise((resolve, reject) => {
      const call = request(base + '/api/console/image', { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); });
      call.on('error', reject); call.end();
    });
    assert.equal(forged, 403);
    assert.equal((await fetch(base + '/api/image')).status, 401);
    assert.equal((await fetch(base + '/api/console/image', { method: 'PUT', headers, body: Buffer.alloc(IMAGE_SIZE - 1) })).status, 422);
    assert.equal((await fetch(base + '/api/console/image', { method: 'PUT', headers, body: Buffer.alloc(IMAGE_SIZE + 1) })).status, 413);
    assert.equal((await fetch(base + '/api/console/image', { method: 'PUT', headers: { ...headers, 'Content-Type': 'image/png' }, body: Buffer.alloc(IMAGE_SIZE) })).status, 415);
    assert.equal((await (await fetch(base + '/api/display')).json()).display.image, null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
