import { configuredPort, stopBridge } from './launcher.mjs';

try {
  console.log(await stopBridge({ port: configuredPort() }) ? 'Codex Quota Display stopped.' : 'Codex Quota Display is not running.');
} catch (error) {
  console.error(`Stop failed: ${error.message}`);
  process.exitCode = 1;
}
