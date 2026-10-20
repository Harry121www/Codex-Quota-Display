import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { startBridge, stopBridge, probeBridge } from '../launcher.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function directory() { return mkdtempSync(path.join(tmpdir(), 'codex-launcher-')); }
function cleanup(folder) { for (const file of readdirSync(folder)) unlinkSync(path.join(folder, file)); rmdirSync(folder); }

test('background bridge survives launcher exit, duplicate start reuses it, and stop verifies ownership', async () => {
  const folder = directory(), port = await availablePort();
  const serverPath = path.join(folder, 'fixture.mjs');
  writeFileSync(serverPath, `import { createServer } from 'node:http';
    createServer((request, response) => { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({bridge:{name:'codex-quota-display',pid:process.pid},quota:{status:'ok'}})); }).listen(${port},'127.0.0.1',()=>console.log('fixture listening'));`);
  const options = { port, directory: folder, serverPath };
  try {
    const script = `import { startBridge } from ${JSON.stringify(new URL('../launcher.mjs', import.meta.url).href)}; console.log(JSON.stringify(await startBridge(${JSON.stringify(options)})));`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
      child.on('error', reject);
      child.on('exit', code => { if (code) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
    assert.equal(result.alreadyRunning, false);
    assert.equal((await probeBridge(port)).pid, result.pid);
    const duplicate = await startBridge(options);
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(duplicate.pid, result.pid);
    assert.match(readFileSync(path.join(folder, 'bridge.stdout.log'), 'utf8'), /fixture listening/);
    writeFileSync(path.join(folder, 'bridge.pid'), String(result.pid + 1));
    await assert.rejects(stopBridge(options), /ownership/);
    assert.equal((await probeBridge(port)).kind, 'running');
    writeFileSync(path.join(folder, 'bridge.pid'), String(result.pid));
    assert.equal(await stopBridge(options), true);
    assert.equal((await probeBridge(port)).kind, 'absent');
    assert.equal(await stopBridge(options), false);
  } finally {
    const live = await probeBridge(port);
    if (live.kind === 'running' && live.pid) { writeFileSync(path.join(folder, 'bridge.pid'), String(live.pid)); await stopBridge(options); }
    cleanup(folder);
  }
});

test('launcher refuses a port owned by another service', async () => {
  const server = createServer((request, response) => response.end('{}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(startBridge({ port: server.address().port }), /occupied/); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('failed server startup is reported instead of showing a false success', async () => {
  const folder = directory(), port = await availablePort();
  const serverPath = path.join(folder, 'failure.mjs');
  writeFileSync(serverPath, "console.error('fixture startup error'); process.exitCode = 1;");
  try {
    await assert.rejects(startBridge({ port, directory: folder, serverPath }), /fixture startup error/);
    assert.equal((await probeBridge(port)).kind, 'absent');
  } finally { cleanup(folder); }
});
