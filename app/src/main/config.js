// F6.5/6.8 配置与密钥存储：Key 只进本机 0600 文件，绝不写死
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

// —— AIPDD 端点登记（PRD 6.1，仅默认值，Key 一律留空）——
const AIPDD_PRESET = {
  id: 'aipdd',
  name: 'AIPDD',
  baseURL: 'https://app.aipdd.work/api/v1',
  endpoints: {
    text: 'https://app.aipdd.work/api/v1',
    imagesGenerations: 'https://app.aipdd.work/api/v1/images/generations',
    imagesEdits: 'https://app.aipdd.work/api/v1/images/edits',
    videos: 'https://app.aipdd.work/api/v1/videos',
    audioSpeech: 'https://app.aipdd.work/api/v1/audio/speech',
    embeddings: 'https://app.aipdd.work/api/v1/embeddings',
    audioTranscriptions: 'https://app.aipdd.work/api/v1/audio/transcriptions',
    systemOne: 'https://app.aipdd.work/api/v1/systemone'
  }
}

function defaults () {
  return {
    gateways: [
      { ...AIPDD_PRESET, keyRef: '' },
      { id: 'newapi', name: 'NewAPI', baseURL: '', endpoints: {}, keyRef: '' },
      { id: 'volc', name: '火山引擎（豆包）', baseURL: '', endpoints: {}, keyRef: '' },
      { id: 'aliyun', name: '阿里云百炼', baseURL: '', endpoints: {}, keyRef: '' }
    ],
    // 按角色映射：gateway+endpoint+model，可选 backup（FR-6.3 故障切换）
    roles: {
      vlm: { gateway: 'aipdd', endpoint: 'text', model: '', backup: '' },
      llm: { gateway: 'aipdd', endpoint: 'text', model: '', backup: '' },
      decision: { gateway: 'aipdd', endpoint: 'systemOne', model: '', backup: '' },
      stt: { gateway: 'aipdd', endpoint: 'audioTranscriptions', model: '', backup: '' },
      tts: { gateway: 'local', endpoint: 'audioSpeech', model: '', backup: '' },
      embedding: { gateway: 'aipdd', endpoint: 'embeddings', model: '', backup: '' }
    },
    wakeWord: '小老师',
    directAnswerMode: false, // FR-5.6a 直接解答模式，默认关
    muteMode: false,         // FR-2.5 静音模式：关闭 AI 主动说话（speech.js 消费）
    ttsRate: 'mid',          // slow | mid | fast（FR-2.2 三档）
    ttsVolume: 80,           // 0~100（FR-2.2，映射 say -a）
    kbEnabled: true,         // FR-4 知识库辅助应答开关（agent.js 消费）
    frameInterval: 8,        // FR-1.2 秒/帧
    costLimitDaily: 0,       // NFR-3 每日调用上限熔断，0=不熔断
    child: { grade: '', subjects: [] },
    // F8/FR-5.0c/5.0d：默认 bundled 自启——用封包内 runtime 本地拉起 DeepTutor（Agent=/chat，原生设置=/settings）；
    // attach 为降级：连接已手动启动的外部服务（url 固定）。bundled 下运行时地址由核心就绪后动态下发。
    deeptutor: {
      mode: 'bundled',
      url: 'http://127.0.0.1:3782',
      agentPath: '/chat',
      settingsPath: '/settings'
    },
    // F10 智能硬件（ESP32）：设备仅作 IO 前端；token 不入库，走 0600 keys（键名 hw:<deviceId>）。
    // 发现表/活动设备为运行态（hardware.js 内存 Map），不落配置，避免双份设备状态。
    hardware: {
      audioOutput: 'pc',      // FR-10.6 音响输出路径：'pc' 电脑音响 | 'device' ESP32 音响
      discoveryPort: 48000,   // FR-10.1b UDP 广播信标监听端口
      deviceVolume: 80,       // FR-10.10d 设备喇叭音量 0~100（路径二；鉴权后自动下发）
      autoReconnect: true     // FR-10.2c 断连自动重连
    },
    // F11 全景学习（heyclicky 式屏幕即上下文）：全局热键 / 捕捉屏幕 / 标注样式 / 会话跟问 / 文字摘要记忆。
    // 截图即用即弃不落盘；memory 只存「问题+讲解文字」摘要（绝不存截图 dataUrl）。
    panorama: {
      hotkey: 'Control+Shift+Space', // 全局热键（Electron Accelerator 格式）
      displayId: '',                 // 捕捉哪块屏（desktopCapturer id；空=主屏）
      annotationSize: 'mid',         // circle/box/arrow 线宽档位 small|mid|large
      annotationHold: 45,            // 标注自动清除秒数，0=常驻直到手动清除
      annotate: true,                // 是否在屏幕上画标注（关=纯语音讲解）
      frameTtlSec: 90,               // 追问窗口：秒内复用同一帧会话多轮，0=每问必截新屏
      memoryOn: true,                // 屏幕讲解文字记忆（注入 system 摘要，跨问题上下文）
      memory: [],                    // 最近 8 条 {t,q,a,n}，只存文字
      vad: true                      // 语音提问本地断句（静音自动停）；关=固定 5 秒临时录音
    }
  }
}

const CFG_DEFAULTS = {
  directAnswerMode: false, muteMode: false, ttsRate: 'mid', ttsVolume: 80,
  frameInterval: 8, costLimitDaily: 0, kbEnabled: true, wakeWord: '小老师'
}

function cfgPath () { return path.join(app.getPath('userData'), 'config.json') }
function keyPath () { return path.join(app.getPath('userData'), 'keys.json') }

function readJson (p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return fallback }
}

// 读取配置并补齐新增字段（向后兼容旧 config.json）
function load () {
  const d = defaults()
  const cfg = readJson(cfgPath(), null)
  if (!cfg) return d
  const merged = { ...d, ...cfg }
  merged.roles = { ...d.roles, ...(cfg.roles || {}) }
  for (const r of Object.keys(merged.roles)) merged.roles[r] = { ...d.roles[r], ...merged.roles[r] }
  for (const k of Object.keys(CFG_DEFAULTS)) if (merged[k] === undefined) merged[k] = CFG_DEFAULTS[k]
  // 仅在键缺失/类型损坏时回填默认网关；空数组是用户“删光了网关”的结果，不得复活
  if (!Array.isArray(merged.gateways)) merged.gateways = d.gateways
  merged.deeptutor = { ...d.deeptutor, ...(cfg.deeptutor || {}) }
  merged.hardware = { ...d.hardware, ...(cfg.hardware || {}) }
  merged.panorama = { ...d.panorama, ...(cfg.panorama || {}) }
  return merged
}

function save (cfg) {
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), { encoding: 'utf8' })
}

// 真实 Key 只写本机私有文件，权限 0600（不进入应用包/日志/导出）
function writeKeys (keys) {
  fs.writeFileSync(keyPath(), JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(keyPath(), 0o600) } catch (e) {}
}
function readKeys () { return readJson(keyPath(), {}) }

function ensureFirstRun () {
  if (!fs.existsSync(cfgPath())) save(defaults())
}

module.exports = { load, save, readKeys, writeKeys, ensureFirstRun, cfgPath, keyPath, defaults }
