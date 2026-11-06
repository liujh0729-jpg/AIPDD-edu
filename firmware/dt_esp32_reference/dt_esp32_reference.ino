/*
 * 智能硬件（ESP32-S3）参考固件 · DeepTutor 家教外设
 * 对应协议：firmware/PROTOCOL.md（v1）；主机实现：app/src/main/hardware.js
 *
 * 角色：设备 = WebSocket 服务端 + 薄 IO/执行器。图像/麦克风回传给主机；主机做唤醒/VAD/STT/LLM/TTS 与网关调用。
 *       设备绝不调用任何模型/计费接口；仅局域网；token 配网注入、不硬编码。
 *
 * 依赖库（Arduino/PlatformIO）：
 *   - Links2004 WebSockets            (WebSocketServer)
 *   - bblanchon ArduinoJson v6
 *   - espressif esp32-camera          (OV2640/OV5640)
 *   - driver/i2s.h                    (麦克风 PDM/I2S 读 + 功放 I2S 写，MAX98357A)
 *   - WiFi / WiFiUDP
 *
 * 板型（用户已确认：同时带 摄像头 + 麦克风 + 喇叭）。下述引脚按 XIAO ESP32S3 Sense + I2S 功放示例，
 *   请按实际板型改引脚。
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "driver/i2s.h"

// ————— 配置（凭证一律留空，配网时注入；切勿写死真实 token）—————
static const char *DEVICE_NAME = "书桌家教";   // 设备名
static const char *WIFI_SSID = "";             // 留空：由配网门户/蓝牙写入 NVS
static const char *WIFI_PASS = "";
// 共享 token：由配网一次性注入到 NVS，固件从存储读取；切勿硬编码进固件/仓库
static const char *AUTH_TOKEN = "";            // 占位：实际用 nvsGet("hw","token")

// ————— 协议常量（须与 PROTOCOL.md 对齐）—————
static const char    *MAGIC        = "dt-esp32";
static const uint8_t  PROTO        = 1;
static const uint16_t WS_PORT      = 80;
static const uint16_t DISCOVERY_PORT = 48000;
static const uint8_t  BIN_IMAGE      = 0x01;
static const uint8_t  BIN_AUDIO_UP   = 0x02;
static const uint8_t  BIN_AUDIO_DOWN = 0x03;

// ————— 引脚（按板型调整）—————
#define CAM_PIN_PWDN -1
#define CAM_PIN_RESET -1
#define CAM_PIN_XCLK 15
#define CAM_PIN_SIOD 4
#define CAM_PIN_SIOC 5
#define CAM_PIN_Y9 16
#define CAM_PIN_Y8 17
#define CAM_PIN_Y7 18
#define CAM_PIN_Y6 21
#define CAM_PIN_Y5 14
#define CAM_PIN_Y4 13
#define CAM_PIN_Y3 12
#define CAM_PIN_Y2 11
#define CAM_PIN_VSYNC 10
#define CAM_PIN_href 9
#define CAM_PIN_PCLK 46
#define CAM_PIN_D7 43
#define CAM_PIN_D6 42
#define CAM_PIN_D5 41
#define CAM_PIN_D4 40
#define CAM_PIN_D3 39
#define CAM_PIN_D2 38
#define CAM_PIN_D1 0
#define CAM_PIN_D0 1

#define I2S_MIC_PORT I2S_NUM_0
#define MIC_PIN_BCK 41
#define MIC_PIN_WS  42
#define MIC_PIN_DATA 2

#define I2S_SPK_PORT I2S_NUM_1
#define SPK_PIN_BCK  8
#define SPK_PIN_WS   7
#define SPK_PIN_DATA 44
#define SPK_PIN_SD   5

// ————— 运行态 —————
WebSocketsServer ws(WS_PORT);
WiFiUDP udp;
static int  clientId = -1;          // 单客户端（主机）
static bool authed = false;
static bool streamImage = false;
static bool streamAudio = false;
static bool playing = false;        // 正在下放播放（半双工：暂停麦克风上行）
static uint8_t vol = 80;
static uint32_t lastBeacon = 0;
static uint32_t lastFrame = 0;
static const uint32_t BEACON_MS = 2000;
static const uint32_t FRAME_MS = 1000;   // 帧间隔（主机抓帧策略主导，设备给上限帧率）

// 下行播放：跳过首个 WAV 头（44B）
static size_t pendingWavHeader = 44;

// ————— 工具 —————
static String deviceId() {
  uint64_t chip = ESP.getEfuseMac();
  char buf[24]; snprintf(buf, sizeof(buf), "esp32-%04X", (uint16_t)(chip & 0xffff)); return String(buf);
}

static void sendCtl(const String &json) {
  if (clientId >= 0 && authed) ws.sendTXT(clientId, json);
}

static void sendHello() {
  StaticJsonDocument<256> d;
  d["t"] = "hello"; d["id"] = deviceId(); d["name"] = DEVICE_NAME; d["fw"] = "1.0.0"; d["proto"] = PROTO;
  JsonObject c = d.createNestedObject("caps"); c["cam"] = true; c["mic"] = true; c["spk"] = true;
  JsonObject a = d.createNestedObject("audio"); a["rate"] = 16000; a["ch"] = 1; a["bits"] = 16;
  String out; serializeJson(d, out);
  if (clientId >= 0) ws.sendTXT(clientId, out);   // hello 在鉴权前也要能发
}

static void sendBeacon() {
  StaticJsonDocument<256> d;
  d["magic"] = MAGIC; d["id"] = deviceId(); d["name"] = DEVICE_NAME;
  d["ip"] = WiFi.localIP().toString(); d["port"] = WS_PORT; d["proto"] = PROTO;
  JsonObject c = d.createNestedObject("caps"); c["cam"] = true; c["mic"] = true; c["spk"] = true;
  String out; serializeJson(d, out);
  udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
  udp.print(out);
  udp.endPacket();
}

static void sendAck(int seq, int code) {
  StaticJsonDocument<128> d; d["t"] = "ack"; d["seq"] = seq; d["code"] = code;
  String out; serializeJson(d, out); sendCtl(out);
}

static void sendState() {
  StaticJsonDocument<256> d;
  d["t"] = "state"; d["rssi"] = WiFi.RSSI(); d["fw"] = "1.0.0"; d["heap"] = ESP.getFreeHeap();
  d["playing"] = playing; d["volume"] = vol;
  String out; serializeJson(d, out); sendCtl(out);
}

// ————— 摄像头 —————
static void cameraInit() {
  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0; cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = CAM_PIN_D0; cfg.pin_d1 = CAM_PIN_D1; cfg.pin_d2 = CAM_PIN_D2; cfg.pin_d3 = CAM_PIN_D3;
  cfg.pin_d4 = CAM_PIN_D4; cfg.pin_d5 = CAM_PIN_D5; cfg.pin_d6 = CAM_PIN_D6; cfg.pin_d7 = CAM_PIN_D7;
  cfg.pin_xclk = CAM_PIN_XCLK; cfg.pin_pclk = CAM_PIN_PCLK; cfg.pin_sccb_sda = CAM_PIN_SIOD; cfg.pin_sccb_scl = CAM_PIN_SIOC;
  cfg.pin_pwdn = CAM_PIN_PWDN; cfg.pin_reset = CAM_PIN_RESET; cfg.pin_vsync = CAM_PIN_VSYNC; cfg.pin_href = CAM_PIN_href;
  cfg.pin_sccb_sda = CAM_PIN_SIOD;
  cfg.xclk_freq_hz = 20000000; cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size = FRAMESIZE_VGA; cfg.jpeg_quality = 16; cfg.fb_count = 1;
  esp_camera_init(&cfg);
}

static void sendImageFrame(bool hd) {
  sensor_t *s = esp_camera_sensor_get();
  if (s) s->set_framesize(s, hd ? FRAMESIZE_SVGA : FRAMESIZE_VGA);
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return;
  // 帧 = [BIN_IMAGE][JPEG...]
  uint8_t *buf = (uint8_t *)malloc(fb->len + 1);
  buf[0] = BIN_IMAGE; memcpy(buf + 1, fb->buf, fb->len);
  if (clientId >= 0 && authed) ws.sendBIN(clientId, buf, fb->len + 1);
  free(buf);
  esp_camera_fb_return(fb);
}

// ————— I2S 麦克风上行 —————
static void micInit() {
  i2s_config_t m = {};
  m.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  m.sample_rate = 16000; m.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  m.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT; m.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  m.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1; m.dma_buf_count = 8; m.dma_buf_len = 256;
  i2s_pin_config_t pins = {};
  pins.bck_io_num = MIC_PIN_BCK; pins.ws_io_num = MIC_PIN_WS; pins.data_out_num = I2S_PIN_NO_CHANGE; pins.data_in_num = MIC_PIN_DATA;
  i2s_driver_install(I2S_MIC_PORT, &m, 0, NULL);
  i2s_set_pin(I2S_MIC_PORT, &pins);
}

static void micStreamOnce() {
  if (playing) return;                       // 半双工：播放期暂停麦克风上行
  int16_t raw[512]; size_t got = 0;
  i2s_read(I2S_MIC_PORT, raw, sizeof(raw), &got, portMAX_DELAY);
  if (!got) return;
  // 立体声→单声道（取一路）；如麦克风为单声道可直发
  int16_t *mono = (int16_t *)malloc(got);
  size_t samples = got / 2;
  for (size_t i = 0; i < samples; i++) mono[i] = raw[i * 2];
  uint8_t *buf = (uint8_t *)malloc(samples * 2 + 1);
  buf[0] = BIN_AUDIO_UP; memcpy(buf + 1, mono, samples * 2);
  if (clientId >= 0 && authed) ws.sendBIN(clientId, buf, samples * 2 + 1);
  free(buf); free(mono);
}

// ————— I2S 功放播放下行 —————
static void spkInit() {
  pinMode(SPK_PIN_SD, OUTPUT); digitalWrite(SPK_PIN_SD, HIGH);
  i2s_config_t s = {};
  s.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  s.sample_rate = 22050; s.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  s.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT; s.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  s.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1; s.dma_buf_count = 8; s.dma_buf_len = 256;
  i2s_pin_config_t pins = {};
  pins.bck_io_num = SPK_PIN_BCK; pins.ws_io_num = SPK_PIN_WS; pins.data_out_num = SPK_PIN_DATA; pins.data_in_num = I2S_PIN_NO_CHANGE;
  i2s_driver_install(I2S_SPK_PORT, &s, 0, NULL);
  i2s_set_pin(I2S_SPK_PORT, &pins);
}

// 收到一段下行音频（首块含 44B WAV 头，需剥离）
static void playChunk(const uint8_t *data, size_t len) {
  if (pendingWavHeader > 0) {
    size_t skip = min(pendingWavHeader, len);
    data += skip; len -= skip; pendingWavHeader -= skip;
    if (len == 0) return;
  }
  // 按音量缩放（简单增益）后写入 I2S；立体声复制单声道
  static int16_t out[1024];
  size_t samples = len / 2;
  for (size_t i = 0; i < samples; i++) {
    int16_t v = (int16_t)(data[2 * i] | (data[2 * i + 1] << 8));
    v = (int16_t)((int32_t)v * vol / 100);
    out[i * 2] = v; out[i * 2 + 1] = v;
  }
  size_t written = 0;
  i2s_write(I2S_SPK_PORT, out, samples * 4, &written, portMAX_DELAY);
}

static void playBegin() { playing = true; pendingWavHeader = 44; }
static void playEnd()   { playing = false; }

// ————— 指令处理（FR-10.10 远程控制）—————
static void handleCmd(int seq, const char *action, JsonVariant arg) {
  String a = action;
  if (a == "session") {
    String s = arg.as<String>();
    streamAudio = (s == "start" || s == "resume");
    streamImage = streamAudio;
  } else if (a == "capture") {
    bool hd = arg.is<Object>() ? arg["hd"].as<bool>() : true;
    sendImageFrame(hd);
  } else if (a == "volume") {
    vol = constrain((int)arg.as<int>(), 0, 100);
  } else if (a == "mute") {
    vol = arg.as<bool>() ? 0 : 80;
  } else if (a == "led") {
    // TODO: 驱动状态灯
  } else if (a == "cue") {
    // TODO: 播放一段本地"我在听"短提示音（可从 SPIFFS 读 WAV 走 playChunk 逻辑）
  } else if (a == "power") {
    // sleep：进轻睡眠/关流；wake：恢复
    String s = arg.as<String>();
    if (s == "sleep") { streamAudio = streamImage = false; }
  } else if (a == "reboot") {
    sendAck(seq, 0); delay(100); ESP.restart();
  } else if (a == "info") {
    sendState();
  }
  sendAck(seq, 0);
}

// ————— WebSocket 事件 —————
static void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      clientId = num; authed = false;
      sendHello();
      break;
    case WStype_DISCONNECTED:
      if ((int)num == clientId) { clientId = -1; authed = false; streamAudio = streamImage = false; }
      break;
    case WStype_TEXT: {
      StaticJsonDocument<512> d;
      if (deserializeJson(d, payload, len)) return;
      const char *t = d["t"];
      if (!t) return;
      String ts = t;
      if (ts == "auth") {
        const char *tok = d["token"];
        // token 由 NVS 读取；此处用编译期占位（务必替换为 nvsGetString）
        if (tok && String(tok) == String(AUTH_TOKEN) && String(AUTH_TOKEN).length() > 0) {
          authed = true; sendCtl("{\"t\":\"auth_ok\"}");
        } else {
          sendCtl("{\"t\":\"auth_fail\"}");
        }
      } else if (ts == "ping") {
        sendCtl("{\"t\":\"pong\"}"); sendHello();
      } else if (ts == "stream") {
        if (d.containsKey("audio")) streamAudio = d["audio"].as<bool>();
        if (d.containsKey("image")) streamImage = d["image"].as<bool>();
      } else if (ts == "cmd") {
        handleCmd((int)d["seq"], d["action"], d["arg"]);
      } else if (ts == "config") {
        // 可选：读取下行播放采样率等
      } else if (ts == "play_begin") {
        playBegin();
      } else if (ts == "play_end") {
        playEnd();
      }
      break;
    }
    case WStype_BIN:
      if (len > 0 && payload[0] == BIN_AUDIO_DOWN) playChunk(payload + 1, len - 1);
      break;
    default: break;
  }
}

// ————— setup / loop —————
void setup() {
  Serial.begin(115200);
  cameraInit(); micInit(); spkInit();
  udp.begin(0);  // 临时端口用于发信标
  WiFi.mode(WIFI_STA);
  if (String(WIFI_SSID).length() > 0) WiFi.begin(WIFI_SSID, WIFI_PASS);
  // 生产应接入配网门户（如 WiFiManager），SSID/密码/token 从 NVS 读取，勿写死
  ws.begin();
  ws.onEvent(onWsEvent);
  ws.beginList();
  Serial.println("DeepTutor ESP32 参考固件已启动");
}

void loop() {
  ws.loop();
  uint32_t now = millis();
  if (now - lastBeacon > BEACON_MS) { lastBeacon = now; if (WiFi.status() == WL_CONNECTED) sendBeacon(); }

  if (authed) {
    if (streamImage && now - lastFrame > FRAME_MS) { lastFrame = now; sendImageFrame(false); }
    if (streamAudio && !playing) micStreamOnce();   // 连续 PCM 分块上行
  }
  // 提示：micStreamOnce 每次读 512 帧；loop 频度决定上行粒度，可换 RTOS 任务定频采集
}
