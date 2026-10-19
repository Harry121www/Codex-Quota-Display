import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

function nativeFromPackage(root) {
  const platforms = {
    'win32-x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
    'win32-arm64': ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
    'darwin-x64': ['codex-darwin-x64', 'x86_64-apple-darwin'],
    'darwin-arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin'],
    'linux-x64': ['codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'linux-arm64': ['codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  };
  const target = platforms[`${process.platform}-${process.arch}`];
  if (!target) return null;
  let vendor = path.join(root, 'vendor');
  try {
    const require = createRequire(path.join(root, 'package.json'));
    vendor = path.join(path.dirname(require.resolve(`@openai/${target[0]}/package.json`)), 'vendor');
  } catch { /* Older CLI bundles the native binary itself. */ }
  const executable = path.join(vendor, target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  return existsSync(executable) ? executable : null;
}

export function findCodex(explicit) {
  if (explicit) {
    if (!existsSync(explicit) || /\.(cmd|ps1|bat|js)$/i.test(explicit)) {
      throw new Error('codexPath must point to the native Codex executable');
    }
    return explicit;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const native = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(native)) {
      const resolved = realpathSync(native);
      if (!resolved.endsWith('.js')) return resolved;
      const found = nativeFromPackage(path.dirname(path.dirname(resolved)));
      if (found) return found;
    }
    const found = nativeFromPackage(path.join(directory, 'node_modules', '@openai', 'codex'));
    if (found) return found;
  }
  throw new Error('Codex CLI not found. Install it or set codexPath in bridge/config.json.');
}

export class CodexRpc {
  constructor(executable) {
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.proc = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Drain stderr without logging account data or startup noise.
    this.proc.stderr.resume();
    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        // This bridge never starts agent turns or approves server requests.
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported by quota display' } });
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(`Codex RPC ${task.method} failed (code ${message.error.code})`));
      else task.resolve(message.result);
    });
    this.proc.on('error', () => this.fail(new Error('Cannot start Codex app-server')));
    this.proc.on('exit', () => this.fail(new Error('Codex app-server exited')));
    this.proc.stdin.on('error', () => this.fail(new Error('Codex connection closed')));
  }
  send(message) {
    if (this.closed) throw new Error('Codex connection closed');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeoutMs = 25000) {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'esp32_quota_display', title: 'ESP32 Quota Display', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  fail(error) {
    this.closed = true;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
  close() {
    this.fail(new Error('Codex connection closed'));
    this.lines.close();
    this.proc.kill();
  }
}
