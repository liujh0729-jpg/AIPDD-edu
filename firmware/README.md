# 智能硬件（ESP32-S3）参考固件

打通「电脑端智能硬件模式（F10）」端到端的最小可烧录固件示例。

- 协议契约：见本目录 [`PROTOCOL.md`](./PROTOCOL.md)（主机侧实现 `app/src/main/hardware.js`）。
- 参考固件：[`dt_esp32_reference/dt_esp32_reference.ino`](./dt_esp32_reference/dt_esp32_reference.ino)

## 它做什么
1. 连 WiFi（STA）。
2. 每 2s 广播 **UDP 信标**（`dt-esp32`）到 `:48000`，供电脑端发现。
3. 起 **WebSocket 服务端**（`:80`）；电脑端连入后设备上报 `hello`（含能力位 📷🎤🔊），主机 `auth` 校验 token。
4. 依主机 `stream` 指令：摄像头回传 JPEG（`0x01`）、麦克风连续回传 PCM16/16k（`0x02`）。
5. 接收主机 `cmd` 远程控制并回 `ack`（开始上课/下课/抓拍/音量/静音/提示音/休眠/重启/查询）。
6. 接收主机 `play_begin/0x03 chunk/play_end`，经 I2S 功放播放 TTS；**播放期间暂停麦克风上行（半双工）**。

> 唤醒/VAD/STT/LLM/TTS 全部在电脑端完成，设备侧**不做 AI、不发起任何计费请求**。

## 依赖库（PlatformIO / Arduino IDE 库管理器）
- `Links2004/WebSockets`
- `bblanchon/ArduinoJson` (v6)
- `esp32-camera`（随 ESP32 Arduino core）
- `driver/i2s`（core 内置）

## 硬件前提
- ESP32-S3 + OV2640 摄像头 + PDM/I2S 麦克风 + I2S 功放（如 MAX98357A）+ 喇叭。
- **引脚**：`.ino` 顶部按 XIAO ESP32S3 Sense 示例给了一套，请按你的实际板型改 `CAM_PIN_*` / `MIC_PIN_*` / `SPK_PIN_*`。

## 安全（务必遵守）
- `WIFI_SSID` / `WIFI_PASS` / `AUTH_TOKEN` **不得写死进固件与仓库**；应由配网门户（如 WiFiManager）写入 **NVS**，固件运行时读取（代码里已留 TODO）。
- 仅局域网；不开公网；日志不打印明文 token。

## 烧录（示例）
```bash
# PlatformIO（需自备 platformio.ini，board 例：esp32-s3-devkitc-1）
pio run -t upload && pio device monitor
```
烧录后，在电脑端 App「智能硬件」Tab 点“扫描设备”，应能看到本设备；输入配对 token 连接即可。

## 与主机联调（无硬件时）
主机侧协议可用 Node 版 mock 设备验证（发现→连接鉴权→图像/音频上行→远程控制→TTS 下放）。开发期已用一次性脚本跑通，未随仓库保留；如需可再生成。
