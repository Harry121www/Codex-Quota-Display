function windowData(value, name) {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null;
  const minutes = value.windowDurationMins;
  const reset = value.resetsAt;
  return {
    name,
    remainingPercent: Math.max(0, Math.min(100, 100 - value.usedPercent)),
    windowMinutes: typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset : null,
  };
}

export function normalizeQuota(result) {
  // Never substitute an unrelated model bucket for the general Codex bucket.
  const bucket = result?.rateLimitsByLimitId?.codex ??
    (!result?.rateLimits?.limitId || result.rateLimits.limitId === 'codex' ? result?.rateLimits : null);
  if (!bucket) throw new Error('No general Codex quota bucket returned');
  const windows = [windowData(bucket.primary, 'primary'), windowData(bucket.secondary, 'secondary')].filter(Boolean);
  if (!windows.length) throw new Error('No usable Codex quota windows returned');
  return { bucket: 'codex', windows };
}

export function quotaView(state, staleSeconds, now = Date.now()) {
  const ageSeconds = state.updatedAt === null ? null : Math.max(0, Math.floor((now - state.updatedAt) / 1000));
  return {
    status: !state.quota ? 'unavailable' : state.failed || ageSeconds >= staleSeconds ? 'stale' : 'ok',
    serverTime: Math.floor(now / 1000),
    updatedAt: state.updatedAt === null ? null : Math.floor(state.updatedAt / 1000),
    ageSeconds,
    bucket: 'codex',
    windows: state.quota?.windows ?? [],
  };
}
