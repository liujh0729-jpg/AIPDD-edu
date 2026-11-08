const { contextBridge, ipcRenderer } = require('electron')

// 只暴露必要的方法，渲染进程不接触 Node/fs/密钥
contextBridge.exposeInMainWorld('api', {
  // 配置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),

  // 语音
  speak: (text, opts) => ipcRenderer.invoke('speech:speak', { text, opts }),
  stopSpeak: () => ipcRenderer.invoke('speech:stop'),
  transcribe: (wavBase64) => ipcRenderer.invoke('speech:transcribe', { wavBase64 }),
  voices: () => ipcRenderer.invoke('speech:voices'),

  // 会话 / 视觉
  sessionStart: () => ipcRenderer.invoke('session:start'),
  sessionEnd: () => ipcRenderer.invoke('session:end'),
  sessionFrame: (dataUrl) => ipcRenderer.invoke('session:frame', dataUrl),

  // Agent
  agentRespond: (payload) => ipcRenderer.invoke('agent:respond', payload),
  agentIntent: (text) => ipcRenderer.invoke('agent:intent', text),

  // 讲解视频
  exportVideo: (html, meta, id) => ipcRenderer.invoke('explain:exportVideo', { html, meta, id }),
  onVideoProgress: (cb) => ipcRenderer.on('explain:videoProgress', (_e, p) => cb(p)),

  // 记忆 / 知识库 / 报告
  memoryL1: (limit) => ipcRenderer.invoke('memory:l1', limit),
  memoryFacts: () => ipcRenderer.invoke('memory:facts'),
  memoryFactEdit: (topic, mastery) => ipcRenderer.invoke('memory:fact:edit', { topic, mastery }),
  memoryFactDelete: (topic) => ipcRenderer.invoke('memory:fact:delete', topic),
  memoryProfile: () => ipcRenderer.invoke('memory:profile'),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  kbList: () => ipcRenderer.invoke('kb:list'),
  kbIngest: () => ipcRenderer.invoke('kb:ingest'),
  kbDelete: (id) => ipcRenderer.invoke('kb:delete', id),
  kbQuery: (q, k) => ipcRenderer.invoke('kb:query', { q, k }),
  reportList: () => ipcRenderer.invoke('report:list'),
  reportGet: (id) => ipcRenderer.invoke('report:get', id),
  openFrame: (p) => ipcRenderer.invoke('report:openFrame', p),

  // 技能（上游 /api/skills 为唯一真源；hub 浏览/安装已统一进上游 hub API）
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillInstallLocal: () => ipcRenderer.invoke('skill:installLocal'),
  skillInstallHub: (item) => ipcRenderer.invoke('skill:installHub', item),
  skillEnable: (name, on) => ipcRenderer.invoke('skill:enable', { name, on }),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),

  // 状态
  serviceStatus: () => ipcRenderer.invoke('service:status'),
  // 就绪自检（三视图「立即检查」；只查配置/权限/本地状态，零计费调用）
  readyCheck: (scope) => ipcRenderer.invoke('ready:check', { scope }),

  // DeepTutor 内嵌：宿主区开/关/移动 + 就绪探测
  openDeeptutor: (key, url, bounds) => ipcRenderer.invoke('deeptutor:open', { key, url, bounds }),
  moveDeeptutor: (key, bounds) => ipcRenderer.invoke('deeptutor:move', { key, bounds }),
  closeDeeptutor: (key) => ipcRenderer.invoke('deeptutor:close', { key }),
  probeDeeptutor: (url) => ipcRenderer.invoke('deeptutor:probe', url),
  onDeeptutorLost: (cb) => ipcRenderer.on('deeptutor:lost', (_e, p) => cb(p)),
  // 内嵌原生页加载完成（收起品牌占位）
  onDeeptutorReady: (cb) => ipcRenderer.on('deeptutor:ready', (_e, p) => cb(p)),
  // 内嵌页面内导航（如页面菜单进入设置/返回应用），用于顶栏状态同步
  onDeeptutorNavigated: (cb) => ipcRenderer.on('deeptutor:navigated', (_e, p) => cb(p)),

  // bundled 核心生命周期（启动卡拉起内置 runtime，就绪后拿到动态前端地址）
  coreStart: () => ipcRenderer.invoke('core:start'),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  coreStop: () => ipcRenderer.invoke('core:stop'),
  onCoreStatus: (cb) => ipcRenderer.on('core:status', (_e, s) => cb(s)),

  // 全景学习（F11 · 屏幕即上下文：截屏/标注覆盖层/全局热键；截图即用即弃，记忆只存文字摘要）
  panoCapture: (displayId) => ipcRenderer.invoke('pano:capture', { displayId }),
  panoScreens: () => ipcRenderer.invoke('pano:screens'),
  panoAsk: (payload) => ipcRenderer.invoke('pano:ask', payload),
  panoDraw: (shapes, opts) => ipcRenderer.invoke('pano:draw', { shapes, opts }),
  panoClear: () => ipcRenderer.invoke('pano:clear'),
  panoHide: () => ipcRenderer.invoke('pano:hide'),
  panoSetHotkey: (accelerator) => ipcRenderer.invoke('pano:hotkey:set', { accelerator }),
  panoOpenPermission: () => ipcRenderer.invoke('pano:permission'),
  panoMemoryGet: () => ipcRenderer.invoke('pano:memory:get'),
  panoMemoryClear: () => ipcRenderer.invoke('pano:memory:clear'),
  onPanoHotkey: (cb) => ipcRenderer.on('pano:hotkey', () => cb()),

  // 智能硬件（F10 · ESP32）
  hwDiscover: () => ipcRenderer.invoke('hardware:discover'),
  hwScan: () => ipcRenderer.invoke('hardware:scan'),
  hwDevices: () => ipcRenderer.invoke('hardware:devices'),
  hwConnect: (p) => ipcRenderer.invoke('hardware:connect', p),
  hwDisconnect: () => ipcRenderer.invoke('hardware:disconnect'),
  hwStatus: () => ipcRenderer.invoke('hardware:status'),
  hwStream: (p) => ipcRenderer.invoke('hardware:stream', p),
  hwCommand: (action, arg) => ipcRenderer.invoke('hardware:command', { action, arg }),
  hwSpeak: (text, opts) => ipcRenderer.invoke('hardware:speak', { text, opts }),
  onHwStatus: (cb) => ipcRenderer.on('hardware:status', (_e, s) => cb(s)),
  onHwDevices: (cb) => ipcRenderer.on('hardware:devices', (_e, d) => cb(d)),
  onHwFrame: (cb) => ipcRenderer.on('hardware:frame', (_e, f) => cb(f)),
  onHwSpeech: (cb) => ipcRenderer.on('hardware:speech', (_e, p) => cb(p)),
  onHwSpeaking: (cb) => ipcRenderer.on('hardware:speaking', (_e, p) => cb(p)),
  onHwDevState: (cb) => ipcRenderer.on('hardware:devstate', (_e, s) => cb(s)),
  onHwLog: (cb) => ipcRenderer.on('hardware:log', (_e, p) => cb(p))
})
