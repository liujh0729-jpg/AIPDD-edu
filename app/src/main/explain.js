// F7 多模态讲解：网页讲解（LLM 生成 HTML，前端讲解画布预览）+ 可选视频导出（HyperFrames）
// 内容安全（FR-7.7）：仅渲染本地生成的讲解 HTML，剥离外部脚本；视频导出缺依赖时优雅降级不报错。
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execSync } = require('child_process')

function dir (...s) { return path.join(app.getPath('userData'), ...s) }
function ensure (p) { fs.mkdirSync(p, { recursive: true }); return p }

// 清洗 LLM 返回的 HTML：去掉 <script>/<iframe>/on* 事件/javascript: 外链（FR-7.7）
function sanitize (html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
}

// 组装一份自包含的讲解页（内联样式 + 步进动画），可直接 iframe 预览
function buildPage (title, stepsHtml) {
  const body = sanitize(stepsHtml)
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f6fb;color:#1f2733;margin:0;padding:20px;line-height:1.6;}' +
    'h2{color:#3b6ef6;font-size:17px;margin:0 0 6px} .step{background:#fff;border:1px solid #e7ebf2;border-left:3px solid #3b6ef6;border-radius:12px;padding:13px 15px;margin:10px 0;box-shadow:0 1px 2px rgba(16,24,40,.05);' +
    'opacity:0;transform:translateY(8px);animation:in .5s forwards} .step b{color:#6d5efc}' +
    '.step:nth-child(1){animation-delay:.1s}' +
    '.step:nth-child(2){animation-delay:.6s}.step:nth-child(3){animation-delay:1.1s}.step:nth-child(4){animation-delay:1.6s}' +
    '.step:nth-child(5){animation-delay:2.1s}.step:nth-child(6){animation-delay:2.6s}' +
    '@keyframes in{to{opacity:1;transform:none}}</style></head><body>' +
    '<h2>' + String(title || '解题讲解').replace(/[<>]/g, '') + '</h2>' + body + '</body></html>'
}

function envOk () {
  try {
    const nodeVer = parseInt(execSync('node -v', { timeout: 4000 }).toString().replace('v', ''), 10)
    execSync('which ffmpeg', { timeout: 4000 })
    return nodeVer >= 18
  } catch (e) { return false }
}

// FR-7.2：把讲解 HTML 用 HyperFrames 渲染为 MP4（异步、不阻塞对话；缺依赖降级）
function exportVideo (html, meta, onProgress) {
  if (!envOk()) {
    onProgress && onProgress({ ok: false, degraded: true, note: '环境未就绪（需 Node 18+/FFmpeg），已降级为仅网页讲解。' })
    return { ok: false, degraded: true }
  }
  const outDir = ensure(dir('explains'))
  const id = Date.now().toString(36)
  const htmlPath = path.join(outDir, id + '.html')
  fs.writeFileSync(htmlPath, html, 'utf8')
  const args = ['--yes', 'hyperframes', 'render', htmlPath, '--out', path.join(outDir, id + '.mp4')]
  const p = spawn('npx', args)
  let log = ''
  p.stdout.on('data', d => { log += d; onProgress && onProgress({ ok: true, running: true, log: log.slice(-400) }) })
  p.stderr.on('data', d => { log += d })
  p.on('exit', code => {
    const mp4 = path.join(outDir, id + '.mp4')
    const ok = code === 0 && fs.existsSync(mp4)
    onProgress && onProgress({ ok, file: ok ? mp4 : null, note: ok ? '视频已生成' : '渲染失败：' + log.slice(-200) })
  })
  return { ok: true, started: true, id, meta }
}

module.exports = { sanitize, buildPage, exportVideo, envOk }
