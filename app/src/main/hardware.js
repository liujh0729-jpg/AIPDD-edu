// F10 智能硬件（ESP32）· 设备接入管理器（CommonJS，与主进程/asar 兼容）
// 定位：设备仅作 IO 前端 + 执行器；电脑端为编排大脑（会话状态以此为准）。
// 硬约束：仅局域网、需 token 鉴权、不上云；凭证只存本机 0600（由主进程经 keys 传入，绝不落 config/日志）。
// 严禁自动计费：本模块自发任何动作都不触碰网关；所有大模型请求仍由上层用户动作触发。
const dgram = require('dgram')
const { EventEmitter } = require('events')
const WebSocket = require('ws')
const config = require('./config')

const MAGIC = 'dt-esp32'          // UDP 信标魔数
const PROTO = 1                    // 协议版本
const BIN_IMAGE = 0x01            // 二进制帧类型：上行图像(JPEG)
const BIN_AUDIO_UP = 0x02         // 二进制帧类型：上行音频(PCM16/16k/mono 分块)
const BIN_AUDIO_DOWN = 0x03       // 二进制帧类型：下行音频(WAV/PCM 分块)
const DOWN_CHUNK = 4096           // 下行音频分块字节
const HELLO_WAIT_MS = 2000        // 连接后等待 hello 的时长
const ACK_TIMEOUT_MS = 4000       // 单条控制指令等待 ack 超时
const DEVICE_EXPIRE_MS = 7000     // 发现列表过期
const VAD_RMS = 600               // 上行语音能量门限（16-bit RMS），低于视为静音（本地门控，不出网）
const SILENCE_MS = 700            // 静音多久后收束一段
const MAX_SEG_MS = 8000           // 单段最长

class HardwareManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.log = opts.log || (() => {})
    this.state = 'disconnected'    // disconnected|connecting|pairing|connected|working
    this.device = null             // 当前连接设备 {id,name,ip,port,caps}
    this.caps = null               // hello 上报的能力位
    this.streaming = { audio: false, image: false }
    this.playing = false           // 正在向设备播放（半双工：此期间丢弃上行音频）
    this._ws = null
    this._udp = null
    this._token = ''               // 内存态 token（不持久化；仅用于重连）
    this._conn = null              // {ip,port} 便于重连
    this._devices = new Map()      // id -> device（发现表）
    this._seq = 1
    this._pending = new Map()      // seq -> {resolve,timer}
    this._reconTimer = null
    this._reconAttempts = 0
    this._helloTimer = null
    this._expireTimer = null
    // 上行音频分段
    this._inSeg = false
    this._segChunks = []
    this._lastVoiced = 0
    this._segStart = 0
  }

  // ———————————————— 发现（FR-10.1）———————————————
  startDiscovery () {
    if (this._udp) return { ok: true, already: true }
    const cfg = config.load()
    const port = (cfg.hardware && cfg.hardware.discoveryPort) || 48000
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    sock.on('error', (e) => { this.log('[hw] 发现套接字错误：' + e.message); this._udp = null })
    sock.on('message', (msg, rinfo) => {
      let pkt
      try { pkt = JSON.parse(msg.toString('utf8')) } catch (e) { return }
      if (!pkt || pkt.magic !== MAGIC) return
      if (pkt.q === 'discover') return // 这是查询包，交给设备侧应答，不登记
      if (!pkt.id) return
      const dev = {
        id: pkt.id, name: pkt.name || pkt.id, ip: pkt.ip || rinfo.address,
        port: pkt.port || 80, caps: pkt.caps || { cam: false, mic: false, spk: false },
        proto: pkt.proto || 1, lastSeen: Date.now(), source: pkt.source || 'beacon'
      }
      const isNew = !this._devices.has(dev.id)
      this._devices.set(dev.id, dev)
      this._emitDevices()
      if (isNew) this.log('[hw] 发现设备 ' + dev.name + ' @ ' + dev.ip + ':' + dev.port)
    })
    sock.bind(port, () => {
      try { sock.setBroadcast(true) } catch (e) {}
      try { sock.addMembership('224.0.0.251') } catch (e) {} // mDNS 组（尽力而为，主要靠信标）
    })
    this._udp = sock
    if (!this._expireTimer) this._expireTimer = setInterval(() => this._expireDevices(), 2000)
    this.log('[hw] 已启动局域网发现，监听 UDP ' + port)
    return { ok: true, port }
  }

  // 主动广播一次查询，促使设备回置信标
  scan () {
    if (!this._udp) this.startDiscovery()
    if (!this._udp) return { ok: false, error: '发现服务未就绪' }
    const cfg = config.load()
    const port = (cfg.hardware && cfg.hardware.discoveryPort) || 48000
    const body = Buffer.from(JSON.stringify({ magic: MAGIC, q: 'discover', proto: PROTO, at: Date.now() }), 'utf8')
    try { this._udp.broadcast(body, 0, body.length, port, '255.255.255.255', () => {}) } catch (e) {}
    this._emitDevices()
    return { ok: true }
  }

  _expireDevices () {
    const now = Date.now()
    let changed = false
    for (const [id, d] of this._devices) {
      if (this.device && this.device.id === id) continue // 活动设备不因信标停发而移除
      if (now - d.lastSeen > DEVICE_EXPIRE_MS) { this._devices.delete(id); changed = true }
    }
    if (changed) this._emitDevices()
  }

  _emitDevices () {
    this.emit('devices', this.listDevices())
  }

  listDevices () {
    return Array.from(this._devices.values()).map(d => ({ ...d, connected: !!(this.device && this.device.id === d.id) }))
  }

  // ———————————————— 连接 / 鉴权（FR-10.2）———————————————
  connect (opts) {
    // opts: { ip, port, token, device }
    const { ip, port = 80, token = '', device = null } = opts || {}
    if (!ip) return { ok: false, error: '缺少设备地址' }
    if (this._ws) this._teardownWs()
    this._token = token
    this._conn = { ip, port }
    this.device = device || { id: opts.deviceId || ip, name: opts.name || ip, ip, port, caps: null }
    this._setState('connecting')
    let ws
    try { ws = new WebSocket('ws://' + ip + ':' + port, { handshakeTimeout: 6000 }) } catch (e) { this._setState('disconnected'); return { ok: false, error: String(e.message || e) } }
    this._ws = ws
    ws.on('open', () => {
      this.log('[hw] WS 已连接 ' + ip + ':' + port + '，等待 hello')
      this._helloTimer = setTimeout(() => {
        // 未在时限内收到 hello，主动 ping 提示设备上报
        this._sendCtl({ t: 'ping' })
        setTimeout(() => { if (this.state === 'connecting') { this._failAuth('设备未上报能力(hello 超时)') } }, 3000)
      }, HELLO_WAIT_MS)
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this._onBinary(Buffer.from(data))
      let ctl
      try { ctl = JSON.parse(Buffer.from(data).toString('utf8')) } catch (e) { return }
      this._onControl(ctl)
    })
    ws.on('close', (code) => this._onClose(code))
    ws.on('error', (e) => { this.log('[hw] WS 错误：' + e.message); this.emit('log', '连接错误：' + e.message) })
    return { ok: true }
  }

  _onControl (ctl) {
    switch (ctl.t) {
      case 'hello':
        if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null }
        this.caps = ctl.caps || { cam: false, mic: false, spk: false }
        this.device = { ...this.device, id: ctl.id || this.device.id, name: ctl.name || this.device.name, caps: this.caps, fw: ctl.fw }
        this._setState('pairing')
        this.log('[hw] 收到 hello，能力位 ' + JSON.stringify(this.caps) + '，发起鉴权')
        this._sendCtl({ t: 'auth', token: this._token })
        break
      case 'auth_ok':
        this._reconAttempts = 0
        this._setState('connected')
        this.log('[hw] 鉴权通过，设备就绪')
        this.emit('log', '已连接：' + (this.device.name || this.device.ip))
        // 就绪后应用配置的音量（FR-10.10d 路径二）：断连重连/重启后设备音量与配置保持一致
        if (this.caps && this.caps.spk) {
          const cv = Number(config.load().hardware.deviceVolume)
          if (Number.isFinite(cv)) this.command('volume', String(cv)).then(() => {})
        }
        break
      case 'auth_fail':
        this._failAuth('token 校验失败，请检查配对码')
        break
      case 'ack':
        this._resolveAck(ctl.seq, { ok: ctl.code === 0 || ctl.code === undefined, code: ctl.code })
        break
      case 'state':
        this.emit('state', { ...ctl })
        break
      case 'error':
        this.log('[hw] 设备错误：' + (ctl.code || '') + ' ' + (ctl.msg || ''))
        this.emit('log', '设备错误：' + (ctl.msg || ctl.code || '未知'))
        break
      case 'pong':
        // 设备对 ping 的回应后通常紧跟 hello
        break
      default:
        break
    }
  }

  _failAuth (msg) {
    this.emit('log', msg)
    this._setState('disconnected')
    this.emit('auth-fail', { error: msg })
    if (this._ws) { try { this._ws.close() } catch (e) {} }
  }

  _onClose (code) {
    const wasWorking = this.state !== 'disconnected'
    this._cleanupHello()
    this._ws = null
    this._rejectAllPending('连接关闭')
    this._setState('disconnected')
    this._inSeg = false; this._segChunks = []
    if (wasWorking && config.load().hardware.autoReconnect && this._conn && this._token && this._reconAttempts < 6) {
      this._reconAttempts += 1
      const delay = Math.min(8000, 800 * Math.pow(2, this._reconAttempts))
      this.log('[hw] 断开(code=' + code + ')，' + delay + 'ms 后重连（第 ' + this._reconAttempts + ' 次）')
      this._reconTimer = setTimeout(() => this.connect({ ...this._conn, token: this._token, device: this.device }), delay)
    }
  }

  _cleanupHello () { if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null } }

  disconnect () {
    if (this._reconTimer) { clearTimeout(this._reconTimer); this._reconTimer = null }
    this._reconAttempts = 6 // 阻止主动断开触发重连
    this._teardownWs()
    this._setState('disconnected')
    this.device = null; this.caps = null
    this._emitDevices()
    return { ok: true }
  }

  _teardownWs () { if (this._ws) { try { this._ws.removeAllListeners(); this._ws.close() } catch (e) {} this._ws = null } this._cleanupHello() }

  // ———————————————— 流控 / 远程控制（FR-10.10）———————————————
  setStream ({ audio, image } = {}) {
    const ctl = { t: 'stream' }
    if (audio !== undefined) ctl.audio = !!audio
    if (image !== undefined) ctl.image = !!image
    if (!this._ws || this.state === 'disconnected') return { ok: false, error: '未连接' }
    this._sendCtl(ctl)
    if (audio !== undefined) this.streaming.audio = !!audio
    if (image !== undefined) this.streaming.image = !!image
    const active = this.streaming.audio || this.streaming.image
    if (this.state === 'connected' && active) this._setState('working')
    if (this.state === 'working' && !active) this._setState('connected')
    return { ok: true, streaming: this.streaming }
  }

  // 通用下行操控：capture/volume/mute/led/cue/speak/power/reboot/info/session
  command (action, arg) {
    if (!this._ws || this.state === 'disconnected') return Promise.resolve({ ok: false, error: '未连接' })
    const seq = this._seq++
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._pending.delete(seq); resolve({ ok: false, error: '指令超时：' + action }) }, ACK_TIMEOUT_MS)
      this._pending.set(seq, { resolve, timer })
      this._sendCtl({ t: 'cmd', seq, action, arg })
    })
  }

  _resolveAck (seq, res) {
    const p = this._pending.get(seq)
    if (!p) return
    clearTimeout(p.timer); this._pending.delete(seq); p.resolve(res)
  }

  _rejectAllPending (reason) {
    for (const [seq, p] of this._pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: reason }) }
    this._pending.clear()
  }

  _sendCtl (obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false
    try { this._ws.send(JSON.stringify(obj)) ; return true } catch (e) { this.log('[hw] 发送失败：' + e.message); return false }
  }

  // FR-10.6 路径二 / FR-10.10c：向设备播放一段 WAV（半双工：播放期丢弃上行音频）
  playWav (wavBuffer) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: '未连接' })
    if (!this.caps || !this.caps.spk) return Promise.resolve({ ok: false, error: '设备无喇叭，不能经设备播放' })
    return new Promise((resolve) => {
      this.playing = true
      this.emit('speaking', true)
      const seq = this._seq++
      this._sendCtl({ t: 'play_begin', seq, format: 'wav', bytes: wavBuffer.length })
      let off = 0
      const sendNext = () => {
        if (off >= wavBuffer.length) {
          this._sendCtl({ t: 'play_end', seq })
          this.playing = false
          this.emit('speaking', false)
          resolve({ ok: true })
          return
        }
        const chunk = wavBuffer.subarray(off, off + DOWN_CHUNK)
        off += DOWN_CHUNK
        const frame = Buffer.allocUnsafe(1 + chunk.length)
        frame[0] = BIN_AUDIO_DOWN
        chunk.copy(frame, 1)
        try { this._ws.send(frame, { binary: true }, (err) => err ? resolve({ ok: false, error: err.message }) : setImmediate(sendNext)) } catch (e) { this.playing = false; this.emit('speaking', false); resolve({ ok: false, error: String(e.message || e) }) }
      }
      setImmediate(sendNext)
    })
  }

  // ———————————————— 上行媒体帧 ————————————————
  _onBinary (buf) {
    if (!buf || buf.length < 1) return
    const kind = buf[0]
    const payload = buf.subarray(1)
    if (kind === BIN_IMAGE) return this._onImageFrame(payload)
    if (kind === BIN_AUDIO_UP) return this._onAudioChunk(payload)
    // 其余类型忽略（前向兼容）
  }

  _onImageFrame (jpeg) {
    if (!jpeg || !jpeg.length) return
    const b64 = jpeg.toString('base64')
    this.emit('frame', { dataUrl: 'data:image/jpeg;base64,' + b64, bytes: jpeg.length })
  }

  _onAudioChunk (pcm) {
    // 半双工：设备正播放 AI 语音时，其麦克风会拾到喇叭声，直接丢弃避免自触发
    if (this.playing) return
    if (!pcm || !pcm.length) return
    const rms = pcmRms(pcm)
    const now = Date.now()
    const voiced = rms >= VAD_RMS
    if (voiced) {
      if (!this._inSeg) { this._inSeg = true; this._segChunks = []; this._segStart = now }
      this._segChunks.push(pcm)
      this._lastVoiced = now
    } else if (this._inSeg) {
      this._segChunks.push(pcm) // 保留尾部静音，避免截字
      if (now - this._lastVoiced > SILENCE_MS || now - this._segStart > MAX_SEG_MS) this._finalizeSegment()
    }
  }

  _finalizeSegment () {
    const chunks = this._segChunks
    this._inSeg = false; this._segChunks = []
    const total = chunks.reduce((a, b) => a + b.length, 0)
    if (!total) return
    const pcm = Buffer.concat(chunks)
    // 过短噪声段丢弃（约 < 0.3s = 9600 字节 @16k/16bit/mono）
    if (pcm.length < 9600) return
    const wav = pcmToWav(pcm, 16000, 1)
    this.emit('speech', { wavBase64: wav.toString('base64'), ms: Math.round((pcm.length / 2) / 16) })
  }

  // ———————————————— 状态 / 生命周期 ————————————————
  _setState (s) {
    if (this.state === s) return
    this.state = s
    this.emit('status', this.getState())
  }

  getState () {
    const cfg = config.load()
    return {
      state: this.state,
      device: this.device,
      caps: this.caps,
      streaming: this.streaming,
      playing: this.playing,
      audioOutput: cfg.hardware.audioOutput,
      devices: this.listDevices().length
    }
  }

  stop () {
    if (this._reconTimer) clearTimeout(this._reconTimer)
    if (this._expireTimer) clearInterval(this._expireTimer)
    this._rejectAllPending('已停止')
    this._teardownWs()
    if (this._udp) { try { this._udp.close() } catch (e) {} this._udp = null }
    this.state = 'disconnected'
  }
}

// PCM16/单声道 → WAV（44 字节头，小端）
function pcmToWav (pcm, sampleRate, channels) {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)          // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32) // block align
  header.writeUInt16LE(16, 34)         // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function pcmRms (buf) {
  const n = buf.length >> 1
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s }
  return Math.round(Math.sqrt(sum / n))
}

module.exports = { HardwareManager, MAGIC, PROTO }
