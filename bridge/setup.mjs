import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const configUrl = new URL('./config.json', import.meta.url);
const firmwareUrl = new URL('../firmware/CodexQuota/config.h', import.meta.url);
if (existsSync(configUrl) || existsSync(firmwareUrl)) {
  console.error('Setup stopped: existing config.json or config.h found; edit it directly. No files overwritten.');
  process.exitCode = 1;
} else {
  const addresses = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address)).map(x => x.address);
  const config = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url), 'utf8'));
  config.deviceToken = randomBytes(24).toString('hex');
  const host = addresses[0] ?? 'YOUR_PC_LAN_IP';
  const firmware = readFileSync(new URL('../firmware/CodexQuota/config.example.h', import.meta.url), 'utf8')
    .replace('YOUR_PC_LAN_IP', host).replace('REPLACE_WITH_RANDOM_DEVICE_TOKEN', config.deviceToken);
  writeFileSync(configUrl, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(firmwareUrl, firmware, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${fileURLToPath(configUrl)} and ${fileURLToPath(firmwareUrl)}.`);
  console.log(`LAN addresses: ${addresses.join(', ') || '(none detected)'}. Verify the selected IP in config.h.`);
  console.log('Next: enter Wi-Fi credentials and confirm the screen settings in config.h.');
}
