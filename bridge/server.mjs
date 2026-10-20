import { readFileSync } from 'node:fs';
import { CodexRpc, findCodex } from './rpc.mjs';
import { normalizeQuota } from './quota.mjs';
import { createQuotaServer } from './http.mjs';
import { createThemeStore } from './theme.mjs';
import { createDisplayStore } from './display.mjs';
import { fileURLToPath } from 'node:url';

const checkOnly = process.argv.includes('--check');
let config;
try { config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')); }
catch { console.error('Run node bridge/setup.mjs first; config.json is missing or invalid.'); process.exit(1); }
if (!/^[a-f0-9]{48,128}$/i.test(config.deviceToken ?? '') ||
    !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
    !Number.isFinite(config.refreshSeconds) || config.refreshSeconds < 30 ||
    !Number.isFinite(config.staleSeconds) || config.staleSeconds < config.refreshSeconds ||
    typeof config.listenHost !== 'string' || !config.listenHost) {
  console.error('Invalid bridge config. Use setup.mjs defaults, a random hex token, and refreshSeconds >= 30.'); process.exit(1);
}
let executable;
try { executable = findCodex(config.codexPath); }
catch (error) { console.error(error.message); process.exit(1); }
const state = { quota: null, updatedAt: null, failed: false };
let rpc, timer, stopping = false;

async function refresh() {
  try {
    if (!rpc || rpc.closed) {
      rpc?.close();
      rpc = new CodexRpc(executable);
      await rpc.initialize();
    }
    state.quota = normalizeQuota(await rpc.request('account/rateLimits/read'));
    state.updatedAt = Date.now();
    state.failed = false;
    if (checkOnly) console.log(JSON.stringify(state.quota, null, 2));
    else console.log(`[${new Date().toLocaleTimeString()}] Quota updated (${state.quota.windows.length} windows).`);
  } catch (error) {
    state.failed = true;
    rpc?.close(); rpc = null;
    console.error(`[${new Date().toISOString()}] ${error.message}. Check Codex CLI login and network access.${checkOnly ? '' : ` Retrying in ${config.refreshSeconds}s.`}`);
    if (checkOnly) process.exitCode = 1;
  }
  if (!stopping && !checkOnly) timer = setTimeout(refresh, config.refreshSeconds * 1000);
}

if (checkOnly) {
  try { await refresh(); } finally { rpc?.close(); }
} else {
  let themeStore;
  try { themeStore = createThemeStore(fileURLToPath(new URL('./theme.json', import.meta.url))); }
  catch { console.error('Cannot load bridge/theme.json; check its accent/background hex colors.'); process.exit(1); }
  let displayStore;
  try { displayStore = createDisplayStore(fileURLToPath(new URL('./display.json', import.meta.url))); }
  catch { console.error('Cannot load bridge/display.json; check the saved display image.'); process.exit(1); }
  const server = createQuotaServer(config, state, { themeStore, displayStore });
  const stop = () => {
    stopping = true; clearTimeout(timer); rpc?.close(); server.close();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('error', error => { console.error(`HTTP server error: ${error.code}`); process.exitCode = 1; stop(); });
  server.listen(config.port, config.listenHost, () => {
    console.log(`Quota bridge listening at ${config.listenHost}:${config.port}/api/quota (Ctrl+C to stop).`);
    console.log(`Theme console: http://127.0.0.1:${config.port}`);
    void refresh();
  });
}
