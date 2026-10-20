# Codex Quota Display

Display your remaining Codex subscription quota on an ESP32-C3 desktop screen. Change colors or show your own images from a local web console.

English · [简体中文](README.zh-CN.md)

## Features

- Remaining percentages, progress bars, and reset countdowns for the quota windows returned by your account.
- Wi-Fi updates: the computer checks quota every 60 seconds; the display polls every 15 seconds.
- Local console with theme colors, background colors, live preview, and quota/image mode switching.
- PNG, JPG, and WebP image uploads, resized to 240×240 with contain or center-crop options.
- Themes and images saved on the computer; partial screen updates without repainting unchanged content.

The bridge calls `account/rateLimits/read` through the signed-in Codex CLI app server. It does not create chats or submit model inference requests. No OpenAI API key is needed. This independent project is not an official OpenAI product.

```text
Codex CLI → Node.js bridge on your computer → Wi-Fi → ESP32-C3 + ST7789
                     ↑
           Local browser console
```

The computer must stay awake with the bridge running to provide updates. ESP32 uses 2.4 GHz Wi-Fi; the computer can use Ethernet or 5 GHz on the same reachable LAN. USB is used for firmware uploads and power.

## Hardware and wiring

- ESP32-C3 SuperMini development board.
- 1.54-inch, 240×240 ST7789 display with an 8-pin SPI interface.
- Jumper wires and a USB cable.

Disconnect power before wiring. These are **GPIO numbers**, not physical header positions. Wiring follows [Clawd Mochi](https://github.com/yousifamanuel/clawd-mochi).

| ST7789 pin | ESP32-C3 SuperMini |
| --- | --- |
| GND | GND |
| VCC | 3V3 |
| SCL / SCK / CLK | GPIO8 |
| SDA / DIN / MOSI | GPIO10 |
| DC / A0 | GPIO1 |
| CS | GPIO4 |
| RES / RST | GPIO2 |
| BL / BLK | GPIO3, active HIGH |

`SDA` here means SPI data, not I²C. Defaults: 240×240, rotation `3`, SPI mode `0`, and inversion enabled. Adjust the generated `config.h` if your panel differs.

## Setup

### 1. Computer bridge

Install Node.js 20+ and the [Codex CLI](https://github.com/openai/codex). Sign in using `codex login`. Quota comes from the CLI's ChatGPT account, which may differ from your desktop app account.

```sh
git clone https://github.com/Harry121www/Codex-Quota-Display.git
cd Codex-Quota-Display
node bridge/setup.mjs
```

Setup creates `bridge/config.json` and `firmware/CodexQuota/config.h` with matching random device tokens. It refuses to overwrite either existing file. The bridge uses Node.js built-in modules; no `npm install` is required.

Edit `firmware/CodexQuota/config.h`:

| Setting | Value |
| --- | --- |
| `WIFI_SSID` | Your 2.4 GHz Wi-Fi name |
| `WIFI_PASSWORD` | Your Wi-Fi password |
| `QUOTA_URL` | `http://YOUR_PC_LAN_IP:8765/api/quota` |
| `DEVICE_TOKEN` | Keep the generated value; it must match `bridge/config.json` |

Verify the selected LAN address, especially with VPN or virtual adapters. Do not use `localhost` in the ESP32 configuration. A DHCP reservation helps keep the computer's address stable.

Check the account connection, then start the bridge:

```sh
node bridge/server.mjs --check
node bridge/server.mjs
```

On Windows, run `start-bridge.cmd` to start the bridge in the background. Once startup is confirmed, you can close the launcher window; repeated launches reuse the running service. Use `stop-bridge.cmd` to stop it. Logs are saved in `.runtime/bridge.stdout.log` and `.runtime/bridge.stderr.log`. You can also run `node bridge/start.mjs` from a terminal. The direct `node bridge/server.mjs` command runs in the foreground and stops when its terminal closes. Computer sleep still interrupts updates. The default listener is `0.0.0.0:8765`; the ESP32 must be able to reach that port.

### 2. Firmware

In Arduino IDE:

1. Install the **esp32** board package by Espressif Systems.
2. Select **ESP32C3 Dev Module**, set **USB CDC On Boot → Enabled**, and choose the board's serial port. The target SuperMini uses 4 MB flash; confirm your board's specification.
3. Install **Adafruit GFX Library**, **Adafruit ST7735 and ST7789 Library**, and **ArduinoJson 7.x**, including their dependencies.
4. Open `firmware/CodexQuota/CodexQuota.ino` and upload it.

If download mode fails, hold BOOT, press and release RESET, then release BOOT and retry. An older firmware needs one new upload to enable image support. Subsequent color changes and image uploads use Wi-Fi.

### 3. Web console

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)** on the bridge computer, or run `open-console.cmd` on Windows. The console currently uses Chinese labels.

- **Theme:** choose colors, then click **保存并同步** (Save and sync).
- **Image:** select a PNG, JPG, or WebP static image up to 12 MB, choose contain or center-crop, then click **上传并显示** (Upload and display).
- **Mode:** click **订阅额度** (Quota) or **我的图片** (My image). Mode changes save immediately and retain the uploaded image.

Changes normally arrive at the next 15-second poll. Images fill the screen without quota overlays. Transparent areas and contain-mode borders use the background color at upload time; re-upload to change those pixels. Animated images, video, and slideshows are not supported.

Themes are stored in `bridge/theme.json`; the image and mode are stored in `bridge/display.json`. Temporary outages leave the current image visible. After an ESP32 restart, the bridge must be online to download the image again.

## Troubleshooting

| Message / symptom | Check |
| --- | --- |
| `WiFi offline` / `Connecting to WiFi` | 2.4 GHz network, credentials, signal, and power |
| `WiFi: AP not found` | Configured SSID and 2.4 GHz coverage |
| `WiFi: auth failed` / `handshake timeout` | Password and router compatibility |
| `WiFi: waiting for IP` | Router DHCP service |
| `Bridge unreachable` | Bridge process, computer LAN IP, port 8765, firewall, and client isolation; Wi-Fi itself may already be connected |
| `Check device token` | Matching tokens in the two generated configuration files |
| `STALE - last known` | Last known quota is retained; check the computer and network |
| `No quota data` / `Quota unavailable` | Run `node bridge/server.mjs --check`; check CLI login and account quota availability |
| `Awaiting refresh` | A reported reset time has passed; waiting for new account data |
| Console requests a firmware update | Upload the latest sketch once |
| Wrong orientation or colors | `TFT_ROTATION`, `TFT_INVERT`, and `TFT_SPI_MODE` in `config.h` |

For Wi-Fi diagnostics, open the serial monitor at **115200 baud** and press RESET. Logs show connection stages and reason codes without the Wi-Fi password. Remaining quota at or below 30% is orange; at or below 10% it is red.

## Local data and access

The console is accessible only from the bridge computer. Device endpoints require the generated bearer token. Traffic uses unencrypted HTTP intended for a trusted LAN; do not expose the port to the internet. Images stay on the bridge computer and are sent to the display, without external image hosting.

Generated configurations, images, themes, tools, logs, and build outputs are excluded from Git. Compiled firmware contains your configured Wi-Fi password and device token, so do not publish personal firmware binaries.

## Development

```sh
node --test bridge/test/*.test.mjs
```

The 17 tests cover quota normalization, stale data, authentication, theme/image persistence, RGB565 byte order, image fitting, mode switching, invalid requests, background startup, duplicate launches, and verified shutdown. The firmware has compiled for ESP32-C3 with ESP32 Arduino core 3.3.10 and ArduinoJson 7.3.2; compilation does not replace physical display verification.

With Arduino CLI and the board package/libraries installed in their default locations:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/CodexQuota
```

```text
bridge/                    Node.js bridge, local console, and tests
firmware/CodexQuota/        Arduino sketch and example configuration
start-bridge.cmd           Windows bridge launcher
open-console.cmd           Windows console launcher
stop-bridge.cmd            Stop the background bridge
```

## References

- [Codex CLI and app-server documentation](https://github.com/openai/codex)
- [Clawd Mochi](https://github.com/yousifamanuel/clawd-mochi) — pin mapping and backlight wiring reference.
- [Adafruit ST7735/ST7789 library](https://github.com/adafruit/Adafruit-ST7735-Library)
- [ArduinoJson](https://github.com/bblanchon/ArduinoJson)
