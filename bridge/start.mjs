import { configuredPort, startBridge, runtimeDirectory } from './launcher.mjs';

try {
  const port = configuredPort();
  const result = await startBridge({ port });
  console.log(result.alreadyRunning ? 'Codex Quota Display is already running.' : 'Codex Quota Display started in the background.');
  console.log('You can close this window. Updates will continue.');
  console.log(`Console: http://127.0.0.1:${port}`);
  console.log(`Logs: ${runtimeDirectory}`);
  console.log('To stop: run stop-bridge.cmd');
  if (result.quotaStatus !== 'ok') console.log('Waiting for quota; failed requests are retried automatically. See the logs for details.');
} catch (error) {
  console.error(`Start failed: ${error.message}`);
  process.exitCode = 1;
}
