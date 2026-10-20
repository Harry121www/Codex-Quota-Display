import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const runtimeDirectory = path.join(projectRoot, '.runtime');

export function configuredPort() {
  const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid bridge port.');
  return config.port;
}

export async function probeBridge(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/console`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return { kind: 'occupied' };
    const value = await response.json();
    if (value.bridge?.name === 'codex-quota-display' && Number.isSafeInteger(value.bridge.pid) && value.bridge.pid > 0) {
      return { kind: 'running', pid: value.bridge.pid, quotaStatus: value.quota?.status };
    }
    // Recognize earlier project versions without assuming ownership of their PID.
    if (value.quota?.bucket === 'codex' && value.device && value.theme) return { kind: 'running', quotaStatus: value.quota.status };
    return { kind: 'occupied' };
  } catch (error) {
    return { kind: error.cause?.code === 'ECONNREFUSED' ? 'absent' : 'occupied' };
  }
}

export async function startBridge({ port, directory = runtimeDirectory, serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url)), cwd = projectRoot, timeoutMs = 10000 } = {}) {
  const initial = await probeBridge(port);
  if (initial.kind === 'running') return { ...initial, alreadyRunning: true };
  if (initial.kind === 'occupied') throw new Error(`Port ${port} is occupied or not responding. Check the existing process before retrying.`);
  mkdirSync(directory, { recursive: true });
  const stdoutPath = path.join(directory, 'bridge.stdout.log');
  const stderrPath = path.join(directory, 'bridge.stderr.log');
  const stdout = openSync(stdoutPath, 'a');
  const stderr = openSync(stderrPath, 'a');
  let child, exited = false, spawnError;
  try {
    child = spawn(process.execPath, [serverPath], {
      cwd, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
    child.once('error', error => { spawnError = error; exited = true; });
    child.once('exit', () => { exited = true; });
    child.unref();
  } finally { closeSync(stdout); closeSync(stderr); }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await probeBridge(port);
    if (current.kind === 'running') {
      if (current.pid) writeFileSync(path.join(directory, 'bridge.pid'), String(current.pid) + '\n');
      return { ...current, alreadyRunning: false };
    }
    if (exited) {
      const detail = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8').trim().split(/\r?\n/).slice(-5).join('\n') : '';
      throw new Error(`Bridge exited during startup. ${spawnError?.message ?? detail}\nLog: ${stderrPath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Bridge did not become ready. Check ${stderrPath}`);
}

export async function stopBridge({ port, directory = runtimeDirectory } = {}) {
  const current = await probeBridge(port);
  if (current.kind === 'absent') return false;
  const pidPath = path.join(directory, 'bridge.pid');
  const recorded = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : null;
  if (current.kind !== 'running' || !current.pid || current.pid !== recorded || current.pid === process.pid) {
    throw new Error('Cannot verify ownership of the running bridge. Stop it from its original terminal.');
  }
  if (process.platform === 'win32') {
    // Include the app-server child; only kill the PID verified by the local bridge and PID file.
    const result = spawnSync('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Could not stop the bridge.');
  } else {
    process.kill(-current.pid, 'SIGTERM');
  }
  for (let i = 0; i < 30; i++) {
    const state = await probeBridge(port);
    if (state.kind === 'absent') { unlinkSync(pidPath); return true; }
    if (state.kind === 'running' && state.pid !== current.pid) throw new Error('A different bridge started; leaving it running.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Bridge shutdown could not be confirmed.');
}
