// F2 语音：TTS 用 macOS 系统 `say`（零成本、离线、不出网），STT 走 F6 网关（仅用户语音动作触发）
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const config = require('./config')
const gateway = require('./gateway')

let current = null // 当前 say 子进程，用于 barge-in 打断（FR-2.3）

const RATE = { slow: 150, mid: 185, fast: 230 }

// 英语模式用英文嗓音（可选可替换：将来接管理端嗓音列表时由 opts.voice 覆盖）
function pickVoice (isEnglish) {
  return isEnglish ? 'Samantha' : null
}

// FR-2.2 音量：映射到 `say -a`（平均振幅百分比，有效区间 10~100）；未配置则不干预
function ampArg (cfg) {
  const v = Number(cfg.ttsVolume)
  if (!Number.isFinite(v)) return null
  return String(Math.max(10, Math.min(100, Math.round(v))))
}

function speak (text, opts = {}) {
  return new Promise((resolve) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    if (!clean) return resolve({ ok: true, empty: true })
    const cfg = config.load()
    // FR-2.5 静音模式：关闭 AI 主动说话，只保留被动应答（proactive 标记由调用方声明）
    if (cfg.muteMode && opts.proactive) return resolve({ ok: true, muted: true })
    stop() // 播报新内容前打断上一句
    const args = []
    const voice = opts.voice || pickVoice(!!opts.english)
    if (voice) args.push('-v', voice)
    args.push('-r', String(RATE[cfg.ttsRate] || RATE.mid))
    const amp = ampArg(cfg)
    if (amp) args.push('-a', amp)
    args.push(clean) // 文本作为位置参数传给 say
    const p = spawn('/usr/bin/say', args)
    current = p
    p.on('exit', () => { current = null; resolve({ ok: true }) })
    p.on('error', (e) => { current = null; resolve({ ok: false, error: String(e.message || e) }) })
  })
}

// barge-in：立即停止当前播报
function stop () {
  if (current) {
    try { current.kill('SIGINT') } catch (e) {}
    current = null
  }
  return { ok: true }
}

// STT：渲染端采集音频→WAV base64→解码→网关转写（用户说话才触发）
async function transcribe (wavBase64) {
  let buf
  try { buf = Buffer.from(wavBase64, 'base64') } catch (e) { return { ok: false, error: '音频解码失败' } }
  return await gateway.transcribe(buf)
}

// 可用嗓音列表（供管理端选择，本地命令，不出网）
function voices () {
  return new Promise((resolve) => {
    execFile('/usr/bin/say', ['-v', '?'], (err, out) => {
      if (err) return resolve({ ok: false, error: String(err.message) })
      const list = String(out).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 60)
      resolve({ ok: true, voices: list })
    })
  })
}

// FR-10.6 路径二：将 TTS 渲染为 WAV 缓冲（供下放到设备 I2S 播放）。仅用户动作触发、不出网。
// say -o <file>.wav 产出 PCM WAV；读回后删除临时文件。
function renderWav (text, opts = {}) {
  return new Promise((resolve) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    if (!clean) return resolve({ ok: false, empty: true })
    const cfg = config.load()
    if (cfg.muteMode && opts.proactive) return resolve({ ok: false, muted: true }) // 静音模式不下放设备播报
    const out = path.join(os.tmpdir(), 'dt-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.wav')
    const args = ['-o', out, '--data-format=LEI16@22050']
    const voice = opts.voice || pickVoice(!!opts.english)
    if (voice) args.push('-v', voice)
    args.push('-r', String(RATE[cfg.ttsRate] || RATE.mid))
    const amp = ampArg(cfg)
    if (amp) args.push('-a', amp)
    args.push(clean)
    const p = spawn('/usr/bin/say', args)
    p.on('exit', () => {
      try {
        const buf = fs.readFileSync(out)
        try { fs.unlinkSync(out) } catch (e) {}
        resolve({ ok: true, wav: buf, format: 'wav', rate: 22050 })
      } catch (e) { resolve({ ok: false, error: 'TTS 渲染失败：' + String(e.message || e) }) }
    })
    p.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }))
  })
}

module.exports = { speak, stop, transcribe, voices, renderWav }
