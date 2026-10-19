import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, quotaView } from '../quota.mjs';
import { createQuotaServer } from '../http.mjs';

test('uses Codex bucket and actual window durations, preserving zero quota', () => {
  const quota = normalizeQuota({ rateLimitsByLimitId: {
    other: { primary: { usedPercent: 1 } },
    codex: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 12.5, windowDurationMins: 10080 } },
  } });
  assert.deepEqual(quota.windows, [
    { name: 'primary', remainingPercent: 0, windowMinutes: 300, resetsAt: 1800000000 },
    { name: 'secondary', remainingPercent: 87.5, windowMinutes: 10080, resetsAt: null },
  ]);
});

test('legacy response, nullable windows and out-of-range percentages', () => {
  assert.equal(normalizeQuota({ rateLimits: { primary: null, secondary: { usedPercent: 105 } } }).windows[0].remainingPercent, 0);
  assert.equal(normalizeQuota({ rateLimits: { primary: { usedPercent: -5 } } }).windows[0].remainingPercent, 100);
  for (const result of [{}, { rateLimits: { primary: { usedPercent: null } } }, { rateLimits: { limitId: 'other', primary: { usedPercent: 20 } } }]) {
    assert.throws(() => normalizeQuota(result));
  }
});

test('unavailable and stale data never masquerade as live quota', () => {
  const quota = normalizeQuota({ rateLimits: { primary: { usedPercent: 25 } } });
  assert.equal(quotaView({ quota: null, updatedAt: null }, 180, 200000).status, 'unavailable');
  const state = { quota, updatedAt: 10000, failed: false };
  assert.equal(quotaView(state, 180, 20000).status, 'ok');
  assert.equal(quotaView(state, 180, 190000).status, 'stale');
  assert.equal(quotaView({ ...state, failed: true }, 180, 20000).status, 'stale');
});

test('HTTP requires device token and exposes only normalized quota', async () => {
  const config = { deviceToken: 'a'.repeat(48), staleSeconds: 180 };
  const state = { quota: normalizeQuota({ rateLimits: { primary: { usedPercent: 25 } }, secret: 'do-not-expose' }), updatedAt: Date.now() };
  const server = createQuotaServer(config, state);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/quota')).status, 401);
    const headers = { Authorization: `Bearer ${config.deviceToken}` };
    const response = await fetch(base + '/api/quota', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('content-length')) > 0);
    const body = await response.json();
    assert.equal(body.windows[0].remainingPercent, 75);
    assert.equal(body.secret, undefined);
    assert.equal((await fetch(base + '/unknown', { headers })).status, 404);
    assert.equal((await fetch(base + '/api/quota', { headers, method: 'POST' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
