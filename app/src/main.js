// AI学习助理 · 桌面壳主进程（bundled 自启：内置 runtime 拉起 DeepTutor 核心 + 内嵌原生界面）
// 设计蓝本：DeepTutor 官方桌面壳 apps/desktop（WebContentsView 内嵌本地服务）。
// 硬约束：凭证不写死、只存本机(0600)；无任何自动计费测试调用——所有网关请求仅由用户动作触发。
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, systemPreferences } = require('electron')
const path = require('path')
const fs = require('fs')

// 健壮性：开发态 stdout 管道被中途中断（如 `npm start | head`、终端关闭）时，
// console.log 会向已关闭的 socket 写入抛 write EPIPE 未捕获异常导致主进程崩溃。
// 流级吞掉 EPIPE/ECONNRESET，其余错误继续上抛，不掩盖真实问题。
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => { if (e && (e.code === 'EPIPE' || e.code === 'ECONNRESET' || e.code === 'EOF')) return })
}

const config = require('./main/config')
const gateway = require('./main/gateway')
const speech = require('./main/speech')
const memory = require('./main/memory')
const skills = require('./main/skills')
const explain = require('./main/explain')
const agent = require('./main/agent')
const hardware = require('./main/hardware')
const panorama = require('./main/panorama')

const CORE_PARTITION = 'persist:deeptutor'
let win = null
let coreThemePinned = false // 内嵌 DeepTutor 主题只需钉一次（snow），避免重复刷新
// key -> { view, origin }，托管 Agent(/chat) 与原生设置(/settings) 两块内嵌区域
const hosts = new Map()

// —— bundled 核心启动器（CommonJS；与主进程/asar 兼容）——
const launcher = require('./main/launcher')
const APP_ROOT = path.resolve(__dirname, '../..') // __dirname=app/src → 上溯两级 = edu 仓库根（开发态定位 runtime）
let core = null
let coreStarting = null
function coreArgs () {
  return {
    runtimeHome: path.join(app.getPath('userData'), 'deeptutor-home'),
    cachePath: path.join(app.getPath('userData'), 'deeptutor-cache'),
    appRoot: APP_ROOT,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  }
}
async function startCore () {
  if (core && core.state && core.state.phase === 'ready') return core.state
  if (coreStarting) return coreStarting
  try {
    core = new launcher.CoreRuntime({ log: (c) => console.log('[core] ' + String(c).trimEnd()) })
    core.on('status', (state) => { console.log('[core:status] ' + JSON.stringify({ phase: state.phase, step: state.step, url: state.url })); send('core:status', state) })
    coreStarting = core.start(coreArgs()).then((state) => {
      coreStarting = null
      gateway.setBackend(state.backendURL) // 战①：壳网关同步上游目录的后端地址
      return state
    })
      .catch((err) => { coreStarting = null; console.error('[core] start 失败：' + ((err && err.stack) || err)); throw err })
    return coreStarting
  } catch (e) {
    coreStarting = null
    console.error('[core] 启动器初始化失败：' + ((e && e.stack) || e))
    throw e
  }
}

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ——— F10 智能硬件（ESP32）设备接入：懒建单例 + 事件转发到渲染层 ———
let hw = null
function getHw () {
  if (hw) return hw
  hw = new hardware.HardwareManager({ log: (m) => console.log(String(m)) })
  hw.on('status', (s) => send('hardware:status', s))
  hw.on('devices', (d) => send('hardware:devices', d))
  hw.on('frame', (f) => send('hardware:frame', f))
  hw.on('speech', (p) => send('hardware:speech', p))
  hw.on('speaking', (v) => send('hardware:speaking', { playing: v }))
  hw.on('state', (s) => send('hardware:devstate', s))
  hw.on('log', (m) => send('hardware:log', { text: String(m) }))
  hw.on('auth-fail', (e) => send('hardware:log', { text: (e && e.error) || '鉴权失败', level: 'error' }))
  return hw
}
function hwTokenFor (id) { return config.readKeys()['hw:' + id] || '' }

function createWindow () {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AI学习助理',
    backgroundColor: '#ffffff', // 统一标准：DeepTutor Default(snow) 纯白画布
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 壳自身页面禁止导航/弹窗，只允许本产品可信内容
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('resize', () => { /* 渲染层通过 ResizeObserver 重新测量宿主区并调用 deeptutor:move */ })
  win.on('closed', () => {
    for (const { view } of hosts) { try { view.webContents.close() } catch (e) {} }
    hosts.clear()
    win = null
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// 媒体权限（学习端麦克风/摄像头）：授予渲染进程发起的媒体请求；macOS 启动即申请系统授权并持久化。
const ALLOWED_PERMS = ['media', 'audio', 'video', 'display-capture', 'mediaKeySystem']
function setupPermissions () {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMS.includes(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMS.includes(permission))

  // DeepTutor 内嵌页所在分区：允许剪贴板写入与同源媒体（如原生录音/朗读）
  const core = session.fromPartition(CORE_PARTITION)
  core.setPermissionCheckHandler((_c, permission) => ['clipboard-sanitized-write', 'media'].includes(permission))
  core.setPermissionRequestHandler((_c, permission, callback) => callback(['clipboard-sanitized-write', 'media'].includes(permission)))
}

async function requestSystemMediaAccess () {
  if (process.platform !== 'darwin') return
  for (const kind of ['microphone', 'camera']) {
    try {
      let status
      try { status = systemPreferences.getMediaAccessStatus(kind) } catch (e) { status = 'unknown' }
      if (status === 'granted') continue
      if (status === 'restricted' || status === 'denied') {
        console.warn('[权限] macOS 对' + (kind === 'microphone' ? '麦克风' : '摄像头') + '授权为 ' + status + '，需在系统设置中手动允许')
        continue
      }
      await systemPreferences.askForMediaAccess(kind)
    } catch (e) { /* 不同 macOS 版本对 camera 支持不一，忽略 */ }
  }
}

app.whenReady().then(async () => {
  config.ensureFirstRun()
  memory.prune() // NFR-1：启动清理超期抓帧
  setupPermissions()
  createWindow()
  // F11 全景学习：热键按下唤起主窗并交给渲染层管线（截屏→聆听→问答→画标注）；
  // 启动即按配置注册一次，失败不阻断（面板内可改键重注册）。
  panorama.init({ onHotkey: () => send('pano:hotkey', {}) })
  try { panorama.registerHotkey((config.load().panorama || {}).hotkey) } catch (e) { console.warn('[panorama] 热键注册失败：' + e.message) }
  await requestSystemMediaAccess()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', async (e) => {
  try { panorama.unregisterAll(); panorama.hideOverlay() } catch (err) { /* 回收失败不阻断退出 */ }
  if (hw) { try { hw.stop() } catch (err) { /* 回收失败不阻断退出 */ } }
  if (core && core.state && core.state.phase !== 'stopped' && core.state.phase !== 'stopping') {
    e.preventDefault()
    try { await core.stop() } catch (err) { /* 回收失败不阻断退出 */ }
    app.exit(0)
  }
})

// ————————————————————————————————
// attach 内嵌：WebContentsView 宿主管理（对齐官方 apps/desktop）
// ————————————————————————————————
function boundsOf (b) {
  return { x: Math.round(b.x || 0), y: Math.round(b.y || 0), width: Math.max(1, Math.round(b.width || 1)), height: Math.max(1, Math.round(b.height || 1)) }
}

function closeHost (key) {
  const h = hosts.get(key)
  if (!h) return
  try { win.contentView.removeChildView(h.view) } catch (e) {}
  try { h.view.webContents.close() } catch (e) {}
  hosts.delete(key)
}

function openHost (key, url, bounds) {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口未就绪' }
  let origin
  try { origin = new URL(url).origin } catch (e) { return { ok: false, error: '非法 URL：' + url } }
  let h = hosts.get(key)
  // 同域已存在：仅移动/复用，避免重复加载；地址变化（如 Agent 视图内切到设置页）就地导航，
  // 保证与页面内下拉菜单进入的是同一个设置页实例。
  if (h && h.origin === origin) {
    h.view.setBounds(boundsOf(bounds))
    win.contentView.addChildView(h.view)
    if (h.url !== url) {
      h.url = url
      const rc = h.view.webContents
      // 成对监听、命中其一即拆另一：避免逐次导航累积 once 监听器/陈旧闭包乱发 ready
      const ready = () => {
        rc.off('did-finish-load', ready)
        rc.off('did-fail-load', ready)
        send('deeptutor:ready', { key })
      }
      rc.once('did-finish-load', ready)
      rc.once('did-fail-load', ready)
      rc.loadURL(url)
    } else {
      send('deeptutor:ready', { key })
    }
    return { ok: true, reused: true }
  }
  if (h) closeHost(key)
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: CORE_PARTITION, preload: path.join(__dirname, 'preload-core.js') }
  })
  const content = view.webContents
  content.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(origin + '/') || target.startsWith('blob:' + origin + '/')) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: CORE_PARTITION } } }
    }
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  const restrict = (event, target) => {
    try {
      if (new URL(target).origin !== origin) { event.preventDefault(); if (/^https?:/.test(target)) void shell.openExternal(target) }
    } catch (e) { event.preventDefault() }
  }
  content.on('will-navigate', restrict)
  content.on('will-redirect', restrict)
  content.on('will-attach-webview', (event) => event.preventDefault())
  content.on('render-process-gone', () => send('deeptutor:lost', { key }))
  // 页面内导航（如左上角菜单进入设置、“返回应用”回到工作台）：回写 h.url 保持与实际地址一致
  // （否则复用分支的相等判断会误命中，导致齿轮再次打开设置时不触发导航），并广播给渲染层同步顶栏。
  const navNote = (_e, href) => {
    const cur = hosts.get(key)
    if (cur) cur.url = href
    send('deeptutor:navigated', { key, url: href })
  }
  content.on('did-navigate-in-page', navNote)
  content.on('did-navigate', navNote)
  view.setBounds(boundsOf(bounds))
  // 先不挂载：等内容加载完成后再 addChildView，避免直接暴露上游 DeepTutor 的“加载中”骨架；
  // 期间由渲染层的品牌占位顶上（就绪事件 deeptutor:ready 通知收起占位）。
  let attached = false
  const attach = () => {
    if (attached || content.isDestroyed()) return
    attached = true
    try { win.contentView.addChildView(view) } catch (e) {}
    send('deeptutor:ready', { key })
  }
  content.on('did-finish-load', attach)
  content.on('did-fail-load', attach)
  // UI 统一：把内嵌 DeepTutor 界面钉到与壳层同一的 Default(snow) 主题（一次性、仅当不一致时刷新）。
  if (!coreThemePinned) {
    coreThemePinned = true
    content.once('dom-ready', () => {
      try {
        content.executeJavaScript("(function(){try{if(localStorage.getItem('deeptutor-theme')!=='snow'){localStorage.setItem('deeptutor-theme','snow');location.reload();return true}return false}catch(e){return false}})()")
          .catch(() => { coreThemePinned = false })
      } catch (e) { coreThemePinned = false }
    })
  }
  content.loadURL(url)
  hosts.set(key, { view, origin, url })
  return { ok: true }
}

ipcMain.handle('deeptutor:open', (_e, { key, url, bounds }) => openHost(key, url, bounds))
ipcMain.handle('deeptutor:move', (_e, { key, bounds }) => {
  const h = hosts.get(key)
  if (h) { h.view.setBounds(boundsOf(bounds)); return { ok: true } }
  return { ok: false }
})
ipcMain.handle('deeptutor:close', (_e, { key }) => { closeHost(key); return { ok: true } })

// ——— bundled 核心生命周期（供启动卡驱动；仅本机 loopback）———
ipcMain.handle('core:start', async () => {
  try {
    const state = await startCore()
    return { ok: true, state }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
})
ipcMain.handle('core:status', () => (core && core.state) || { phase: 'idle', step: null })
ipcMain.handle('core:stop', async () => { if (core) await core.stop(); return { ok: true } })

// 就绪探测在主进程发起（无渲染层 CSP 限制），仅访问 loopback 本地服务
ipcMain.handle('deeptutor:probe', async (_e, url) => {
  let u
  try { u = new URL(url) } catch (e) { return { ok: false, error: '非法 URL' } }
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return { ok: false, error: '仅允许探测本机地址' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'text/html' } })
    clearTimeout(t)
    return { ok: resp.ok, status: resp.status }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
})

// 当前课次（会话）状态
let activeSession = null

// ——— 配置 / 密钥 ———
ipcMain.handle('config:load', () => config.load())
ipcMain.handle('config:save', (_e, cfg) => {
  config.save(cfg)
  return { ok: true }
})
// 内嵌设置页按分区只回写自己那部分：对本地 config 做一层深合并（对象浅合并、数组/标量整体替换）
ipcMain.handle('config:patch', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false, error: '非法补丁' }
  const cur = config.load()
  const merged = { ...cur }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) merged[k] = { ...cur[k], ...v }
    else merged[k] = v
  }
  config.save(merged)
  return { ok: true }
})
// FR-6.8 配置导入导出（不含密钥）
ipcMain.handle('config:export', async () => {
  const { cancellation, filePath } = await dialog.showSaveDialog(win, { title: '导出配置', defaultPath: 'edu-tutor-config.json' })
  if (cancellation || !filePath) return { ok: false, cancelled: true }
  const cfg = config.load()
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf8')
  return { ok: true, path: filePath }
})
ipcMain.handle('config:import', async () => {
  const { cancellation, filePaths } = await dialog.showOpenDialog(win, { title: '导入配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (cancellation || !filePaths[0]) return { ok: false, cancelled: true }
  try {
    const cfg = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    delete cfg.keys
    config.save(cfg)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ——— 用量计量（F6：模型执行统一走上游目录，壳只做本机计量与熔断）———
ipcMain.handle('usage:summary', () => gateway.usageSummary())

// ——— 语音（F2）———
ipcMain.handle('speech:speak', (_e, p) => speech.speak(p.text, p.opts || {}))
ipcMain.handle('speech:stop', () => speech.stop())
ipcMain.handle('speech:transcribe', (_e, p) => speech.transcribe(p.wavBase64))
ipcMain.handle('speech:voices', () => speech.voices())

// ——— 会话 / 视觉（F1/F4）———
ipcMain.handle('session:start', () => { activeSession = memory.startSession(); return { ok: true, id: activeSession } })
ipcMain.handle('session:end', () => {
  const report = activeSession ? memory.endSession(activeSession) : null
  activeSession = null
  return { ok: true, report }
})
ipcMain.handle('session:frame', (_e, dataUrl) => {
  if (!activeSession) return { ok: false, error: '未开始上课' }
  const p = memory.addFrame(activeSession, dataUrl)
  return { ok: true, path: p }
})

// ——— Agent（F8：学习端引导编排走网关适配；Agent 工作台由 DeepTutor 内嵌承担）———
ipcMain.handle('agent:respond', (_e, payload) => agent.respond({ ...payload, sessionId: payload.sessionId || activeSession }))
ipcMain.handle('agent:intent', (_e, text) => agent.normalizeIntent(text))

// ——— 讲解视频导出（F7）———
ipcMain.handle('explain:exportVideo', (_e, p) => {
  return explain.exportVideo(p.html, p.meta, (prog) => send('explain:videoProgress', { ...prog, id: p.id }))
})

// ——— 记忆 / 知识库 / 报告（F4）———
ipcMain.handle('memory:l1', (_e, limit) => memory.readL1(limit))
ipcMain.handle('memory:facts', () => memory.facts())
ipcMain.handle('memory:fact:edit', (_e, p) => memory.editFact(p.topic, p.mastery))
ipcMain.handle('memory:fact:delete', (_e, topic) => memory.deleteFact(topic))
ipcMain.handle('memory:profile', () => memory.profile())
ipcMain.handle('memory:clear', () => memory.clearMemory())
ipcMain.handle('kb:list', () => memory.kbList())
ipcMain.handle('kb:delete', (_e, id) => memory.kbDelete(id))
ipcMain.handle('kb:query', (_e, p) => memory.kbQuery(p.q, p.k || 3))
ipcMain.handle('kb:ingest', async () => {
  const { cancellation, filePaths } = await dialog.showOpenDialog(win, { title: '导入资料', properties: ['openFile', 'multiSelections'], filters: [{ name: '文本', extensions: ['txt', 'md', 'markdown', 'csv', 'json'] }] })
  if (cancellation || !filePaths.length) return { ok: false, cancelled: true }
  return await memory.kbIngest(filePaths)
})
ipcMain.handle('report:list', () => memory.listReports())
ipcMain.handle('report:get', (_e, id) => memory.getReport(id))
// 报告配图的帧图/讲解视频均落在 userData 下：只允许打开这两类目录内的真实路径，
// 防止内嵌页（渲染 LLM 产出）经 __edu.openFrame 以默认程序打开任意文件。
ipcMain.handle('report:openFrame', (_e, p) => {
  const roots = [path.join(app.getPath('userData'), 'explains'), path.join(app.getPath('userData'), 'data', 'frames')]
  let real
  try {
    real = fs.realpathSync(p)
    if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) return { ok: false, error: '路径不在允许范围' }
  } catch (e) { return { ok: false, error: '路径无效' }
  }
  shell.openPath(real)
  return { ok: true }
})

// ——— 技能（F9：上游 /api/skills 为唯一真源；hub 浏览/安装已统一进上游 hub API）———
ipcMain.handle('skill:list', () => skills.list())
ipcMain.handle('skill:installLocal', async () => {
  const { cancellation, filePaths } = await dialog.showOpenDialog(win, { title: '导入 SKILL', properties: ['openFile', 'openDirectory'] })
  if (cancellation || !filePaths[0]) return { ok: false, cancelled: true }
  return skills.installLocal(filePaths[0])
})
ipcMain.handle('skill:installHub', (_e, item) => skills.installFromHub(item))
ipcMain.handle('skill:enable', (_e, p) => skills.setEnabled(p.name, p.on))
ipcMain.handle('skill:remove', (_e, name) => skills.remove(name))

// ——— 服务状态 ———
ipcMain.handle('service:status', () => agent.status())

// ——— 全景学习（F11：屏幕即上下文；截图只在内存即用即弃，模型调用走既有 gateway.chat 计量/熔断）———
ipcMain.handle('pano:capture', (_e, p) => panorama.capture((p && p.displayId) || undefined))
ipcMain.handle('pano:screens', () => panorama.listScreens())
ipcMain.handle('pano:draw', (_e, p) => panorama.draw((p && p.shapes) || [], (p && p.opts) || {}))
ipcMain.handle('pano:clear', () => panorama.clearOverlay())
ipcMain.handle('pano:hide', () => panorama.hideOverlay())
ipcMain.handle('pano:hotkey:set', (_e, p) => panorama.registerHotkey(p && p.accelerator))
ipcMain.handle('pano:permission', () => panorama.openScreenPermissionSettings())
// 全景问答编排：屏幕图 + 问题 → gateway.chat('vlm')（计量/熔断在上游适配层内建）→
// 解析标注协议并直接画到覆盖层；解析失败降级纯讲解。截图只在本次请求内存中存在。
// M1 记忆：成功后把「问题+讲解文字」摘要存配置（不存图）；下次提问注入 system 尾部形成跨问题上下文。
// M2 会话跟问：渲染层传 history（同帧内已发生的问答轮），本侧拼成多轮 messages，图只挂在首问上。
ipcMain.handle('pano:ask', async (_e, p) => {
  const question = String((p && p.question) || '').trim()
  if (!question) return { ok: false, error: '缺少问题' }
  const cfgAll = config.load()
  const cfgPanorama = cfgAll.panorama || {}
  const history = (Array.isArray(p.history) ? p.history : []).slice(-4)
    .filter((h) => h && String(h.q || '').trim() && String(h.a || '').trim())
    .map((h) => ({ q: String(h.q).trim().slice(0, 200), a: String(h.a).trim().slice(0, 600) }))
  // 文字摘要记忆块（只存文字、零新增计费调用：直接用讲解文本本身作摘要）
  let memBlock = ''
  if (cfgPanorama.memoryOn !== false && Array.isArray(cfgPanorama.memory) && cfgPanorama.memory.length) {
    memBlock = '\n\n以下是你之前在用户屏幕上讲过的内容摘要（新→旧）。学生提到“刚才/之前”时可引用，不要主动复述：\n' +
      cfgPanorama.memory.slice(-8).reverse().map((m, i) =>
        (i + 1) + '. 问：' + String(m.q || '').slice(0, 60) + ' → 讲了：' + String(m.a || '').slice(0, 120)).join('\n')
  }
  const tutorBase = '你是一位耐心的中小学全科老师。学生把正在看的屏幕发给你，并问问题。请用适合口播的中文口语讲解：' +
    '先一句话说清重点，再分 2-3 步讲透，控制在 180 字以内；学生是' + (cfgAll.child && cfgAll.child.grade ? cfgAll.child.grade + '学生' : '中小学生') + '。'
  const annotateOn = p.annotate !== false
  // 关标注时不附画图协议，只约定“不输出标注”；开标注时附归一化坐标协议（含 pointer）
  const system = annotateOn
    ? panorama.ANNOTATE_SYSTEM(tutorBase + memBlock)
    : tutorBase + '\n\n你正看着用户屏幕上的一帧画面（整张截图）。学生没有要求圈点屏幕，绝不要输出任何 JSON 或 Markdown 代码块，只用口语讲解。' + memBlock
  const imagePart = p.image ? [{ type: 'image_url', image_url: { url: p.image } }] : []
  const qText = annotateOn ? ('问题：' + question) : ('问题：' + question + '\n（本次只需口头讲解，不要输出标注 json）')
  const msgs = [{ role: 'system', content: system }]
  // 同帧多轮：图属于首问；后续轮只有文字
  history.forEach((h, i) => {
    msgs.push({ role: 'user', content: i === 0 && imagePart.length ? imagePart.concat([{ type: 'text', text: '问题：' + h.q }]) : '问题：' + h.q })
    msgs.push({ role: 'assistant', content: h.a })
  })
  if (!history.length && imagePart.length) msgs.push({ role: 'user', content: imagePart.concat([{ type: 'text', text: qText }]) })
  else msgs.push({ role: 'user', content: qText })
  const r = await gateway.chat('vlm', msgs, { timeout: 90000 })
  if (!r.ok) return { ok: false, error: r.error, tripped: !!r.tripped }
  const parsed = panorama.parseAnnotation(r.content)
  let annotateFailed = false
  if (annotateOn && /```json|\[/.test(r.content || '') && (!parsed.annotations || !parsed.annotations.length)) annotateFailed = true
  if (annotateOn && parsed.annotations.length) {
    try { await panorama.draw(parsed.annotations, { displayId: p.displayId || cfgPanorama.displayId || undefined }) } catch (e) { annotateFailed = true }
  }
  // M1 记忆写入：只存文字摘要，保留最近 8 条，随配置落盘本机（先取最新盘上配置再改，避免覆盖并发改动）
  if (cfgPanorama.memoryOn !== false && parsed.text) {
    try {
      const cur = config.load()
      const mem = Array.isArray(cur.panorama.memory) ? cur.panorama.memory : []
      mem.push({ t: Date.now(), q: question.slice(0, 120), a: String(parsed.text).slice(0, 300), n: parsed.annotations.length })
      while (mem.length > 8) mem.shift()
      cur.panorama.memory = mem
      config.save(cur)
    } catch (e) { /* 记忆写入失败不阻断应答 */ }
  }
  return { ok: true, text: parsed.text, annotations: parsed.annotations, annotateFailed, reusedFrame: history.length > 0, turn: history.length + 1, displayId: p.displayId || cfgPanorama.displayId || undefined, gw: r.gw, model: r.model }
})

// M1 学习轨迹：只存文字的讲解记忆列表（查看/清空；截图从不入库）
ipcMain.handle('pano:memory:get', () => ({ ok: true, memory: (config.load().panorama || {}).memory || [] }))
ipcMain.handle('pano:memory:clear', () => {
  try {
    const cur = config.load()
    cur.panorama.memory = []
    config.save(cur)
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
})

// ——— 智能硬件（F10：ESP32 外设；仅局域网、token 存本机 0600、自发不触网关）———

// 就绪自检（三视图「立即检查」）：只查配置/系统权限/本地服务状态与局域网发现，
// 绝不发起任何计费模型调用；缺项全部列出并给出引导。
function mkItem (name, ok, hint, level) { return { name, ok: !!ok, hint: hint || '', level: level || 'must' } }
function mediaStatus (kind) {
  if (process.platform !== 'darwin') return 'not-applicable'
  try { return systemPreferences.getMediaAccessStatus(kind) } catch (e) { return 'unknown' }
}
async function readyCheck (scope) {
  const items = []
  const cfg = config.load()
  const keys = config.readKeys()
  // —— 通用：本地核心（DeepTutor）存活 ——
  const coreOk = gateway.hasBackend()
  const probe = coreOk ? await gateway.apiCall('GET', '/health/ready', undefined, { timeout: 5000 }) : null
  items.push(mkItem('本地核心（DeepTutor）', coreOk && probe && probe.ok,
    coreOk ? ((probe && probe.ok) ? '应答正常' : ('无应答：' + ((probe && probe.error) || 'HTTP 异常'))) : '未启动：看启动卡片状态，或 设置 → DeepTutor 接入'))
  // —— 通用：模型目录（上游唯一真源：提供方/凭证/激活模型统一在 设置 → 模型设置 管理）——
  const cat = coreOk ? await gateway.apiCall('GET', '/api/settings/catalog', undefined, { timeout: 5000 }) : null
  const services = (cat && cat.ok && cat.data && cat.data.catalog && cat.data.catalog.services) || {}
  // 视觉理解 ride llm 服务（视觉是模型能力）；决策 task 未激活时上游自动继承 llm
  for (const [svc, label] of [['llm', '语言/视觉模型'], ['stt', '语音识别模型']]) {
    const s = services[svc] || {}
    const profile = (s.profiles || []).find((p) => p && p.id === s.active_profile_id)
    const model = profile && (profile.models || []).find((m) => m && m.id === s.active_model_id)
    if (model) {
      items.push(mkItem('模型服务 · ' + label, true,
        '已激活：' + (model.model || model.name || model.id) + (profile.api_key ? '' : '（未保存 Key；免钥提供方可忽略）')))
    } else {
      items.push(mkItem('模型服务 · ' + label, false,
        coreOk ? '未激活：设置 → 模型设置：添加提供方、保存 Key，并在对应服务模型页激活模型' : '本地核心未启动，无法读取模型目录'))
    }
  }
  // —— 通用：每日额度/熔断余量 ——
  const usage = gateway.usageSummary()
  const limit = cfg.costLimitDaily || 0
  const tripped = limit > 0 && usage.totalCalls >= limit
  items.push(mkItem('每日额度（熔断）', !tripped,
    limit > 0 ? ('今日已用 ' + usage.totalCalls + '/' + limit + (tripped ? ' —— 已熔断，请调整阈值' : '')) : '未设阈值（不熔断）', 'opt'))
  // —— 全景学习：屏幕即上下文的专项前置 ——
  if (scope === 'panorama') {
    const screenSt = mediaStatus('screen')
    items.push(mkItem('屏幕录制权限', screenSt === 'granted' || screenSt === 'not-applicable',
      screenSt === 'granted' ? '已授权' : screenSt === 'not-applicable' ? '当前系统无需单独授权' : '未授权/受限：点本视图「打开屏幕录制权限设置」，勾选后重启应用'))
    const scr = await panorama.listScreens()
    items.push(mkItem('屏幕源可读', scr.ok && (scr.screens || []).length > 0,
      scr.ok ? ('发现 ' + scr.screens.length + ' 块屏（试读未落盘）') : ('读取失败：' + ((scr && scr.error) || '未知') + '——通常需要屏幕录制权限')))
    const micSt = mediaStatus('microphone')
    items.push(mkItem('麦克风权限（语音提问）', micSt === 'granted' || micSt === 'not-applicable',
      micSt === 'granted' || micSt === 'not-applicable' ? '' : '未授权：系统设置→隐私与安全性→麦克风；也可打字提问'))
    const hk = panorama.hotkeyState()
    items.push(mkItem('全局热键', !!hk.registered, hk.registered ? ('已注册：' + hk.registered) : '未注册：在右侧「全局热键」填好并点应用', 'opt'))
  }
  // —— 沉浸式学习：听/看前置 ——
  if (scope === 'study') {
    const micSt = mediaStatus('microphone')
    items.push(mkItem('麦克风权限（唤醒/提问）', micSt === 'granted' || micSt === 'not-applicable',
      micSt === 'granted' || micSt === 'not-applicable' ? '' : '未授权：系统设置→隐私与安全性→麦克风'))
    const camSt = mediaStatus('camera')
    items.push(mkItem('摄像头权限（看题/监看）', camSt === 'granted' || camSt === 'not-applicable',
      camSt === 'granted' || camSt === 'not-applicable' ? '' : '未授权：系统设置→隐私与安全性→摄像头；未开时「看这道题」不可用', 'opt'))
    items.push(mkItem('唤醒词', !!String(cfg.wakeWord || '').trim(),
      String(cfg.wakeWord || '').trim() ? ('当前：「' + cfg.wakeWord + '」') : '未设：留空=免唤醒直接应答（与智能硬件端同步生效）', 'opt'))
  }
  // —— 智能硬件：局域网发现/连接/凭据/出声路径 ——
  if (scope === 'hardware') {
    const h = getHw()
    const disc = h.startDiscovery()
    items.push(mkItem('局域网发现服务', disc && disc.ok !== false,
      (disc && disc.ok) ? 'UDP 信标监听中' : ('未就绪：' + ((disc && disc.error) || '未知'))))
    h.scan()
    await new Promise((res) => setTimeout(res, 1600)) // 广播后等信标回执（仅局域网，不触网关）
    const devs = h.listDevices()
    items.push(mkItem('ESP32 设备在线', devs.length > 0,
      devs.length ? (devs.map((d) => d.name || d.ip || d.id).join('、')) : '未发现：确认设备已上电且与电脑同一 WiFi；也可用「手动连接(IP 兜底)」', 'opt'))
    const st = h.getState()
    const connOk = st.state === 'connected' || st.state === 'working'
    items.push(mkItem('设备连接', connOk,
      connOk ? ('已连：' + ((st.device && (st.device.name || st.device.ip)) || '')) : ('当前状态：' + st.state + '——远程控制/播报到设备需先连接', 'opt')))
    const paired = Object.keys(keys).some((k) => k.indexOf('hw:') === 0)
    items.push(mkItem('配对 Token 本机保存', paired,
      paired ? '存在已保存的设备凭据（0600 私有文件）' : '暂无：若设备要求 token，首次连接时填入并勾「记住本机」', 'opt'))
    const out = cfg.hardware.audioOutput || 'pc'
    items.push(mkItem('声音输出路径', out === 'pc' || (connOk && st.caps && st.caps.spk),
      out === 'pc' ? '电脑音响（无额外前置）' : ('选了设备音响：需已连接带喇叭的设备（当前' + (connOk ? (st.caps && st.caps.spk ? '正常' : '设备无喇叭') : '未连接') + ')'), 'opt'))
  }
  return items
}
ipcMain.handle('ready:check', async (_e, p) => {
  try { return { ok: true, items: await readyCheck(String((p && p.scope) || '')) } }
  catch (e) { return { ok: false, error: String((e && e.message) || e) } }
})
ipcMain.handle('hardware:discover', () => ({ ok: true, ...getHw().startDiscovery() }))
ipcMain.handle('hardware:scan', () => getHw().scan())
ipcMain.handle('hardware:devices', () => getHw().listDevices())
ipcMain.handle('hardware:connect', (_e, p) => {
  const h = getHw()
  const id = p.deviceId || p.ip
  const token = (p.token != null && p.token !== '' ? p.token : hwTokenFor(id)) || ''
  // FR-10.2a：配对 token 只写本机 0600（不入库 config.json/导出）；仅在用户显式保存时写入
  if (p.saveToken && p.token) { const keys = config.readKeys(); keys['hw:' + id] = p.token; config.writeKeys(keys) }
  return h.connect({ ip: p.ip, port: p.port, deviceId: p.deviceId, name: p.name, token })
})
ipcMain.handle('hardware:disconnect', () => getHw().disconnect())
ipcMain.handle('hardware:status', () => getHw().getState())
ipcMain.handle('hardware:stream', (_e, p) => getHw().setStream(p))
ipcMain.handle('hardware:command', (_e, p) => getHw().command(p.action, p.arg))
// FR-10.6 路径二 / FR-10.10c：经设备播放（say→WAV→下放），仅用户动作触发
ipcMain.handle('hardware:speak', async (_e, p) => {
  const h = getHw()
  if (!h.caps || !h.caps.spk) return { ok: false, error: '设备未连接或无喇叭' }
  const r = await speech.renderWav(p.text, p.opts || {})
  if (!r.ok) return r
  return await h.playWav(r.wav)
})
