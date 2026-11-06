// AI学习助理 · 渲染层（attach 壳）
// 职责：顶栏两视图 + 设置齿轮切换；Agent 与设置共用同一内嵌宿主（WebContentsView），
//       齿轮打开的设置与页面左上角菜单进入的设置是同一个页面；学习端为壳自有视图。
;(function () {
  'use strict'
  const api = window.api
  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s))
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  let cfg = null
  let currentView = 'agent'

  // =========================================================
  // 内嵌宿主（WebContentsView）管理
  // =========================================================
  const DT_MODE = () => (cfg && cfg.deeptutor && cfg.deeptutor.mode) || 'bundled'
  // bundled 就绪后的动态前端地址（由核心下发）；attach 直接用配置固定地址
  let coreBaseUrl = null
  const DT_BASE = () => {
    if (DT_MODE() === 'bundled') return coreBaseUrl || (cfg && cfg.deeptutor && cfg.deeptutor.url) || 'http://127.0.0.1:3782'
    return (cfg && cfg.deeptutor && cfg.deeptutor.url) || 'http://127.0.0.1:3782'
  }
  const agentUrl = () => DT_BASE() + ((cfg && cfg.deeptutor && cfg.deeptutor.agentPath) || '/chat')
  const nativeUrl = () => DT_BASE() + ((cfg && cfg.deeptutor && cfg.deeptutor.settingsPath) || '/settings')
  const settingsPathOf = () => (cfg && cfg.deeptutor && cfg.deeptutor.settingsPath) || '/settings'
  // Agent 与设置共用同一个内嵌宿主：视图为二者之一时，宿主可见并需跟随布局
  const isAgentHosted = (v) => v === 'agent' || v === 'settings'
  const agentHostUrl = () => (currentView === 'settings' ? nativeUrl() : agentUrl())
  const mountAgent = (url) => mountHost('agent', '#agentHost', '#agentFallback', '#agentProbeMsg', url)

  function rectOf (el) {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  // 内嵌宿主 key -> 品牌占位元素选择器（加载原生页前顶住，遮掉上游“加载中”骨架）
  const LOADING_EL = { agent: '#agentLoading' }

  // 探测 -> 就绪则内嵌，未就绪则降级
  async function mountHost (key, hostSel, fbSel, probeSel, url) {
    const host = $(hostSel), fb = $(fbSel)
    if (!host || !fb) return
    const lg = LOADING_EL[key] ? $(LOADING_EL[key]) : null
    if (probeSel) $(probeSel).textContent = ''
    if (lg) lg.classList.remove('hidden') // 先亮品牌占位
    const res = await api.probeDeeptutor(url)
    if (!res || !res.ok) {
      await api.closeDeeptutor(key)
      if (lg) lg.classList.add('hidden') // 失败收起占位
      host.classList.add('hidden')
      fb.classList.remove('hidden')
      if (probeSel) $(probeSel).textContent = '探测失败：' + ((res && (res.status || res.error)) || '未知') + '（请确认本地 DeepTutor 服务已启动）'
      return
    }
    fb.classList.add('hidden')
    host.classList.remove('hidden')
    await api.openDeeptutor(key, url, rectOf(host))
    // 占位在原生页加载完成（deeptutor:ready）后由事件收起
  }

  async function moveHost (key, hostSel) {
    const host = $(hostSel)
    if (!host || host.classList.contains('hidden')) return
    await api.moveDeeptutor(key, rectOf(host))
  }

  function unmountHost (key) { api.closeDeeptutor(key) }

  // 宿主尺寸随窗口变化实时跟随
  const ro = new ResizeObserver(() => {
    if (isAgentHosted(currentView)) moveHost('agent', '#agentHost')
  })
  ro.observe(document.body)
  window.addEventListener('scroll', () => {
    if (isAgentHosted(currentView)) moveHost('agent', '#agentHost')
  }, true)

  api.onDeeptutorLost && api.onDeeptutorLost((p) => {
    if (p && p.key === 'agent' && isAgentHosted(currentView)) mountAgent(agentHostUrl())
  })

  // 页面内导航（左上角菜单进入设置 / “返回应用”回到工作台）联动顶栏高亮与配置重载
  api.onDeeptutorNavigated && api.onDeeptutorNavigated((p) => {
    if (!p || p.key !== 'agent' || !isAgentHosted(currentView)) return
    const sp = settingsPathOf()
    let path = ''
    try { path = new URL(p.url).pathname } catch (e) { return }
    const onSettings = path === sp || path.startsWith(sp + '/')
    if (onSettings === (currentView === 'settings')) return
    const leavingSettings = currentView === 'settings'
    currentView = onSettings ? 'settings' : 'agent'
    $$('.switch .tab').forEach(t => t.classList.toggle('active', t.dataset.view === currentView))
    $('.gear').classList.toggle('active', onSettings)
    if (leavingSettings) reloadConfig()
  })

  // 原生页加载完成：收起对应品牌占位
  api.onDeeptutorReady && api.onDeeptutorReady((p) => {
    if (p && p.key && LOADING_EL[p.key]) { const lg = $(LOADING_EL[p.key]); if (lg) lg.classList.add('hidden') }
  })

  // =========================================================
  // 视图切换
  // =========================================================
  async function setView (view) {
    if (view === currentView) return
    const leavingSettings = currentView === 'settings'
    // 离开：关闭不再显示的内嵌宿主；Agent↔设置互切共用同一宿主，不销毁、就地导航（保留各页状态）
    const stayingHosted = isAgentHosted(currentView) && isAgentHosted(view)
    if (isAgentHosted(currentView) && !stayingHosted) unmountHost('agent')
    if (view !== 'study') studySuspendUIHints()

    currentView = view
    $$('.view').forEach(v => v.classList.remove('active'))
    // 设置与页面菜单的设置同源：复用 Agent 宿主区，不再展示独立视图
    $('#view-' + (view === 'settings' ? 'agent' : view)).classList.add('active')
    $$('.switch .tab').forEach(t => t.classList.toggle('active', t.dataset.view === view))
    $('.gear').classList.toggle('active', view === 'settings')

    // 内嵌设置页直接写盘 config.json；返回其它视图时重新载入，确保学习端/硬件读取到最新配置
    if (leavingSettings) await reloadConfig()

    if (view === 'agent') mountAgent(agentUrl())
    // 硬件视图回显最新音响路径/音量：设置分区可能在内嵌页里直接改过 config.json
    if (view === 'hardware') { syncHwOutRadios(); hwRefresh() }
    if (view === 'panorama') { panoSetPill(pano.busy ? 'think' : 'idle') }
    if (view === 'settings') mountAgent(nativeUrl())
  }

  // 设置直接复用 Agent 同一内嵌宿主打开 DeepTutor 原生设置页（与页面左上角菜单同一实例），
  // 因此不隐藏“返回应用”：点它会回到同一视图内的工作台，导航事件同步顶栏状态。

  // =========================================================
  // 学习端（自有视图）
  // =========================================================
  const study = { sessionId: null, camOn: false, micOn: false, camStream: null, micStream: null, recorder: null, segTimer: null, frameTimer: null, hintLevel: 1, speaking: false, lastTopic: '', awakeUntil: 0 }
  let exportingVideoId = null // 讲解视频导出当前任务 id（过滤 onVideoProgress 事件用）
  const els = {}
  function cacheEls () {
    ;['cam', 'camHint', 'recDot', 'explainWrap', 'explainFrame', 'videoMsg', 'subtitle', 'voiceLog', 'modeTag', 'engMode', 'subShow', 'wakeStudy']
      .forEach(id => { els[id] = document.getElementById(id) })
  }

  function setPill (s) { $$('.pill').forEach(p => p.classList.toggle('on', p.dataset.s === s)) }

  function appendVoice (who, text) {
    if (!els.voiceLog) return
    const line = document.createElement('div')
    line.className = who === 'u' ? 'u' : ''
    line.textContent = (who === 'u' ? '🗁 你：' : '🤖 助理：') + text
    els.voiceLog.appendChild(line)
    els.voiceLog.scrollTop = els.voiceLog.scrollHeight
  }

  // 交互诊断行（“我是否在正确交互”的证据链）：学习端语音日志与硬件端日志双写，
  // src 标注声音来源；dedupKey+ms 合并短时间内的重复诊断（如连续未含唤醒词的拦截）。
  const traceMemo = {}
  function iTrace (text, src, dedupKey, ms) {
    if (dedupKey) {
      const now = Date.now()
      if (traceMemo[dedupKey] && now - traceMemo[dedupKey] < (ms || 12000)) return
      traceMemo[dedupKey] = now
    }
    const line = (src === 'device' ? '[设备] ' : src === 'pc' ? '[电脑] ' : '') + text
    if (els.voiceLog) {
      const d = document.createElement('div')
      d.className = 'sys'
      d.textContent = new Date().toLocaleTimeString() + ' ⟶ ' + line
      els.voiceLog.appendChild(d)
      els.voiceLog.scrollTop = els.voiceLog.scrollHeight
    }
    hwLog(line)
    if (line.indexOf('全景') === 0 || currentView === 'panorama') panoLog(line)
  }

  function showSubtitle (text) {
    if (!els.subtitle) return
    els.subtitle.style.display = (els.subShow && els.subShow.checked) ? '' : 'none'
    els.subtitle.textContent = text
  }

  function studySuspendUIHints () { /* 预留：离开学习端时暂停非必要提示 */ }

  async function ensureModeTag () {
    const eng = els.engMode && els.engMode.checked
    if (els.modeTag) els.modeTag.textContent = eng ? '英语沉浸模式' : '中文模式'
  }

  async function startLesson () {
    const r = await api.sessionStart()
    if (!r || !r.ok) return
    study.sessionId = r.id
    iTrace('课堂会话已开启 #' + r.id + '：语音将走 唤醒→识别→应答 链路')
    setPill('idle')
    $('#btnStart').disabled = true
    $('#btnEnd').disabled = false
    if (!study.camOn) toggleCam(true)
  }

  async function endLesson () {
    const r = await api.sessionEnd()
    if (r && r.report) appendVoice('a', '本次学习已结束：' + (r.report.suggestion || '继续保持节奏。'))
    study.sessionId = null
    setPill('idle')
    $('#btnStart').disabled = false
    $('#btnEnd').disabled = true
    stopFrameTimer()
    iTrace('课堂会话已结束' + (r && r.report ? '，学习报告已生成' : ''))
    if (study.camOn) toggleCam(false)
  }

  async function toggleCam (on) {
    if (on === undefined) on = !study.camOn
    if (on) {
      try {
        study.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
        els.cam.srcObject = study.camStream
        els.camHint.style.display = 'none'
        els.recDot.classList.add('on')
        study.camOn = true
        $('#btnCam').textContent = '关闭摄像头'
        startFrameTimer()
        iTrace('摄像头监看已开启（“看这道题”与硬件拍题可用）')
      } catch (e) {
        appendVoice('a', '摄像头开启失败：' + e.message + '（请在系统设置→隐私与安全性允许摄像头）')
        iTrace('摄像头开启失败：' + e.message)
      }
    } else {
      if (study.camStream) study.camStream.getTracks().forEach(t => t.stop())
      study.camStream = null
      els.cam.srcObject = null
      els.camHint.style.display = ''
      els.recDot.classList.remove('on')
      study.camOn = false
      $('#btnCam').textContent = '开启摄像头'
      stopFrameTimer()
      iTrace('摄像头监看已停止')
    }
  }

  function snapshotFrame () {
    if (!study.camOn || !els.cam.videoWidth) return null
    const c = document.createElement('canvas')
    c.width = els.cam.videoWidth; c.height = els.cam.videoHeight
    c.getContext('2d').drawImage(els.cam, 0, 0)
    return c.toDataURL('image/jpeg', 0.7)
  }

  function startFrameTimer () {
    stopFrameTimer()
    const iv = Math.max(5, Math.min(30, (cfg && cfg.frameInterval) || 8)) * 1000
    study.frameTimer = setInterval(() => {
      const f = snapshotFrame()
      if (f && study.sessionId) api.sessionFrame(f)
    }, iv)
  }
  function stopFrameTimer () { if (study.frameTimer) { clearInterval(study.frameTimer); study.frameTimer = null } }

  // 麦克风：分段录音 -> 网关转写 -> 编排（仅在你说话时触发；本地 say 播报）
  async function toggleMic (on) {
    if (on === undefined) on = !study.micOn
    if (on) {
      try {
        study.micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        study.micOn = true
        $('#btnMic').textContent = '关闭麦克风'
        setPill('listen')
        beginSegment()
        iTrace('麦克风已开启：每 5 秒分段送识别，说完等诊断行出现即可判断链路正常')
      } catch (e) {
        appendVoice('a', '麦克风开启失败：' + e.message + '（请在系统设置→隐私与安全性允许麦克风）')
        iTrace('麦克风开启失败：' + e.message)
      }
    } else {
      study.micOn = false
      if (study.segTimer) clearTimeout(study.segTimer)
      try { if (study.recorder && study.recorder.state !== 'inactive') study.recorder.stop() } catch (e) {}
      if (study.micStream) study.micStream.getTracks().forEach(t => t.stop())
      study.micStream = null
      $('#btnMic').textContent = '开启麦克风'
      setPill(study.sessionId ? 'idle' : 'idle')
      iTrace('麦克风已停止收声')
    }
  }

  function beginSegment () {
    if (!study.micOn || !study.micStream) return
    const chunks = []
    let rec
    try { rec = new MediaRecorder(study.micStream) } catch (e) { return }
    study.recorder = rec
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data) }
    rec.onstop = async () => {
      if (!study.micOn) return
      const blob = new Blob(chunks, { type: 'audio/webm' })
      try {
        const buf = await blob.arrayBuffer()
        const b64 = abToB64(buf)
        const r = await api.transcribe(b64)
        if (r && r.ok && r.text && r.text.trim()) await onUserSpeech(r.text.trim(), 'pc')
        else if (r && !r.ok) iTrace('语音识别失败：' + (r.error || '未知') + '（检查 STT 网关/网络）', 'pc')
      } catch (e) { iTrace('识别异常：' + e.message, 'pc') }
      if (study.micOn) { study.segTimer = setTimeout(beginSegment, 300) }
    }
    rec.start()
    // 每 5s 一段，自动停止并转写
    study.segTimer = setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop() } catch (e) {} }, 5000)
  }

  function abToB64 (buf) {
    const bytes = new Uint8Array(buf)
    let bin = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
    return btoa(bin)
  }

  async function onUserSpeech (raw, src) {
    src = src || 'pc'
    let text = String(raw || '').trim()
    appendVoice('u', text)
    // barge-in：新语音打断上一句播报
    if (study.speaking) { api.stopSpeak(); study.speaking = false; iTrace('打断了上一句播报（barge-in）', src) }

    // —— FR-2.1a/3.2 三层交互（本地文本层门控；真离线 KWS 待接 openWakeWord，不改网络形态）——
    const ww = String((cfg && cfg.wakeWord) || '').trim()
    const now = Date.now()
    // L1 声画直通：大声/小声/慢一点/快一点——本机 TTS 参数，不发起模型调用
    const av = /大声|声音大一?点|音量大/.test(text) ? 15 : /小声|声音小一?点|音量小/.test(text) ? -15 : 0
    if (av || /慢一点|说慢|快一点|说快/.test(text)) {
      if (av) cfg.ttsVolume = Math.max(0, Math.min(100, (Number(cfg.ttsVolume) || 80) + av))
      if (/慢一点|说慢/.test(text)) cfg.ttsRate = 'slow'
      else if (/快一点|说快/.test(text)) cfg.ttsRate = 'fast'
      await api.saveConfig(cfg)
      iTrace('声画直通：本机语速/音量已调整，未发起模型调用', src)
      await speakOut(av > 0 ? '好的，大声一点。' : av < 0 ? '好的，小声一点。' : (/慢/.test(text) ? '好的，我会说慢一些。' : '好的，我会说快一些。'), false)
      return
    }
    // L3 免唤醒安全指令：短命令任何时候直接生效（交给既有意图解析）
    const safeCmd = text.length <= 8 && /下课|暂停|休息|继续|安静|恢复/.test(text)
    const inWindow = now < study.awakeUntil
    if (!ww) iTrace('未设置唤醒词：免唤醒直接进指令解析', src, 'noww:' + src, 60000)
    if (safeCmd) iTrace('免唤醒安全指令直接生效：' + text, src)
    if (ww && !inWindow && !safeCmd) {
      const idx = text.indexOf(ww)
      if (idx < 0) { iTrace('未含唤醒词“' + ww + '”，已拦截（可说“' + ww + ' + 你要说的话”）', src, 'drop:' + src, 12000); return } // 未唤醒：不进指令解析（防误触）
      text = text.slice(idx + ww.length).replace(/^[，,。.、\s]+/, '').trim()
      study.awakeUntil = Date.now() + 10000 // L4：唤醒后 10 秒连续对话窗
      iTrace('唤醒命中 → 进入 10 秒对话窗', src)
      // 唤醒成功短提示音（FR-2.1a）；只喊唤醒词无后续内容则等待窗口内追问
      if (!text) { speakOut('我在听。', false); return }
    } else if (inWindow) {
      study.awakeUntil = Date.now() + 10000 // 窗口内每句追问续期
      iTrace('对话窗内追问（窗口续期 10 秒）', src)
    }

    // 提示等级：出现“再提示/下一步/还是不会”时逐级加深（上限 L3）
    if (/再(给)?(提示|说一?下)|下一步|还是不懂|不会做/.test(text)) study.hintLevel = Math.min(3, study.hintLevel + 1)
    else study.hintLevel = 1
    const opts = { needsExplain: /讲解|怎么解|演示|打开讲解/.test(text) }
    opts.src = src
    if (hwDeviceMode && hwLastFrame && /题|看图|检查|这道|下一页|这页/.test(text)) { opts.image = hwLastFrame; opts.needsVision = true; iTrace('携带设备最新画面进行拍题', src) }
    await askAgent(text, opts)
  }

  // 唤醒词设置（FR-2.1a/FR-5.7）：沉浸式学习与智能硬件两个视图共用同一 cfg.wakeWord，
  // 任一侧保存即两侧同步生效；留空则门控放行，所有语音直接进指令解析（免唤醒）。
  function syncWakeInputs () {
    const v = String((cfg && cfg.wakeWord) || '')
    if (els.wakeStudy) els.wakeStudy.value = v
    if (hwEls.wakeHw) hwEls.wakeHw.value = v
  }
  async function saveWakeWord (fromEl) {
    const v = String(fromEl.value || '').trim()
    cfg.wakeWord = v
    try { await api.saveConfig(cfg) } catch (e) { appendVoice('s', '保存唤醒词失败：' + e.message); return }
    syncWakeInputs()
    appendVoice('s', v ? ('唤醒词已更新：' + v + '（学习/硬件两端同步生效）') : '已清空唤醒词：语音将直接进指令解析（免唤醒）')
    hwLog(v ? ('唤醒词已更新：' + v + '（与沉浸式学习同步）') : '已清空唤醒词：免唤醒直接应答')
  }

  async function askAgent (text, opts) {
    opts = opts || {}
    const src = opts.src || 'pc'
    setPill('think')
    const payload = {
      text,
      mode: (els.engMode && els.engMode.checked) ? 'english' : 'chinese',
      sessionId: study.sessionId,
      hintLevel: opts.hintLevel || study.hintLevel,
      needsExplain: !!opts.needsExplain,
      needsVision: !!opts.image,
      image: opts.image
    }
    iTrace('→ 请求 Agent：' + (payload.mode === 'english' ? '英语沉浸' : '中文') + (payload.image ? ' · 拍题图像(VLM)' : '') + (payload.needsExplain ? ' · 讲解画布' : '') + (payload.sessionId ? ' · 课堂会话内' : ''), src)
    const r = await api.agentRespond(payload)
    if (!r || !r.ok) {
      setPill('idle')
      const msg = (r && r.tripped) ? '今日调用已达上限（熔断），请明天再试或在设置中调整。' : ('暂时无法应答：' + ((r && r.error) || '未知错误'))
      showSubtitle(msg); appendVoice('a', msg)
      iTrace('✗ Agent 未应答：' + ((r && r.tripped) ? '今日熔断上限已触发' : ((r && r.error) || '未知错误')), src)
      return
    }
    setPill('speak')
    study.speaking = true
    showSubtitle(r.reply || '')
    appendVoice('a', r.reply || '')
    iTrace('✓ Agent 已应答（' + (r.gw || 'catalog') + '，' + String(r.reply || '').length + ' 字）' + (r.page && r.page.html ? ' · 讲解画布已弹出' : '') + ' → 开始播报', src)
    await speakOut(r.reply || '', payload.mode === 'english')
    study.speaking = false
    setPill(study.sessionId ? 'idle' : 'idle')
    if (r.page && r.page.html) showExplain(r.page)
  }

  function showExplain (page) {
    els.explainWrap.classList.remove('hidden')
    els.explainFrame.srcdoc = page.html
  }

  async function snapHelp () {
    const f = snapshotFrame()
    if (!f) { appendVoice('a', '请先开启摄像头，把作业放到画面里。'); return }
    if (study.sessionId) api.sessionFrame(f)
    setPill('think')
    await askAgent('这道题我不会，先给我一点思路。', { image: f, needsVision: true, needsExplain: true, hintLevel: study.hintLevel })
  }

  function wireStudy () {
    cacheEls()
    $('#btnStart').addEventListener('click', startLesson)
    $('#btnEnd').addEventListener('click', endLesson)
    $('#btnCam').addEventListener('click', () => toggleCam())
    $('#btnMic').addEventListener('click', () => toggleMic())
    $('#btnStopSpeak').addEventListener('click', () => { api.stopSpeak(); study.speaking = false })
    $('#btnSnapHelp').addEventListener('click', snapHelp)
    els.engMode.addEventListener('change', ensureModeTag)
    els.subShow.addEventListener('change', () => { if (!els.subShow.checked) els.subtitle.style.display = 'none'; else els.subtitle.style.display = '' })
    if (els.wakeStudy) els.wakeStudy.addEventListener('change', () => saveWakeWord(els.wakeStudy))
    $('#btnCloseExplain').addEventListener('click', () => els.explainWrap.classList.add('hidden'))
    $('#btnExportVideo').addEventListener('click', () => {
      const html = els.explainFrame.srcdoc
      if (!html) return
      exportingVideoId = 'exp' + Date.now()
      els.videoMsg.textContent = '导出中……'
      api.exportVideo(html, { title: '解题讲解' }, exportingVideoId)
    })
    // 主进程事件形状：{ok,running,log}=进度；{ok:true,file,note}=成功终态；{ok:false,degraded?,note}=失败/降级
    api.onVideoProgress((p) => {
      if (!p || (p.id && p.id !== exportingVideoId)) return
      if (p.running) { els.videoMsg.textContent = '导出中……'; return }
      if (p.ok) els.videoMsg.textContent = '已导出：' + (p.file || '')
      else els.videoMsg.textContent = (p.note || '导出失败') + (p.degraded ? '（降级）' : '')
    })
    ensureModeTag()
  }

  // =========================================================
  // 设置：本产品配置已全部并入内嵌的 DeepTutor 原生设置分区
  // （见 app/src/preload-core.js bridge 与上游 features/settings/sections/Edu*）。
  // 本渲染层不再持有任何设置表单，仅负责内嵌宿主切换。
  // =========================================================

  // =========================================================
  // 智能硬件（F10 · ESP32）
  // =========================================================
  let hwStatus = { state: 'disconnected', caps: null, device: null }
  let hwDevicesCache = []
  let hwDeviceMode = false
  let hwLastFrame = null
  let hwBusy = false
  const hwEls = {}

  // 回复播报路由（FR-10.6）：路径=设备且已连带🔊 → 经设备播放；否则电脑音响
  async function speakOut (text, english) {
    if (!text) return
    const route = (cfg.hardware && cfg.hardware.audioOutput) || 'pc'
    if (route === 'device' && hwStatus.state !== 'disconnected' && hwStatus.caps && hwStatus.caps.spk) {
      const r = await api.hwSpeak(text, { english })
      if (!r || !r.ok) { hwLog('设备播报失败：' + ((r && r.error) || '未知') + '（改走电脑）', 'error'); await api.speak(text, { english }) }
      return
    }
    await api.speak(text, { english })
  }

  function hwCache () {
    ;['hwScan', 'hwScanMsg', 'hwDeviceList', 'hwManualIp', 'hwManualPort', 'hwToken', 'hwSaveToken', 'hwConnectManual', 'hwOutPc', 'hwOutDevice', 'hwVolume', 'hwVolumeLabel', 'hwDevName', 'hwCaps', 'hwDisconnect', 'hwPreviewImg', 'hwPreviewHint', 'hwRecDot', 'hwToggleImage', 'hwToggleAudio', 'hwDeviceMode', 'hwBtnStart', 'hwBtnPause', 'hwBtnResume', 'hwBtnEnd', 'hwBtnCapture', 'hwBtnCue', 'hwBtnSleep', 'hwBtnWake', 'hwBtnReboot', 'hwBtnInfo', 'hwSpeakInput', 'hwBtnSpeak', 'hwLog', 'wakeHw']
      .forEach(id => { hwEls[id] = document.getElementById(id) })
  }
  function hwLog (text, level) {
    if (!hwEls.hwLog) return
    const d = document.createElement('div')
    d.className = 'models' + (level === 'error' ? ' hw-err' : '')
    d.textContent = new Date().toLocaleTimeString() + '  ' + (level === 'error' ? '⚠ ' : '') + text
    hwEls.hwLog.appendChild(d)
    hwEls.hwLog.scrollTop = hwEls.hwLog.scrollHeight
    while (hwEls.hwLog.children.length > 200) hwEls.hwLog.removeChild(hwEls.hwLog.firstChild)
  }
  // 全景学习日志（F11 控制台）；iTrace 会镜像一份到这里，形成跨端证据链
  function panoLog (text, level) {
    const el = document.getElementById('panoLog')
    if (!el) return
    const d = document.createElement('div')
    d.className = 'models' + (level === 'error' ? ' hw-err' : '')
    d.textContent = new Date().toLocaleTimeString() + '  ' + (level === 'error' ? '⚠ ' : '') + text
    el.appendChild(d)
    el.scrollTop = el.scrollHeight
    while (el.children.length > 200) el.removeChild(el.firstChild)
  }

  function hwRenderStatus (s) {
    if (s) hwStatus = s
    $$('.hw-pill').forEach(p => p.classList.toggle('on', p.dataset.hs === hwStatus.state))
    hwEls.hwDevName.textContent = hwStatus.device ? (hwStatus.device.name || hwStatus.device.ip) : ''
    const c = hwStatus.caps
    hwEls.hwCaps.textContent = c ? ('📷' + (c.cam ? '✓' : '✗') + ' 🎤' + (c.mic ? '✓' : '✗') + ' 🔊' + (c.spk ? '✓' : '✗')) : ''
    if (hwEls.hwOutDevice) hwEls.hwOutDevice.disabled = !(c && c.spk)
    hwEls.hwRecDot.classList.toggle('on', hwStatus.state === 'working')
    if (hwStatus.state === 'disconnected') { hwEls.hwToggleImage.checked = false; hwEls.hwToggleAudio.checked = false; if (hwEls.hwPreviewHint) hwEls.hwPreviewHint.style.display = '' }
  }
  function syncHwOutRadios () {
    if (!hwEls.hwOutPc || !cfg) return
    const route = (cfg.hardware && cfg.hardware.audioOutput) || 'pc'
    if (hwEls.hwOutPc) hwEls.hwOutPc.checked = route === 'pc'
    if (hwEls.hwOutDevice) hwEls.hwOutDevice.checked = route === 'device'
    if (hwEls.hwVolume) { hwEls.hwVolume.value = (cfg.hardware && cfg.hardware.deviceVolume) || 80; hwEls.hwVolumeLabel.textContent = hwEls.hwVolume.value }
  }
  function renderHwDevices (list) {
    hwDevicesCache = list || []
    const wrap = hwEls.hwDeviceList; if (!wrap) return
    wrap.innerHTML = ''
    if (!list || !list.length) { wrap.innerHTML = '<div class="models">未发现设备。点“扫描设备”，或用左侧“手动连接”。</div>'; return }
    list.forEach(d => {
      const div = document.createElement('div'); div.className = 'hw-device'
      const c = d.caps || {}
      const info = document.createElement('div'); info.className = 'hw-dev-main'
      info.innerHTML = '<b>' + esc(d.name) + '</b><span class="models">' + esc(d.ip + ':' + d.port) + ' · 📷' + (c.cam ? '✓' : '✗') + ' 🎤' + (c.mic ? '✓' : '✗') + ' 🔊' + (c.spk ? '✓' : '✗') + '</span>'
      div.appendChild(info)
      const btn = document.createElement('button'); btn.className = 'mini ' + (d.connected ? '' : 'primary')
      btn.textContent = d.connected ? '已连接' : '连接'
      if (!d.connected) btn.addEventListener('click', () => connectDevice(d))
      div.appendChild(btn)
      wrap.appendChild(div)
    })
  }
  async function connectDevice (d) {
    const token = hwEls.hwToken.value.trim()
    hwLog('连接 ' + (d.name || d.ip) + ' …')
    const r = await api.hwConnect({ ip: d.ip, port: d.port, deviceId: d.id, name: d.name, token: token || null, saveToken: !!hwEls.hwSaveToken.checked && !!token })
    if (!r.ok) hwLog('连接失败：' + r.error, 'error')
  }
  async function hwRefresh () { if (!hwEls.hwScan) return; api.hwStatus().then(hwRenderStatus); api.hwDevices().then(renderHwDevices) }

  async function hwLesson (kind) {
    if (kind === 'start') {
      const r = await api.sessionStart(); study.sessionId = r.id
      await api.hwStream({ audio: true, image: true })
      if (hwEls.hwToggleAudio) hwEls.hwToggleAudio.checked = true
      if (hwEls.hwToggleImage) hwEls.hwToggleImage.checked = true
      await api.hwCommand('session', 'start'); hwLog('开始上课（会话 + 设备进入工作态）')
      iTrace('设备课堂已开启：音频/图像回传中，喊“' + ((cfg && cfg.wakeWord) || '小老师') + '”即可交互', 'device')
    } else if (kind === 'end') {
      await api.hwCommand('session', 'stop'); await api.hwStream({ audio: false, image: false })
      const r = await api.sessionEnd(); study.sessionId = null
      hwLog('下课' + (r && r.report ? ('：' + (r.report.suggestion || '')) : ''))
      iTrace('设备课堂已结束' + (r && r.report ? '，学习报告已生成' : ''), 'device')
    } else {
      await api.hwCommand('session', kind); hwLog('会话：' + kind)
    }
  }

  function onDeviceFrame (f) {
    if (!f) return
    hwLastFrame = f.dataUrl
    if (hwEls.hwPreviewImg) { hwEls.hwPreviewImg.src = f.dataUrl; if (hwEls.hwPreviewHint) hwEls.hwPreviewHint.style.display = 'none' }
    if (hwDeviceMode && study.sessionId) api.sessionFrame(f.dataUrl)
  }
  async function onDeviceSpeech (p) {
    if (!hwDeviceMode || !p || !p.wavBase64) return
    if (hwBusy) { iTrace('设备语音到达，但上一句仍在处理，本段已忽略', 'device', 'devbusy', 12000); return }
    hwBusy = true
    try {
      const r = await api.transcribe(p.wavBase64)
      if (r && r.ok && r.text && r.text.trim()) await onUserSpeech(r.text.trim(), 'device')
      else if (r && !r.ok) iTrace('设备语音识别失败：' + (r.error || '未知') + '（检查 STT 网关）', 'device')
    } catch (e) { iTrace('设备识别异常：' + e.message, 'device') } finally { hwBusy = false }
  }

  function initHardware () {
    hwCache(); syncHwOutRadios(); syncWakeInputs()
    api.hwDiscover && api.hwDiscover()
    api.onHwStatus && api.onHwStatus((s) => { hwRenderStatus(s) })
    api.onHwDevices && api.onHwDevices((list) => renderHwDevices(list))
    api.onHwFrame && api.onHwFrame(onDeviceFrame)
    api.onHwSpeech && api.onHwSpeech(onDeviceSpeech)
    api.onHwDevState && api.onHwDevState((s) => hwLog('设备状态：' + JSON.stringify(s).slice(0, 120)))
    api.onHwLog && api.onHwLog((p) => hwLog(p.text, p.level))

    hwEls.hwScan.addEventListener('click', async () => {
      hwEls.hwScanMsg.textContent = '扫描中……'
      const r = await api.hwScan(); hwEls.hwScanMsg.textContent = r.ok ? '已广播查询，等待设备应答……' : ('失败：' + r.error)
      setTimeout(() => api.hwDevices().then(renderHwDevices), 1500)
    })
    hwEls.hwConnectManual.addEventListener('click', async () => {
      const ip = hwEls.hwManualIp.value.trim(); if (!ip) { hwLog('请填写设备 IP', 'error'); return }
      const port = +hwEls.hwManualPort.value || 80
      const r = await api.hwConnect({ ip, port, deviceId: ip, name: ip, token: hwEls.hwToken.value.trim() || null, saveToken: hwEls.hwSaveToken.checked })
      if (!r.ok) hwLog('连接失败：' + r.error, 'error')
    })
    hwEls.hwDisconnect.addEventListener('click', async () => { await api.hwDisconnect(); hwLog('已请求断开') })
    ;[hwEls.hwOutPc, hwEls.hwOutDevice].forEach(rd => rd && rd.addEventListener('change', async () => {
      if (hwEls.hwOutDevice.checked && !(hwStatus.caps && hwStatus.caps.spk)) { hwLog('设备无喇叭或未连接，无法选设备音响', 'error'); hwEls.hwOutPc.checked = true }
      cfg.hardware = cfg.hardware || {}
      cfg.hardware.audioOutput = hwEls.hwOutDevice.checked ? 'device' : 'pc'
      await api.saveConfig({ ...cfg }); hwLog('声音输出路径：' + (cfg.hardware.audioOutput === 'device' ? 'ESP32 音响' : '电脑音响'))
    }))
    hwEls.hwVolume.addEventListener('input', () => { hwEls.hwVolumeLabel.textContent = hwEls.hwVolume.value })
    hwEls.hwVolume.addEventListener('change', async () => {
      cfg.hardware.deviceVolume = +hwEls.hwVolume.value
      await api.saveConfig({ ...cfg })
      if (hwStatus.state !== 'disconnected') { await api.hwCommand('volume', +hwEls.hwVolume.value); hwLog('设备音量：' + hwEls.hwVolume.value) }
    })
    hwEls.hwToggleImage.addEventListener('change', async () => { const r = await api.hwStream({ image: hwEls.hwToggleImage.checked }); if (!r.ok) hwLog('图像流失败：' + (r.error || ''), 'error'); else iTrace('设备图像流已' + (hwEls.hwToggleImage.checked ? '开启（拍题可用设备画面）' : '关闭'), 'device') })
    hwEls.hwToggleAudio.addEventListener('change', async () => { const r = await api.hwStream({ audio: hwEls.hwToggleAudio.checked }); if (!r.ok) hwLog('音频流失败：' + (r.error || ''), 'error'); else iTrace('设备音频流已' + (hwEls.hwToggleAudio.checked ? '开启：对设备说话将走 唤醒→识别→应答（需开启外设学习）' : '关闭'), 'device') })
    if (hwEls.wakeHw) hwEls.wakeHw.addEventListener('change', () => saveWakeWord(hwEls.wakeHw))
    hwEls.hwDeviceMode.addEventListener('change', () => { hwDeviceMode = hwEls.hwDeviceMode.checked; hwLog('外设学习模式：' + (hwDeviceMode ? '开' : '关')) })

    hwEls.hwBtnStart.addEventListener('click', () => hwLesson('start'))
    hwEls.hwBtnEnd.addEventListener('click', () => hwLesson('end'))
    hwEls.hwBtnPause.addEventListener('click', () => hwLesson('pause'))
    hwEls.hwBtnResume.addEventListener('click', () => hwLesson('resume'))
    hwEls.hwBtnCapture.addEventListener('click', async () => { const r = await api.hwCommand('capture', { hd: true }); hwLog('触发抓拍：' + (r.ok ? 'ok' : r.error)) })
    hwEls.hwBtnCue.addEventListener('click', async () => { const r = await api.hwCommand('cue', 'ready'); hwLog('提示音：' + (r.ok ? 'ok' : r.error)) })
    hwEls.hwBtnSleep.addEventListener('click', async () => { await api.hwCommand('power', 'sleep'); hwLog('指令：休眠') })
    hwEls.hwBtnWake.addEventListener('click', async () => { await api.hwCommand('power', 'wake'); hwLog('指令：唤醒') })
    hwEls.hwBtnReboot.addEventListener('click', async () => { await api.hwCommand('reboot'); hwLog('指令：重启') })
    hwEls.hwBtnInfo.addEventListener('click', async () => { const r = await api.hwCommand('info'); hwLog('查询状态：' + (r.ok ? '已下发' : r.error)) })
    hwEls.hwBtnSpeak.addEventListener('click', async () => {
      const t = hwEls.hwSpeakInput.value.trim(); if (!t) { hwLog('请输入播报内容', 'error'); return }
      if (!(hwStatus.caps && hwStatus.caps.spk)) { hwLog('设备未连接或无喇叭，不能下放播报', 'error'); return }
      const r = await api.hwSpeak(t, {}); hwLog('播报到设备：' + (r.ok ? '完成' : r.error))
    })
  }

  // =========================================================
  // 启动卡片（进入前加载/就绪体验，参考官方 apps/desktop）
  // =========================================================
  const bootEls = {}
  let bootShownStep = ''
  const delay = (ms) => new Promise(r => setTimeout(r, ms))
  function bootCache () { ['boot', 'bootLoading', 'bootProblem', 'bootStep', 'bootProblemDetail'].forEach(id => { bootEls[id] = document.getElementById(id) }) }
  function bootStep (text) {
    if (text === bootShownStep) return
    bootShownStep = text
    bootEls.bootStep.classList.add('is-swapping')
    setTimeout(() => { bootEls.bootStep.textContent = text; bootEls.bootStep.classList.remove('is-swapping') }, 180)
  }
  function bootPhase (p) { bootEls.boot.dataset.phase = p; const problem = (p === 'error'); bootEls.bootLoading.hidden = problem; bootEls.bootProblem.hidden = !problem }
  function enterApp () {
    bootEls.boot.classList.add('hidden')
    // 核心就绪后若正处于 Agent/设置视图，补一次内嵌（地址已变为动态）
    if (isAgentHosted(currentView)) mountAgent(agentHostUrl())
  }

  // bundled 核心进度步骤 -> 文案（与 launcher.mjs 的 step 键对齐）
  const CORE_STEPS = {
    locate: '正在定位内置运行环境……',
    init: '正在初始化 DeepTutor 数据……',
    preparingUi: '正在准备本地界面……',
    startingCore: '正在启动核心服务（首次启动会稍慢）……',
    openingSpace: '正在打开学习空间……',
    ready: '核心已就绪，正在进入……'
  }
  // 核心状态事件（在 init 里只注册一次）：驱动启动卡步骤 + 缓存动态地址
  function handleCoreStatus (s) {
    if (!s) return
    if (s.phase === 'ready' && s.url) coreBaseUrl = s.url
    if (bootEls.boot && !bootEls.boot.classList.contains('hidden') && s.step && CORE_STEPS[s.step]) bootStep(CORE_STEPS[s.step])
  }

  async function runBoot () {
    bootEls.boot.classList.remove('hidden')
    bootPhase('starting')
    bootStep('正在启动桌面壳……')
    if (DT_MODE() === 'bundled') {
      // bundled：真正拉起内置 runtime（Python 后端 + Node 前端），就绪后进入
      await delay(400)
      bootStep(CORE_STEPS.locate)
      let r
      try { r = await api.coreStart() } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
      if (r && r.ok && r.state && r.state.phase === 'ready') {
        coreBaseUrl = r.state.url
        bootStep(CORE_STEPS.ready)
        bootPhase('ready')
        await delay(600)
        enterApp()
      } else {
        bootPhase('error')
        bootEls.bootProblemDetail.textContent = '内置核心启动失败：' + ((r && r.error) || '未知错误')
          + '\n（学习端仍可先行使用；如需连接已手动启动的服务，可在设置中切回 attach）'
      }
      refreshSvc()
      return
    }
    // attach：探测外部已启动的服务
    await delay(500)
    bootStep('正在连接 DeepTutor 核心……')
    const t0 = Date.now()
    const r2 = await api.probeDeeptutor(DT_BASE())
    await delay(Math.max(0, 1400 - (Date.now() - t0))) // 至少呈现 1.4s 的加载感
    if (r2 && r2.ok) {
      bootStep('核心已就绪，正在进入……')
      bootPhase('ready')
      await delay(600)
      enterApp()
    } else {
      bootPhase('error')
      bootEls.bootProblemDetail.textContent = '地址：' + DT_BASE() + '\n探测结果：' + ((r2 && (r2.status || r2.error)) || '不可达') + '\n（Agent 工作台与原生设置需本地 DeepTutor 服务；学习端可先行使用）'
    }
    refreshSvc()
  }

  // =========================================================
  // 顶栏状态 / 初始化
  // =========================================================
  async function refreshSvc () {
    const el = $('#svcStatus')
    const s = await api.serviceStatus()
    const base = DT_BASE()
    const dt = await api.probeDeeptutor(base)
    el.className = 'svc ' + (dt.ok ? 'online' : 'offline')
    el.innerHTML = '<span class="dot"></span>' + (dt.ok ? 'Agent 在线' : 'Agent 离线')
    void s
  }

  async function reloadConfig () { cfg = await api.loadConfig(); syncHwOutRadios(); syncWakeInputs() }

  // =========================================================
  // 就绪自检（三视图「检查」）：主进程查配置/权限/本地状态，渲染层补设备枚举；零计费调用
  // =========================================================
  async function readyCheckMedia (scope) {
    const items = []
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const audioIn = devs.filter((d) => d.kind === 'audioinput').length
      const camIn = devs.filter((d) => d.kind === 'videoinput').length
      items.push({ name: '音频输入设备', ok: audioIn > 0, hint: audioIn ? (audioIn + ' 个麦克风（授权后列表才含设备名）') : '系统未向本应用暴露麦克风：检查系统隐私权限', level: 'must' })
      if (scope === 'study') items.push({ name: '视频输入设备', ok: camIn > 0, hint: camIn ? (camIn + ' 个摄像头') : '无可用摄像头或未授权；不影响纯语音链路', level: 'opt' })
    } catch (e) { items.push({ name: '媒体设备枚举', ok: false, hint: String((e && e.message) || e), level: 'must' }) }
    return items
  }

  function readyItemRow (it) {
    const d = document.createElement('div')
    d.className = 'ready-item ' + (it.ok ? 'ok' : (it.level === 'opt' ? 'warn' : 'fail'))
    d.textContent = (it.ok ? '✓ ' : it.level === 'opt' ? '△ ' : '✗ ') + it.name + (it.hint ? (' — ' + it.hint) : '')
    return d
  }

  async function runReadyCheck (scope, btn, sum, list) {
    if (!btn || !list) return
    btn.disabled = true
    if (sum) sum.textContent = '检查中…'
    try {
      const r = await api.readyCheck(scope)
      const mine = await readyCheckMedia(scope)
      let items = (r && r.ok && Array.isArray(r.items)) ? r.items : []
      if (r && !r.ok) items = items.concat([{ name: '环境检查（主进程）', ok: false, hint: (r && r.error) || '失败', level: 'must' }])
      items = items.concat(mine)
      list.innerHTML = ''
      let missMust = 0, missOpt = 0
      items.forEach((it) => {
        list.appendChild(readyItemRow(it))
        if (!it.ok) { if (it.level === 'opt') missOpt++; else missMust++ }
      })
      const bad = items.filter((it) => !it.ok)
      if (bad.length && sum) {
        const missNames = bad.filter((it) => it.level !== 'opt').map((it) => it.name)
        if (missNames.length) { const tip = document.createElement('div'); tip.className = 'ready-item fail'; tip.textContent = '需补齐：' + missNames.join('、'); list.appendChild(tip) }
      }
      if (sum) sum.textContent = missMust ? ('✗ 缺 ' + missMust + ' 项必需' + (missOpt ? ('，' + missOpt + ' 项建议') : '')) : (missOpt ? ('✓ 必需项就绪（' + missOpt + ' 项建议关注）') : ('✓ 全部通过 · ' + items.length + ' 项'))
      if (scope === 'panorama') panoLog('环境检查完成：' + (sum ? sum.textContent : ''))
    } catch (e) {
      if (sum) sum.textContent = '检查异常'
      const d = document.createElement('div'); d.className = 'ready-item fail'; d.textContent = '✗ 检查异常 — ' + String((e && e.message) || e)
      list.innerHTML = ''; list.appendChild(d)
    } finally { btn.disabled = false }
  }

  function wireReadyChecks () {
    const map = { panorama: 'panoCheck', study: 'studyCheck', hardware: 'hwCheck' }
    Object.keys(map).forEach((scope) => {
      const p = map[scope]
      const btn = document.getElementById(p + 'Btn')
      if (!btn) return
      btn.addEventListener('click', () => runReadyCheck(scope, btn, document.getElementById(p + 'Sum'), document.getElementById(p + 'List')))
    })
  }

  async function init () {
    cfg = await api.loadConfig()
    wireStudy()
    initHardware()
    initPanorama()
    wireReadyChecks()
    $$('.switch .tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)))
    $('.gear').addEventListener('click', () => setView('settings'))
    $('#agentRetry').addEventListener('click', () => mountAgent(agentHostUrl()))
    bootCache()
    api.onCoreStatus && api.onCoreStatus(handleCoreStatus)
    $('#bootRetry').addEventListener('click', runBoot)
    $('#bootEnter').addEventListener('click', () => { bootEls.boot.classList.add('hidden'); setView('study'); refreshSvc() })
    await runBoot()
    setInterval(refreshSvc, 8000)
  }

  // =========================================================
  // 全景学习（F11 · heyclicky 式：屏幕即上下文）
  // 管线：热键/按钮 → 截一帧（仅内存） → 聆听问题 → VLM(屏幕图+问题) → 播报 + 屏幕画标注
  // 复用：gateway.chat('vlm')（计量/熔断照常）、STT/TTS、iTrace 诊断；不新增第二份模型通道。
  // M1 记忆：只存「问题+讲解文字」摘要；M2 跟问：帧有效期内多轮复用同一屏；M3：VAD/按住说话。
  // =========================================================
  const pano = { busy: false, displayId: '', lastQuestion: '我没看清屏幕上的内容，再问一次？', session: null, frameTick: null }
  const panoEls = {}

  // —— M2 会话帧态：一帧截屏后 frameTtlSec 内追问复用同一帧（多轮上下文）；热键/看屏提问始终截新帧 ——
  function panoTtl () { const v = Number(cfg && cfg.panorama && cfg.panorama.frameTtlSec); return Number.isFinite(v) && v >= 0 ? v : 90 }
  function panoFrameRemain () { return Math.max(0, Math.ceil(panoTtl() - (Date.now() - pano.session.ts) / 1000)) }
  function panoSessionFresh () { return !!(pano.session && pano.session.image && panoTtl() > 0 && panoFrameRemain() > 0) }
  function panoNewSession (image) { pano.session = { image, ts: Date.now(), turns: [] } }
  function panoUpdateFrameBar () {
    const el = panoEls.panoFrameBar
    if (!el) return
    if (panoSessionFresh()) {
      el.classList.add('live')
      el.textContent = '当前屏幕帧有效 · 剩余 ' + panoFrameRemain() + ' 秒 · 追问（打字/按住说话）将复用此帧'
    } else {
      el.classList.remove('live')
      el.textContent = (pano.session ? '屏幕帧已过期' : '暂无有效屏幕帧') + ' · 提问时将截新屏'
    }
  }

  // —— M1 学习轨迹：只存文字摘要的讲解记忆（截图从不入库），数据在盘上 config.panorama.memory ——
  async function panoRenderTrace () {
    const el = panoEls.panoTraceList
    if (!el) return
    let mem = []
    try { const r = await api.panoMemoryGet(); mem = (r && r.memory) || [] } catch (e) {}
    el.innerHTML = ''
    if (!mem.length) {
      const d0 = document.createElement('div'); d0.className = 'models'
      d0.textContent = '暂无讲解记忆（只存文字摘要，不含截图）'
      el.appendChild(d0); return
    }
    mem.slice().reverse().forEach((m) => {
      const d = document.createElement('div')
      d.textContent = new Date(m.t || Date.now()).toLocaleString() + ' · 问：' + String(m.q || '') +
        ' → 讲了：' + String(m.a || '').slice(0, 80) + (m.n ? '（屏幕标注 ' + m.n + ' 处）' : '')
      el.appendChild(d)
    })
  }

  function panoSetPill (s) { $$('.pano-pill').forEach(x => x.classList.toggle('on', x.dataset.ps === s)) }

  function panoSay (text) {
    if (panoEls.subtitle) panoEls.subtitle.textContent = text
    appendVoice('a', text)
  }

  async function panoSaveCfg (mutate) {
    try {
      cfg = await api.loadConfig() // 先取最新盘上配置再改，避免覆盖内嵌设置页的并发改动
      cfg.panorama = cfg.panorama || {}
      mutate(cfg.panorama)
      await api.saveConfig(cfg)
      return true
    } catch (e) { panoLog('配置保存失败：' + e.message, 'error'); return false }
  }

  async function panoLoadScreens () {
    const sel = panoEls.display
    if (!sel) return
    const r = await api.panoScreens()
    const prev = pano.displayId
    sel.innerHTML = ''
    const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = '主屏（默认）'
    sel.appendChild(opt0)
    if (r && r.ok) {
      ;(r.screens || []).forEach((x, i) => {
        const o = document.createElement('option'); o.value = x.id
        o.textContent = (x.name || ('屏幕 ' + (i + 1))) + (x.physical ? (' · ' + x.physical.width + '×' + x.physical.height) : '')
        sel.appendChild(o)
      })
    } else {
      const o = document.createElement('option'); o.value = ''; o.textContent = '读取屏幕失败（检查屏幕录制权限）'
      o.disabled = true; sel.appendChild(o)
    }
    if (prev) sel.value = prev
  }

  // —— M3 统一录音管线：VAD 本地断句自动停，或按住说话由外部停；转写走既有 api.transcribe，不新增模型通道 ——
  // opts: { vad, silenceMs=1200（说完静音多久自动停）, onsetMs=15000（全程无语音自动取消）, maxMs=30000（硬上限） }
  // 返回句柄 h：h.result 在录音结束（自动或手动）后 resolve {text}|{error}；h.stop() 立即收尾、h.cancel() 丢弃
  function panoMicOpen (opts) {
    opts = opts || {}
    return new Promise((resolve, reject) => {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        let rec
        try { rec = new MediaRecorder(stream) } catch (e) { stream.getTracks().forEach((t) => t.stop()); reject(new Error('录音初始化失败：' + e.message)); return }
        const chunks = []
        rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data) }
        const h = { ctx: null, vadTimer: null, autoTimer: null, result: null, stop: null, cancel: null }
        let resolveResult = null
        h.result = new Promise((res) => { resolveResult = res })
        let finished = false
        const cleanup = () => { try { stream.getTracks().forEach((t) => t.stop()) } catch (e) {} if (h.ctx) { try { h.ctx.close() } catch (e) {} } }
        const finish = (why) => {
          if (finished) return
          finished = true
          if (h.vadTimer) clearInterval(h.vadTimer)
          if (h.autoTimer) clearTimeout(h.autoTimer)
          if (why === 'cancel') { cleanup(); resolveResult({ error: '录音已取消' }); return }
          rec.onstop = async () => {
            try {
              cleanup()
              if (why === 'noSpeech' || !chunks.length) { resolveResult({ error: why === 'noSpeech' ? '没有听到语音，已取消' : '没有录到声音' }); return }
              const buf = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer()
              const r = await api.transcribe(abToB64(buf))
              if (r && r.ok && r.text && r.text.trim()) resolveResult({ text: r.text.trim() })
              else if (r && !r.ok) resolveResult({ error: '语音识别失败：' + (r.error || '未知') + '（检查 STT 网关）' })
              else resolveResult({ error: '没有听清，请再试一次' })
            } catch (e) { resolveResult({ error: '识别异常：' + e.message }) }
          }
          try { rec.stop() } catch (e) { resolveResult({ error: '录音停止失败：' + e.message }) }
        }
        h.stop = () => finish('')
        h.cancel = () => finish('cancel')
        // VAD：本地能量阈值断句（不触网）；说完静音 silenceMs 自动停；无语音 onsetMs 取消；maxMs 兜底
        if (opts.vad) {
          let an = null, abuf = null
          try {
            h.ctx = new (window.AudioContext || window.webkitAudioContext)()
            an = h.ctx.createAnalyser(); an.fftSize = 2048
            h.ctx.createMediaStreamSource(stream).connect(an)
            abuf = new Float32Array(an.fftSize)
          } catch (e) { an = null }
          const began = Date.now()
          let heard = false, lastVoice = 0
          h.vadTimer = setInterval(() => {
            const now = Date.now()
            if (an) {
              an.getFloatTimeDomainData(abuf)
              let s = 0
              for (let i = 0; i < abuf.length; i++) s += abuf[i] * abuf[i]
              if (Math.sqrt(s / abuf.length) > 0.012) { heard = true; lastVoice = now }
            }
            if (heard && now - lastVoice >= (opts.silenceMs || 1200)) finish('')
            else if (!heard && now - began >= (opts.onsetMs || 15000)) finish('noSpeech')
            else if (now - began >= (opts.maxMs || 30000)) finish('')
          }, 100)
        } else if (opts.maxMs) {
          h.autoTimer = setTimeout(() => finish(''), opts.maxMs)
        }
        try { rec.start() } catch (e) { cleanup(); reject(new Error('录音失败：' + e.message)) }
        resolve(h)
      }, (e) => reject(new Error('麦克风不可用：' + e.message)))
    })
  }

  // 聆听一次提问：学习端麦克风开着就复用其分段（喊唤醒词或对话窗内直接说）；
  // 否则按 VAD 开关走自动断句（默认，说完停顿即结束）或固定 5 秒临时录音（关）。
  function panoListenOnce () {
    if (study.micOn) return Promise.resolve({ usingStudyMic: true, text: '已在学习麦克风分段中：请直接对着麦克风说问题，5 秒内会被识别并走唤醒门控' })
    if ((cfg.panorama || {}).vad === false) {
      // 老行为：固定 5 秒硬截断
      return panoMicOpen({ maxMs: 5000 }).then((h) => h.result).catch((e) => ({ error: String((e && e.message) || e) }))
    }
    return panoMicOpen({ vad: true }).then((h) => h.result).catch((e) => ({ error: String((e && e.message) || e) }))
  }

  // 主管线：截新帧（或复用会话帧）→（可选）聆听问题 → VLM 多轮 → 播报 + 屏幕画标注。
  // viaHotkey/大按钮 = 截新帧开新会话；reuseOk（打字/按住说话追问）= 帧有效期内复用同一帧多轮。
  async function panoCaptureAndAsk (question, viaHotkey, reuseOk) {
    if (pano.busy) { panoLog('上一次全景请求还在处理中，本次已忽略', 'error'); return }
    pano.busy = true
    panoSetPill('capture')
    try {
      const canReuse = !!(reuseOk && String(question || '').trim() && panoSessionFresh())
      let image = null
      let history = []
      if (canReuse) {
        image = pano.session.image
        history = pano.session.turns.slice(-4)
        panoLog('↺ 复用当前屏幕帧追问（第 ' + (history.length + 1) + ' 轮 · 剩余 ' + panoFrameRemain() + ' 秒，未截新屏）')
      } else {
        panoLog((viaHotkey ? '热键触发' : '按钮触发') + '：截取屏幕一帧（仅内存，即用即弃），开新会话')
        const cap = await api.panoCapture(pano.displayId || undefined)
        if (cap && cap.ok) {
          image = cap.dataUrl
          panoNewSession(image)
          panoLog('✓ 已捕捉「' + (cap.screen || '主屏') + '」' + cap.width + '×' + cap.height + '；未落盘')
        } else {
          panoLog('⚠ 截屏失败：' + ((cap && cap.error) || '未知') + '（本次将仅按问题文字作答）', 'error')
          if (cap && cap.needPermission && panoEls.permMsg) panoEls.permMsg.textContent = '需要屏幕录制权限：点上方按钮打开系统设置，勾选后重启应用'
        }
      }
      let text = String(question || '').trim()
      if (!text) {
        panoSetPill('listen')
        panoLog('开始聆听：请说出你想问的问题' + ((cfg.panorama || {}).vad === false ? '（固定 5 秒）' : '（说完停顿自动结束）'))
        const l = await panoListenOnce()
        if (l.usingStudyMic) {
          // 学习麦克风在转：本按钮不重复起录，提示用既有唤醒链路提问即可
          panoLog('· ' + l.text); panoSay(l.text)
          return
        }
        if (l.text) {
          text = l.text
          panoLog('✓ 问题识别：' + text)
        } else {
          panoLog('⚠ ' + (l.error || '没有听清'), 'error')
          panoSay('我没有听到问题。')
          await speakOut('我没有听到问题。', false)
          return
        }
      }
      if (!text) { panoSay('请先说或输入你的问题。'); return }
      pano.lastQuestion = text
      panoSetPill('think')
      panoLog('→ 请求 VLM（vlm→catalog llm' + (image ? ' · 附屏幕截图' : '') + (history.length ? ' · 会话第 ' + (history.length + 1) + ' 轮' : '') + '）：' + text)
      const r = await api.panoAsk({ question: text, image, displayId: pano.displayId || undefined, annotate: !!(panoEls.annotate && panoEls.annotate.checked), history })
      if (!r || !r.ok) {
        const msg = (r && r.tripped) ? '今日调用已达上限（熔断），请明天再试或调整阈值。' : ('全景讲解失败：' + ((r && r.error) || '未知错误'))
        panoSay(msg); panoLog('✗ ' + msg, 'error')
        await speakOut(msg, false)
        return
      }
      // 同帧才追加轮次（期间若被热键重开会话则自然丢弃，不会串帧）
      if (pano.session && image && image === pano.session.image) pano.session.turns.push({ q: text, a: String(r.text || '').slice(0, 600) })
      panoSetPill('speak')
      panoSay(r.text || '')
      panoLog('✓ 已应答（' + (r.gw || 'catalog') + '，' + String(r.text || '').length + ' 字 · 标注 ' + ((r.annotations && r.annotations.length) || 0) + ' 处' + (r.turn > 1 ? ' · 第 ' + r.turn + ' 轮' : '') + '） → 播报')
      if (r.annotations && r.annotations.length) {
        await api.panoDraw(r.annotations, { displayId: r.displayId || pano.displayId || undefined })
        panoLog('▣ 已在屏幕上画出 ' + r.annotations.length + ' 处标注（点“清除屏幕标注”或到期自动清除）')
      } else if (r.annotateFailed) {
        panoLog('· 标注解析失败/无把握，已降级纯语音讲解')
      }
      await speakOut(r.text || '', false)
      panoRenderTrace() // M1：新摘要进学习轨迹
    } finally {
      pano.busy = false
      panoSetPill('idle')
      panoUpdateFrameBar()
    }
  }

  // M3 按住说话：按下开口、松手即说即答（追问复用会话帧）；短按(<400ms)切为 VAD 自动聆听。
  let panoPttH = null
  let panoPttDownAt = 0
  function panoPttReset (btn) { btn.classList.remove('recording'); btn.textContent = '按住说话（追问 · 复用当前屏幕帧）' }
  async function panoPttDown (btn, ev) {
    ev.preventDefault()
    if (pano.busy || panoPttH) return
    if (btn.setPointerCapture && ev.pointerId != null) { try { btn.setPointerCapture(ev.pointerId) } catch (e) {} }
    panoPttDownAt = Date.now()
    try {
      panoPttH = await panoMicOpen({ maxMs: 30000 }) // 按住不放也有 30 秒硬上限兜底
      btn.classList.add('recording'); btn.textContent = '🎤 说话中… 松开发送'
    } catch (e) { panoPttH = null; panoLog('⚠ ' + e.message, 'error') }
  }
  async function panoPttUp (btn) {
    const h = panoPttH
    if (!h) return
    panoPttH = null
    panoPttReset(btn)
    if (Date.now() - panoPttDownAt < 400) {
      // 短按 = 切换为自动聆听（VAD 断句），满足“即点即说”习惯
      h.cancel()
      await panoAutoListenAndAsk()
      return
    }
    h.stop()
    const r = await h.result
    if (r.text) panoCaptureAndAsk(r.text, false, true)
    else panoLog('⚠ ' + (r.error || '没有听清'), 'error')
  }
  async function panoAutoListenAndAsk () {
    if (study.micOn) { panoLog('· 学习麦克风在转：请直接对麦克风说问题，走既有唤醒链路'); return }
    panoSetPill('listen')
    panoLog('短按已切换自动聆听：说完停顿即被识别（最长 15 秒）')
    try {
      const h = await panoMicOpen({ vad: true })
      const r = await h.result
      if (r.text) await panoCaptureAndAsk(r.text, false, true)
      else {
        panoLog('⚠ ' + (r.error || '没有听清'), 'error')
        panoSay('我没有听到问题。'); await speakOut('我没有听到问题。', false)
      }
    } catch (e) { panoLog('⚠ ' + e.message, 'error') }
  }

  async function panoApplyHotkey () {
    const v = String(panoEls.hotkey.value || '').trim() || 'Control+Shift+Space'
    const old = (cfg.panorama && cfg.panorama.hotkey) || 'Control+Shift+Space'
    const r = await api.panoSetHotkey(v)
    if (r && r.ok) {
      await panoSaveCfg((p) => { p.hotkey = v })
      panoLog('✓ 全局热键已生效：' + v + (v !== old ? '（原 ' + old + ' 已释放）' : ''))
    } else {
      panoLog('热键注册失败：' + ((r && r.error) || '未知') + '（可能与系统或其他应用冲突）', 'error')
      panoEls.hotkey.value = old
    }
  }

  function initPanorama () {
    ;['panoAskBtn', 'panoAskText', 'panoTextQ', 'panoClearBtn', 'panoSubtitle', 'panoHotkey', 'panoHotkeyApply', 'panoDisplay', 'panoRefresh', 'panoSize', 'panoHold', 'panoAnnotate', 'panoPerm', 'panoPermMsg',
      'panoPttBtn', 'panoFrameBar', 'panoFrameTtl', 'panoVad', 'panoMemOn', 'panoTraceList', 'panoTraceClear']
      .forEach(id => { panoEls[id] = document.getElementById(id); if (panoEls[id]) panoEls[id].id_l = id })
    panoEls.subtitle = panoEls.panoSubtitle
    panoEls.display = panoEls.panoDisplay
    panoEls.hotkey = panoEls.panoHotkey
    panoEls.annotate = panoEls.panoAnnotate
    panoEls.permMsg = panoEls.panoPermMsg
    panoSetPill('idle')
    // 配置回显
    const p = (cfg && cfg.panorama) || {}
    panoEls.panoHotkey.value = p.hotkey || 'Control+Shift+Space'
    panoEls.panoSize.value = p.annotationSize || 'mid'
    panoEls.panoHold.value = String(p.annotationHold != null ? p.annotationHold : 45)
    panoEls.panoAnnotate.checked = p.annotate !== false
    if (panoEls.panoFrameTtl) panoEls.panoFrameTtl.value = String(p.frameTtlSec != null ? p.frameTtlSec : 90)
    if (panoEls.panoVad) panoEls.panoVad.checked = p.vad !== false
    if (panoEls.panoMemOn) panoEls.panoMemOn.checked = p.memoryOn !== false
    pano.displayId = p.displayId || ''
    panoLoadScreens().then(() => { if (pano.displayId) panoEls.panoDisplay.value = pano.displayId })
    panoRenderTrace()
    panoUpdateFrameBar()
    if (!pano.frameTick) pano.frameTick = setInterval(panoUpdateFrameBar, 1000) // 帧态条：剩余秒数倒数
    // 热键事件（主进程 globalShortcut → 唤起窗口 → 截新帧开新会话 + 聆听）
    api.onPanoHotkey && api.onPanoHotkey(() => { if (!pano.busy) panoCaptureAndAsk('', true) })
    // 按钮
    panoEls.panoAskBtn.addEventListener('click', () => panoCaptureAndAsk('', false))
    panoEls.panoAskText.addEventListener('click', () => {
      const q = String(panoEls.panoTextQ.value || '').trim()
      if (!q) { panoLog('请先输入问题', 'error'); return }
      panoCaptureAndAsk(q, false, true) // 追问：帧有效期内复用同一帧多轮
    })
    panoEls.panoTextQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') panoEls.panoAskText.click() })
    // 按住说话（M3）：pointer 事件兼容鼠标/触摸；移出按钮也视为松手发送
    if (panoEls.panoPttBtn) {
      const btn = panoEls.panoPttBtn
      btn.addEventListener('pointerdown', (ev) => { panoPttDown(btn, ev) })
      btn.addEventListener('pointerup', () => { panoPttUp(btn) })
      btn.addEventListener('pointercancel', () => {
        if (panoPttH) { panoPttH.cancel(); panoPttH = null; panoPttReset(btn) }
      })
      btn.addEventListener('contextmenu', (ev) => ev.preventDefault())
    }
    panoEls.panoClearBtn.addEventListener('click', async () => { await api.panoClear(); panoLog('已清除屏幕标注') })
    panoEls.panoHotkeyApply.addEventListener('click', panoApplyHotkey)
    panoEls.panoHotkey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); panoApplyHotkey() } })
    panoEls.panoRefresh.addEventListener('click', () => panoLoadScreens())
    panoEls.panoDisplay.addEventListener('change', async () => {
      pano.displayId = panoEls.panoDisplay.value
      await panoSaveCfg((x) => { x.displayId = pano.displayId })
      panoLog('捕捉目标屏幕：' + (panoEls.panoDisplay.selectedOptions[0] ? panoEls.panoDisplay.selectedOptions[0].textContent : '主屏'))
    })
    panoEls.panoSize.addEventListener('change', async () => { await panoSaveCfg((x) => { x.annotationSize = panoEls.panoSize.value }); panoLog('标注线宽：' + panoEls.panoSize.value) })
    panoEls.panoHold.addEventListener('change', async () => { await panoSaveCfg((x) => { x.annotationHold = +panoEls.panoHold.value }); panoLog('标注停留：' + (+panoEls.panoHold.value > 0 ? panoEls.panoHold.value + ' 秒自动清除' : '常驻（手动清除）')) })
    panoEls.panoAnnotate.addEventListener('change', async () => { await panoSaveCfg((x) => { x.annotate = panoEls.panoAnnotate.checked }); panoLog('屏幕标注：' + (panoEls.panoAnnotate.checked ? '开' : '关（纯语音讲解）')) })
    if (panoEls.panoFrameTtl) panoEls.panoFrameTtl.addEventListener('change', async () => {
      await panoSaveCfg((x) => { x.frameTtlSec = +panoEls.panoFrameTtl.value })
      panoLog('追问窗口：' + (+panoEls.panoFrameTtl.value > 0 ? panoEls.panoFrameTtl.value + ' 秒内复用同一帧多轮对话' : '每问必截新屏'))
    })
    if (panoEls.panoVad) panoEls.panoVad.addEventListener('change', async () => {
      await panoSaveCfg((x) => { x.vad = panoEls.panoVad.checked })
      panoLog('语音自动断句：' + (panoEls.panoVad.checked ? '开（说完停顿即结束）' : '关（固定 5 秒临时录音）'))
    })
    if (panoEls.panoMemOn) panoEls.panoMemOn.addEventListener('change', async () => {
      await panoSaveCfg((x) => { x.memoryOn = panoEls.panoMemOn.checked })
      panoLog('讲解记忆：' + (panoEls.panoMemOn.checked ? '开（只存文字摘要，不含截图）' : '关'))
    })
    if (panoEls.panoTraceClear) panoEls.panoTraceClear.addEventListener('click', async () => {
      const r = await api.panoMemoryClear()
      if (r && r.ok) { panoLog('已清空学习轨迹（仅文字摘要，本就不含截图）'); panoRenderTrace() }
      else panoLog('清空失败：' + ((r && r.error) || '未知'), 'error')
    })
    panoEls.panoPerm.addEventListener('click', async () => {
      const r = await api.panoOpenPermission()
      panoEls.permMsg.textContent = r && r.ok ? '已在系统设置打开「屏幕录制」：勾选本应用后需重启应用生效' : ((r && r.error) || '打开失败')
    })
  }

  document.addEventListener('DOMContentLoaded', init)
})()
