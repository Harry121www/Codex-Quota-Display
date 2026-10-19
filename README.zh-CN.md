# Codex Quota Display

用 ESP32-C3 桌面小屏幕显示 Codex 订阅剩余额度，并在电脑控制台修改配色或上传图片。

[English](README.md) · 简体中文

## 功能

- 额度窗口、剩余百分比、进度条和重置倒计时。
- 电脑每 60 秒读取额度，ESP32 每 15 秒通过 Wi-Fi 获取数据。
- 本机网页控制台提供配色、背景色、预览和额度／图片模式切换。
- 支持不超过 12 MB 的 PNG、JPG、WebP 静态图片，自动适配 240×240，可完整显示或居中裁切。
- 主题、图片和模式保存在电脑上；局部刷新，相同图片不会反复重画。

服务通过已登录的 Codex CLI app-server 调用 `account/rateLimits/read`，不创建聊天或发送模型推理请求，不需要 OpenAI API Key。这是独立项目，并非 OpenAI 官方产品。

```text
Codex CLI → 电脑上的 Node.js 桥接服务 → Wi-Fi → ESP32-C3 + ST7789
                        ↑
                   本机网页控制台
```

更新期间需要电脑保持唤醒并运行桥接服务。ESP32 使用 2.4GHz Wi-Fi；电脑可通过同一互通局域网中的 5GHz 或网线连接。USB 用于烧录和供电。

## 硬件与接线

- ESP32-C3 SuperMini 开发板。
- 1.54 英寸、240×240、8 针 SPI 接口的 ST7789 屏幕。
- 连接线和 USB 数据线。

先断电，再按引脚名称连接。下表是 **GPIO 编号**，不是排针顺序；接线参考 [Clawd Mochi](https://github.com/yousifamanuel/clawd-mochi)。

| ST7789 标注 | ESP32-C3 SuperMini |
| --- | --- |
| GND | GND |
| VCC | 3V3 |
| SCL / SCK / CLK | GPIO8 |
| SDA / DIN / MOSI | GPIO10 |
| DC / A0 | GPIO1 |
| CS | GPIO4 |
| RES / RST | GPIO2 |
| BL / BLK | GPIO3，高电平开启背光 |

这里的 SDA 是 SPI 数据线，不是 I²C。默认 240×240、旋转 `3`、SPI mode `0`、开启反色。不同面板需在生成的 `config.h` 中调整。

## 安装

### 1. 配置电脑端

安装 Node.js 20+ 和 [Codex CLI](https://github.com/openai/codex)，用 `codex login` 登录 ChatGPT 账户。项目读取 CLI 当前账户的额度，可能与桌面应用的登录账户不同。

```sh
git clone https://github.com/Harry121www/Codex-Quota-Display.git
cd Codex-Quota-Display
node bridge/setup.mjs
```

初始化生成 `bridge/config.json` 和 `firmware/CodexQuota/config.h`，写入相同的随机设备口令。只要任一配置文件已存在，初始化就会停止，不会覆盖。电脑端仅使用 Node.js 内置模块，无需 `npm install`。

编辑 `firmware/CodexQuota/config.h`：

| 配置 | 内容 |
| --- | --- |
| `WIFI_SSID` | 2.4GHz Wi-Fi 名称 |
| `WIFI_PASSWORD` | Wi-Fi 密码 |
| `QUOTA_URL` | `http://电脑局域网IP:8765/api/quota` |
| `DEVICE_TOKEN` | 保留生成值，与 `bridge/config.json` 一致 |

核对自动选取的 IP，尤其是有 VPN 或虚拟网卡的电脑。ESP32 配置中不能填 `localhost`。建议在路由器为电脑保留 DHCP 地址，避免 IP 变化。

检查账户连接，再启动服务：

```sh
node bridge/server.mjs --check
node bridge/server.mjs
```

Windows 也可双击 `start-bridge.cmd`，并保持窗口开启。关闭窗口、停止进程或电脑休眠会中断更新。默认监听 `0.0.0.0:8765`，ESP32 需要能访问该端口。

### 2. 烧录固件

在 Arduino IDE 中：

1. 安装 Espressif Systems 的 **esp32** 开发板包。
2. 选择 **ESP32C3 Dev Module**，将 **USB CDC On Boot** 设为 **Enabled**，选择开发板串口。目标 SuperMini 使用 4 MB 闪存，请核对自己的开发板。
3. 安装 **Adafruit GFX Library**、**Adafruit ST7735 and ST7789 Library**、**ArduinoJson 7.x** 及其依赖。
4. 打开 `firmware/CodexQuota/CodexQuota.ino`，编译并上传。

无法进入下载模式时，按住 BOOT，点按 RESET，再松开 BOOT 后重试。从旧版升级需要重新烧录一次以支持图片；之后换颜色、上传图片均通过 Wi-Fi 完成。

### 3. 使用控制台

在桥接电脑打开 **[http://127.0.0.1:8765](http://127.0.0.1:8765)**；Windows 也可双击 `open-console.cmd`。

- **配色：**选择颜色，点击“保存并同步”。
- **图片：**选择 PNG、JPG 或 WebP 静态图片，选择完整显示或居中裁切，预览后点击“上传并显示”。
- **切换：**点击“订阅额度”或“我的图片”，自动保存模式，不删除已上传图片。

通常在下一次 15 秒轮询时同步。图片全屏显示，不叠加额度文字。透明区域和完整显示的留边使用上传时的背景色，需要重新上传才能改变。不支持动态图片、视频或轮播。

主题保存在 `bridge/theme.json`，图片和模式保存在 `bridge/display.json`，重启服务后保留。短暂断网时保留当前图片；ESP32 断电重启后，需要电脑服务在线才能重新获取图片。

## 常见问题

| 提示／现象 | 检查项 |
| --- | --- |
| `WiFi offline` / `Connecting to WiFi` | 2.4GHz 网络、名称、密码、信号及供电 |
| `WiFi: AP not found` | Wi-Fi 名称和 2.4GHz 覆盖 |
| `WiFi: auth failed` / `handshake timeout` | 密码与路由器兼容设置 |
| `WiFi: waiting for IP` | 路由器 DHCP |
| `Bridge unreachable` | 电脑服务、局域网 IP、8765 端口、防火墙及客户端隔离；Wi-Fi 可能已经连接正常 |
| `Check device token` | 两个配置文件的设备口令是否一致 |
| `STALE - last known` | 正保留旧数据，检查电脑服务与网络 |
| `No quota data` / `Quota unavailable` | 运行 `node bridge/server.mjs --check`，检查 CLI 登录及账户是否返回额度 |
| `Awaiting refresh` | 重置时间已到，等待账户刷新 |
| 控制台提示需要更新程序 | 烧录一次最新固件 |
| 方向或颜色异常 | `config.h` 的 `TFT_ROTATION`、`TFT_INVERT`、`TFT_SPI_MODE` |

排查 Wi-Fi 时，打开串口监视器，设为 **115200 波特率**并点按 RESET。日志显示连接阶段和原因码，不输出 Wi-Fi 密码。剩余额度不超过 30% 时为橙色，不超过 10% 时为红色。

## 本地数据与访问

控制台仅允许本机访问，设备接口需要生成的设备口令。使用面向可信局域网的明文 HTTP，不要将端口暴露到公网。图片保存在桥接电脑，再发送到屏幕，不使用外部图床。

实际配置、图片、主题、工具、日志和编译产物已加入 Git 忽略规则。编译后的固件包含 Wi-Fi 密码和设备口令，请勿公开个人固件文件。

## 开发与验证

```sh
node --test bridge/test/*.test.mjs
```

14 项测试覆盖额度转换、过期状态、鉴权、主题与图片持久化、RGB565 字节序、适配裁切、模式切换和非法请求。固件已使用 ESP32 Arduino core 3.3.10、ArduinoJson 7.3.2 通过 ESP32-C3 编译；编译不能代替实物验证。

已在默认位置安装 Arduino CLI、开发板包和库时，可运行：

```sh
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/CodexQuota
```

```text
bridge/                    电脑服务、网页控制台与测试
firmware/CodexQuota/        Arduino 固件和示例配置
start-bridge.cmd           Windows 服务启动器
open-console.cmd           Windows 控制台启动器
```

## 参考

- [Codex CLI 与 app-server 文档](https://github.com/openai/codex)
- [Clawd Mochi](https://github.com/yousifamanuel/clawd-mochi)：引脚和背光接线参考。
- [Adafruit ST7735/ST7789 驱动库](https://github.com/adafruit/Adafruit-ST7735-Library)
- [ArduinoJson](https://github.com/bblanchon/ArduinoJson)
