import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createThemeStore } from '../theme.mjs';
import { DEFAULT_THEME, rgb565 } from '../public/theme-utils.js';
import { createQuotaServer } from '../http.mjs';

test('theme persists across restart and failed validation preserves the saved palette', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codex-theme-'));
  const file = path.join(directory, 'theme.json');
  try {
    const store = createThemeStore(file);
    assert.deepEqual(store.get(), DEFAULT_THEME);
    store.set({ accent: '#61c8ff', background: '#080808' });
    assert.equal(createThemeStore(file).get().accent, '#61C8FF');
    for (const value of [{ accent: 'red', background: '#080808' }, { accent: '#FFFF00' }, { accent: '#FFFF00', background: '#080808', deviceToken: 'must-not-write' }, null]) {
      assert.throws(() => store.set(value));
    }
    assert.equal(createThemeStore(file).get().accent, '#61C8FF');
    store.set({ ...DEFAULT_THEME });
    assert.deepEqual(createThemeStore(file).get(), DEFAULT_THEME);
  } finally {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(directory);
  }
});

test('RGB565 matches the physical display color format', () => {
  assert.equal(rgb565('#FFFF00'), 0xFFE0);
  assert.equal(rgb565('#080808'), 0x0841);
  assert.equal(rgb565('#FFFFFF'), 0xFFFF);
  assert.equal(rgb565('#FF0000'), 0xF800);
});

test('local console saves a theme and authenticated device receives it even without quota', async () => {
  const token = 'b'.repeat(48);
  const store = createThemeStore();
  const server = createQuotaServer({ deviceToken: token, staleSeconds: 180 }, { quota: null, updatedAt: null }, { themeStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Console-Request': '1', Origin: base };
  try {
    assert.equal((await fetch(base)).status, 200);
    const initial = await (await fetch(base + '/api/console')).json();
    assert.deepEqual(initial.theme, DEFAULT_THEME);
    assert.equal(JSON.stringify(initial).includes(token), false);
    const chosen = { accent: '#54E3B5', background: '#111827' };
    const put = await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify(chosen) });
    assert.equal(put.status, 200);
    const response = await fetch(base + '/api/quota', { headers: { Authorization: `Bearer ${token}`, 'X-Display-Protocol': '2' } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'unavailable');
    assert.equal(payload.theme.accent, rgb565(chosen.accent));
    assert.equal(payload.theme.background, rgb565(chosen.background));
    assert.ok(Number(response.headers.get('content-length')) < 4096);
    const consoleData = await (await fetch(base + '/api/console')).json();
    assert.ok(consoleData.device.lastSeenAt);
    assert.equal(consoleData.device.supportsTheme, true);
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers, body: '{' })).status, 400);
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ ...chosen, accent: '#123' }) })).status, 422);
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ ...chosen, accent: 'x'.repeat(5000) }) })).status, 413);
    assert.deepEqual(store.get(), chosen);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('console rejects cross-origin writes, rebinding hosts and missing device credentials', async () => {
  const server = createQuotaServer({ deviceToken: 'c'.repeat(48), staleSeconds: 180 }, { quota: null, updatedAt: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify(DEFAULT_THEME);
    const headers = { 'Content-Type': 'application/json', 'X-Console-Request': '1', Origin: 'https://unrelated.example' };
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers, body })).status, 403);
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers: { ...headers, Origin: base, 'X-Console-Request': '' }, body })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const call = request(base + '/api/console', { headers: { Host: 'unrelated.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      call.on('error', reject); call.end();
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(base + '/api/quota')).status, 401);
    assert.deepEqual((await (await fetch(base + '/api/settings')).json()).theme, DEFAULT_THEME);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
