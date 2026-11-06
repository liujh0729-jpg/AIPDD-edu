// F11 全景学习（heyclicky 式「屏幕即上下文」）：截屏 + 全局热键 + 透明标注覆盖窗 + 标注协议
// 隐私硬约束（对齐产品原理）：仅在你按下按钮/热键的那一刻截一帧，截图只在内存即用即弃、绝不落盘；
// 覆盖层只负责"画"（鼠标穿透、永不抢焦点），讲解文本走既有 TTS/字幕，模型调用走既有 gateway.chat（计量/熔断照常）。
const { BrowserWindow, screen, shell, systemPreferences, desktopCapturer } = require('electron')
const path = require('path')
const config = require('./config')

// —— 标注协议（与 panorama.js 的 system prompt 约定一致）——
// VLM 输出：讲解文本 + 一段 JSON 数组 [{type: circle|box|arrow|label|pointer, x,y,x2,y2,w,h（归一化 0~1）, text, color}]
// 解析失败/越界 → 降级纯讲解（不画），绝不因为标注问题影响回答。
const SHAPE_TYPES = ['circle', 'box', 'arrow', 'label', 'pointer']
const ANNOTATION_RE = /```json\s*([\s\S]*?)```|(\[[\s\S]*\])/

function clamp01 (v) { return Math.max(0, Math.min(1, Number(v))) }
function validShape (s) {
  if (!s || typeof s !== 'object') return false
  if (!SHAPE_TYPES.includes(s.type)) return false
  const nums = [s.x, s.y, s.x2, s.y2, s.w, s.h].filter((n) => n !== undefined && n !== null)
  return nums.every((n) => Number.isFinite(Number(n)))
}

// 从模型回复中剥离标注 JSON，返回 { text, annotations }
function parseAnnotation (content) {
  const raw = String(content || '')
  const m = raw.match(ANNOTATION_RE)
  if (!m) return { text: raw.trim(), annotations: [] }
  let arr = null
  try { arr = JSON.parse(m[1] || m[2]) } catch (e) { arr = null }
  if (!Array.isArray(arr)) return { text: raw.trim(), annotations: [] }
  const annotations = arr.filter(validShape).map((s) => ({
    type: s.type,
    x: clamp01(s.x), y: clamp01(s.y),
    x2: s.x2 === undefined ? undefined : clamp01(s.x2),
    y2: s.y2 === undefined ? undefined : clamp01(s.y2),
    w: s.w === undefined ? 0.1 : Math.min(1, Number(s.w) || 0.1),
    h: s.h === undefined ? 0.1 : Math.min(1, Number(s.h) || 0.1),
    text: String(s.text || '').slice(0, 60),
    color: /^#[0-9a-fA-F]{6}$/.test(String(s.color || '')) ? String(s.color) : undefined
  }))
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim()
  return { text, annotations }
}

// 发给 VLM 的系统提示：屏幕坐标 grounding + 输出协议。归一化坐标避免像素歧义。
const ANNOTATE_SYSTEM = (baseSystem) => baseSystem +
  '\n\n你正看着用户屏幕上的一帧画面（整张截图）。讲解时，请在正文之后另起一段，输出一个 ```json 代码块，' +
  '内容是标注数组，把关键点直接画在这张屏幕上。坐标系：以截图宽、高为 1 的归一化坐标（0~1），x 向右、y 向下。' +
  '每个标注对象格式：{"type":"circle|box|arrow|label|pointer","x":0.5,"y":0.3,"w":0.2,"h":0.1,"x2":0.7,"y2":0.6,"text":"短标签","color":"#E23B3B"}。' +
  'circle/box/label 用 x,y,w,h 定位；arrow 用 x,y 到 x2,y2 画箭头；pointer 用 x,y 指示一个点（拿不准框的范围时用它“指一下”）。最多 4 个标注，只圈真正关键的位置；' +
  '没有把握就不要输出标注（输出空数组 []）。除这个 json 代码块外不要输出其它 JSON 或 Markdown 代码块。'

// ———————————————————————————— 截图 ————————————————————————————
// 列出可选屏幕（desktopCapturer id 与 Electron display 关联，供设置"捕捉哪块屏"）
async function listScreens () {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    const displays = screen.getAllDisplays()
    return {
      ok: true,
      screens: sources.map((s, i) => {
        const d = displays[i] || {}
        const scale = (d.scaleFactor || 1)
        return {
          id: s.id,
          name: String(s.name || ('屏幕 ' + (i + 1))),
          bounds: d.bounds ? { x: d.bounds.x, y: d.bounds.y, width: Math.round(d.bounds.width), height: Math.round(d.bounds.height) } : null,
          scale,
          physical: d.bounds ? { width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale) } : null
        }
      })
    }
  } catch (e) {
    // macOS 未授予屏幕录制权限时 getSources 会抛错或返回空——给出明确引导
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 单帧截屏 → dataUrl（只在内存，不落盘）。maxWidth 缩放控制 token 量。
async function capture (displayId) {
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status === 'denied' || status === 'restricted') {
        return { ok: false, needPermission: true, error: 'macOS 未授予屏幕录制权限' }
      }
    } catch (e) { /* 老版本无此 API，继续尝试 */ }
  }
  let sources
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      ...(displayId ? { fetchWindowTabs: false } : {})
    })
  } catch (e) {
    return { ok: false, error: '截屏失败：' + String((e && e.message) || e) + '（macOS 请在系统设置→隐私与安全性→屏幕录制中允许本应用）' }
  }
  if (!sources || !sources.length) return { ok: false, needPermission: true, error: '未获取到屏幕源（通常需要授予屏幕录制权限）' }
  let src = sources[0]
  if (displayId) {
    const hit = sources.find((s) => s.id === displayId || s.display_id === String(displayId))
    if (hit) src = hit
  }
  const img = src.thumbnail
  if (!img || img.isEmpty()) return { ok: false, needPermission: true, error: '屏幕画面为空——macOS 首次授权后需重启本应用生效' }
  // 宽度收敛到 ≤1568（多数 VLM 的友好尺寸），保持宽高比
  const { width, height } = img.getSize()
  let out = img
  if (width > 1568) out = img.resize({ width: 1568 })
  return { ok: true, dataUrl: out.toDataURL({ format: 'jpeg', quality: 0.72 }), width, height, screen: String(src.name || '') }
}

function openScreenPermissionSettings () {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    return { ok: true }
  }
  return { ok: false, error: '当前系统无需单独授权屏幕录制' }
}

// ———————————————————————— 透明标注覆盖窗 ————————————————————————
// 方案 A：真覆盖层。全屏透明、鼠标穿透、置顶、可随截图目标屏；只画不讲、即用即清。
// 入画动效（heyclicky 手绘感）：描边类图形用 dasharray/dashoffset 做“笔迹生长”，依次错开；pointer 为脉冲圆点。
let overlay = null
let overlayDisplayId = null

function overlayPage () {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;cursor:default}
  svg{position:absolute;inset:0;width:100%;height:100%}
  .lbl{position:absolute;font:600 13px/1.4 -apple-system,"PingFang SC",sans-serif;color:#fff;background:rgba(20,20,20,.82);
    padding:3px 9px;border-radius:8px;white-space:nowrap;transform:translate(-50%,-130%);box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:340px;
    animation:pano-fade .3s ease-out both}
  @keyframes pano-fade{from{opacity:0}to{opacity:1}}
  .pulse{transform-box:fill-box;transform-origin:center;animation:pano-pulse 1.4s ease-out infinite}
  @keyframes pano-pulse{0%{transform:scale(.5);opacity:.95}70%{transform:scale(2.1);opacity:0}100%{transform:scale(2.1);opacity:0}}
  .cap{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);font:500 12px/1 -apple-system,"PingFang SC",sans-serif;
    color:#fff;background:rgba(20,20,20,.6);padding:6px 12px;border-radius:999px;opacity:0;transition:opacity .3s}
  .cap.on{opacity:1}
  </style></head><body><svg id="s"><defs>
  <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs></svg><div id="labels"></div><div id="cap" class="cap"></div>
  <script>
  const NS='http://www.w3.org/2000/svg';const svg=document.getElementById('s');const box=document.getElementById('labels');const cap=document.getElementById('cap')
  let timer=null
  function el(n,at){const e=document.createElementNS(NS,n);for(const k in at)e.setAttribute(k,at[k]);return e}
  function clear(){while(svg.lastChild&&svg.lastChild.tagName!=='defs')svg.removeChild(svg.lastChild);box.innerHTML='';cap.classList.remove('on');if(timer){clearTimeout(timer);timer=null}}
  // 笔迹生长：按周长设 dasharray，下一帧把 dashoffset 收到 0；不支持 getTotalLength 的降级直接显示
  function grow(e,delay){try{const L=e.getTotalLength?e.getTotalLength():0;if(!L)return;e.style.strokeDasharray=L;e.style.strokeDashoffset=L;
    requestAnimationFrame(()=>{e.style.transition='stroke-dashoffset .5s ease-out '+delay+'s';e.style.strokeDashoffset='0'})}catch(_){}}
  window.panoramaAPI.onDraw((p)=>{
    clear()
    const W=innerWidth,H=innerHeight
    let si=0 // 描边图形序号→错峰入画
    ;(p.shapes||[]).forEach(s=>{
      const color=s.color||'#E23B3B';const sw=2+(p.size==='large'?4:p.size==='small'?1:2)
      if(s.type==='arrow'){
        const x1=(s.x2!==undefined?s.x2:s.x+s.w)*W,y1=(s.y2!==undefined?s.y2:s.y+s.h)*H
        const e=el('path',{d:'M'+(s.x*W)+' '+(s.y*H)+' Q '+((s.x*W+x1)/2+(y1-s.y*H)*.2)+' '+((s.y*H+y1)/2-(x1-s.x*W)*.2)+' '+x1+' '+y1,
          stroke:color,'stroke-width':sw,fill:'none','stroke-linecap':'round','marker-end':'url(#ah)'})
        svg.appendChild(e);grow(e,si++*0.35)
      }else if(s.type==='box'){
        const e=el('rect',{x:s.x*W,y:s.y*H,width:Math.max(8,s.w*W),height:Math.max(8,s.h*H),rx:10,stroke:color,'stroke-width':sw,fill:'none'})
        svg.appendChild(e);grow(e,si++*0.35)
      }else if(s.type==='circle'){
        const e=el('ellipse',{cx:(s.x+s.w/2)*W,cy:(s.y+s.h/2)*H,rx:Math.max(6,s.w*W/2),ry:Math.max(6,s.h*H/2),stroke:color,'stroke-width':sw,fill:'none'})
        svg.appendChild(e);grow(e,si++*0.35)
      }else if(s.type==='pointer'){
        // 实心圆点 + 外扩脉冲环：模型拿不准框范围时的“指一下”
        svg.appendChild(el('circle',{cx:s.x*W,cy:s.y*H,r:7,fill:color,'fill-opacity':.9}))
        svg.appendChild(el('circle',{cx:s.x*W,cy:s.y*H,r:16,fill:'none',stroke:color,'stroke-width':3,class:'pulse'}))
        si++
      }
      if(s.type==='label'||s.text){
        const d=document.createElement('div');d.className='lbl';d.textContent=s.text||''
        d.style.left=((s.type==='pointer'?s.x:s.x+(s.w||0)/2)*W)+'px'
        d.style.top=((s.type==='pointer'?s.y:s.type==='arrow'?(s.y+(s.y2-s.y)/2):s.y+s.h/2)*H)+'px'
        if(s.color&&s.type==='label')d.style.background=s.color
        d.style.animationDelay=(0.35+si*0.35)+'s'
        if(s.text)box.appendChild(d)
      }
    })
    if(p.holdMs){cap.textContent='全景讲解标注 · 即将自动清除';cap.classList.add('on');timer=setTimeout(clear,p.holdMs)}
  })
  window.panoramaAPI.onClear(clear)
  </script></body></html>`
}

function ensureOverlay (displayId) {
  if (overlay && !overlay.isDestroyed() && overlayDisplayId === (displayId || null)) return overlay
  if (overlay && !overlay.isDestroyed()) { try { overlay.close() } catch (e) {} overlay = null }
  const displays = screen.getAllDisplays()
  let target = displays[0]
  if (displayId) {
    const sourcesHit = displays.find((d) => String(d.id) === String(displayId))
    if (sourcesHit) target = sourcesHit
  }
  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.setMenuBarVisibility(false)
  try { win.setAlwaysOnTop(true, 'screen-saver') } catch (e) { win.setAlwaysOnTop(true) }
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (e) {}
  win.setIgnoreMouseEvents(true) // 鼠标穿透：覆盖层只画不拦，用户照常操作下层内容
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(overlayPage()))
  overlay = win
  overlayDisplayId = displayId || null
  return overlay
}

async function draw (shapes, opts = {}) {
  const cfg = config.load()
  const pano = cfg.panorama || {}
  if (!shapes || !shapes.length) return { ok: true, drawn: 0 }
  const win = ensureOverlay(opts.displayId || pano.displayId || null)
  const size = opts.size || pano.annotationSize || 'mid'
  const holdS = Number(opts.holdSec != null ? opts.holdSec : (pano.annotationHold != null ? pano.annotationHold : 45))
  win.showInactive()
  win.webContents.send('overlay:draw', { shapes, size, holdMs: holdS > 0 ? holdS * 1000 : 0 })
  return { ok: true, drawn: shapes.length }
}

function clearOverlay () {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:clear', {})
  return { ok: true }
}

function hideOverlay () {
  if (overlay && !overlay.isDestroyed()) { try { overlay.close() } catch (e) {} }
  overlay = null
  overlayDisplayId = null
  return { ok: true }
}

// ———————————————————————————— 全局热键 ————————————————————————————
// 默认 Control+Shift+Space（heyclicky 式：应用后台/其它全屏时也响应）。注册成功后
// 主窗口会被唤起并收到 pano:hotkey，由渲染层执行 截屏→聆听→问答 管线。
let registeredAccelerator = ''
let onHotkey = null

function registerHotkey (acc) {
  const { globalShortcut } = require('electron')
  const key = String(acc || 'Control+Shift+Space').trim()
  if (registeredAccelerator && registeredAccelerator !== key) {
    try { globalShortcut.unregister(registeredAccelerator) } catch (e) {}
    registeredAccelerator = ''
  }
  if (registeredAccelerator === key) return { ok: true, accelerator: key, reused: true }
  let win = null
  try { win = require('electron').BrowserWindow.getAllWindows()[0] } catch (e) {}
  const ok = globalShortcut.register(key, () => {
    if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); if (!win.isFocused()) win.focus() }
    if (onHotkey) { try { onHotkey() } catch (e) {} }
  })
  if (!ok) return { ok: false, error: '热键注册失败（可能与其他应用冲突）：' + key }
  registeredAccelerator = key
  return { ok: true, accelerator: key }
}

function unregisterAll () {
  try { const { globalShortcut } = require('electron'); if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator) } catch (e) {}
  registeredAccelerator = ''
}

// 就绪自检用：当前已注册的全局热键（空=未注册）
function hotkeyState () { return { registered: registeredAccelerator } }

function init (handlers) {
  onHotkey = handlers && handlers.onHotkey
  return { ok: true }
}

module.exports = {
  capture,
  listScreens,
  openScreenPermissionSettings,
  draw,
  clearOverlay,
  hideOverlay,
  registerHotkey,
  unregisterAll,
  hotkeyState,
  init,
  parseAnnotation,
  ANNOTATE_SYSTEM
}
