// AI学习助理 · bundled 核心启动器（CommonJS）
// 蓝本：DeepTutor 官方桌面壳 apps/desktop 的 runtime.mjs + processes.mjs（bundled 分支）。
// 职责：用封包内的 runtime/{python,node,web,core} 本地拉起 DeepTutor 后端 + 前端，
//       就绪后返回动态前端地址；不依赖任何外部服务、不做签名校验。
// 硬约束：仅访问 loopback；无任何自动计费调用（未配密钥时后端仅告警不请求上游）。
const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const WINDOWS = process.platform === 'win32'

// ——— 进程管理：POSIX 下子进程自成进程组，便于整组信号回收 ———
class ProcessGroup {
  constructor (log = () => {}) { this.children = new Set(); this.log = log; this.stopping = false }
  spawn (command, args, options = {}) {
    if (this.stopping) throw new Error('启动已取消')
    const child = spawn(command, args, { ...options, detached: !WINDOWS, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    this.children.add(child)
    child.on('error', (error) => { child.failure = error })
    child.stdout.on('data', (c) => this.log(c))
    child.stderr.on('data', (c) => this.log(c))
    child.done = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    return child
  }
  async run (command, args, options = {}, timeout = 120000) {
    const child = this.spawn(command, args, options)
    let timer
    const result = await Promise.race([
      child.done,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ error: new Error('命令超时') }), timeout) })
    ])
    clearTimeout(timer)
    if (result.error || result.code !== 0) {
      this.signal(child, 'SIGTERM')
      throw result.error ?? new Error(`${command} 退出码 ${result.code ?? result.signal}；详见运行日志`)
    }
    this.children.delete(child)
  }
  signal (child, signal) {
    if (!child.pid) return
    try { process.kill(WINDOWS ? child.pid : -child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') this.log(String(e.message) + '\n') }
  }
  running (child) { try { process.kill(WINDOWS ? child.pid : -child.pid, 0); return true } catch { return false } }
  alive (child) { return !child.failure && child.exitCode === null && child.signalCode === null }
  async stop () {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopPromise = (async () => {
      const children = [...this.children]
      for (const c of children) this.signal(c, 'SIGTERM')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (!children.some((c) => c.pid && this.running(c))) break
        await new Promise((r) => setTimeout(r, 100))
      }
      for (const c of children) this.signal(c, 'SIGKILL')
      await Promise.all(children.map((c) => c.done))
      this.children.clear()
    })()
    return this.stopPromise
  }
}

function availablePort (preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => {
      if (preferred && error.code === 'EADDRINUSE') availablePort().then(resolve, reject)
      else reject(error)
    })
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function probe (url, timeout = 2500) {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false }, (response) => {
      response.resume()
      resolve(response.statusCode >= 200 && response.statusCode < 400)
    })
    const timer = setTimeout(() => request.destroy(), timeout)
    request.once('close', () => clearTimeout(timer))
    request.once('error', () => resolve(false))
  })
}

async function waitReady (url, { signal, alive = () => true, timeout = 240000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signal && signal.aborted) { const e = new Error('启动已取消'); e.name = 'AbortError'; throw e }
    if (!alive()) throw new Error('核心进程提前退出；详见运行日志')
    if (await probe(url)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`等待 ${url} 超时`)
}

// ——— 定位封包内的 runtime 目录（按当前 CPU 架构选择 arm64 / x64 切片）———
function hasRuntime (dir) {
  return dir && fs.existsSync(path.join(dir, 'python')) && fs.existsSync(path.join(dir, 'node'))
    && fs.existsSync(path.join(dir, 'web', 'server.js')) && fs.existsSync(path.join(dir, 'core', 'deeptutor_cli'))
}
function resolveRuntime (appRoot, resourcesPath, isPackaged) {
  const archDir = process.arch === 'x64' ? 'macos-x64' : 'macos-arm64'
  const candidates = []
  if (process.env.DT_RUNTIME) candidates.push(process.env.DT_RUNTIME)
  if (isPackaged) {
    candidates.push(path.join(resourcesPath, 'runtime', archDir))
    candidates.push(path.join(resourcesPath, 'runtime'))
  } else {
    // 开发态：官方 build-runtime 组装产物目录
    candidates.push(path.join(appRoot, 'upstream/deeptutor/apps/desktop/.local/' + archDir + '/runtime'))
    candidates.push(path.join(appRoot, '.local/' + archDir + '/runtime'))
  }
  const found = candidates.map((p) => path.resolve(p)).find(hasRuntime)
  if (!found) throw new Error('未找到内置运行环境 runtime（' + candidates.join(' | ') + '）；请先执行 build-runtime')
  return {
    root: found,
    sourcePath: path.join(found, 'core'),
    pythonPath: path.join(found, 'python', 'bin', WINDOWS ? 'python.exe' : 'python3.12'),
    nodePath: path.join(found, 'node', 'bin', WINDOWS ? 'node.exe' : 'node'),
    webPath: path.join(found, 'web')
  }
}

// ——— 把 runtime/web 复制到可写缓存并注入后端地址（占位符替换，带缓存标记）———
// 内容指纹：随构建变化（优先用 Next 的 .next/BUILD_ID，回退到 server.js 的 mtime+size）。
// 旧标记只含 source 路径，覆盖 runtime/web 后路径不变→缓存不刷新；纳入指纹后新构建会自动失效重暂存。
function webFingerprint (source) {
  try {
    const id = fs.readFileSync(path.join(source, '.next', 'BUILD_ID'), 'utf8').trim()
    if (id) return 'build:' + id
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try {
    const st = fs.statSync(path.join(source, 'server.js'))
    return 'mtime:' + Math.round(st.mtimeMs) + ':' + st.size
  } catch (error) { return 'unknown' }
}

async function stageBundledWeb (source, cachePath, backendURL, authEnabled) {
  const target = path.join(cachePath, 'web')
  const marker = JSON.stringify({ source, backendURL, authEnabled, web: webFingerprint(source) })
  try {
    if (await fsp.readFile(path.join(target, '.launcher-config'), 'utf8') === marker) return target
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fsp.rm(target, { recursive: true, force: true })
  await fsp.mkdir(cachePath, { recursive: true })
  await fsp.cp(source, target, { recursive: true })
  const apiPh = '__NEXT_PUBLIC_API_BASE_PLACEHOLDER__'
  const authPh = '__NEXT_PUBLIC_AUTH_ENABLED_PLACEHOLDER__'
  async function patchFile (file) {
    if (!/\.(js|json|html|txt)$/.test(file)) return
    const text = await fsp.readFile(file, 'utf8')
    if (!text.includes(apiPh) && !text.includes(authPh)) return
    const updated = text.split(apiPh).join(backendURL).split(authPh).join(authEnabled)
    if (updated !== text) await fsp.writeFile(file, updated)
  }
  async function walk (folder) {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (entry.isFile()) await patchFile(filename)
    }
  }
  await walk(path.join(target, '.next'))
  await patchFile(path.join(target, 'server.js'))
  await fsp.writeFile(path.join(target, '.launcher-config'), marker)
  return target
}

// ——— 核心运行时：驱动 bundled 启动全流程，事件回传进度 ———
class CoreRuntime extends EventEmitter {
  constructor ({ log = () => {} } = {}) {
    super()
    this.group = new ProcessGroup(log)
    this.controller = new AbortController()
    this.state = { phase: 'idle', step: null }
  }
  update (state) { this.state = Object.assign({}, this.state, state); this.emit('status', this.state) }

  async start ({ runtimeHome, cachePath, appRoot, resourcesPath, isPackaged }) {
    this.update({ phase: 'starting', step: 'locate' })
    const rt = resolveRuntime(appRoot, resourcesPath, isPackaged)
    this.runtime = rt
    await fsp.mkdir(runtimeHome, { recursive: true, mode: 0o700 })
    await fsp.mkdir(cachePath, { recursive: true, mode: 0o700 })

    const backendPort = await availablePort(18801)
    const frontendPort = await availablePort(18802)
    const backendURL = `http://127.0.0.1:${backendPort}`
    const url = `http://127.0.0.1:${frontendPort}`
    const env = Object.assign({}, process.env, {
      PATH: [path.dirname(rt.nodePath), path.dirname(rt.pythonPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      PYTHONPATH: rt.sourcePath,
      // 关键：隔离用户全局 site-packages（~/.local），只用 bundled runtime 自带依赖，避免版本串味
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      DEEPTUTOR_HOME: runtimeHome,
      BACKEND_PORT: String(backendPort),
      FRONTEND_PORT: String(frontendPort)
    })
    delete env.DEEPTUTOR_LAUNCHER_PID
    delete env.ELECTRON_RUN_AS_NODE
    delete env.PYTHONHOME

    this.update({ phase: 'starting', step: 'init', backendURL, url })
    await this.group.run(rt.pythonPath, ['-m', 'deeptutor_cli.main', 'init', '--non-interactive', '--home', runtimeHome], { cwd: runtimeHome, env })

    let auth = {}
    try { auth = JSON.parse(await fsp.readFile(path.join(runtimeHome, 'data/user/settings/auth.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const authEnabled = String(Boolean(auth.enabled))
    Object.assign(env, {
      AUTH_ENABLED: authEnabled, NEXT_PUBLIC_AUTH_ENABLED: authEnabled, DEEPTUTOR_AUTH_ENABLED: authEnabled,
      DEEPTUTOR_API_BASE_URL: backendURL, NEXT_PUBLIC_API_BASE_EXTERNAL: backendURL, NEXT_PUBLIC_API_BASE: backendURL
    })

    this.update({ phase: 'starting', step: 'preparingUi', backendURL, url })
    const webPath = await stageBundledWeb(rt.webPath, cachePath, backendURL, authEnabled)

    this.update({ phase: 'starting', step: 'startingCore', backendURL, url })
    this.backend = this.group.spawn(rt.pythonPath,
      ['-m', 'deeptutor_cli.main', 'serve', '--host', '127.0.0.1', '--port', String(backendPort)],
      { cwd: runtimeHome, env })
    await waitReady(`${backendURL}/health/ready`, { signal: this.controller.signal, alive: () => this.group.alive(this.backend) })

    this.update({ phase: 'starting', step: 'openingSpace', backendURL, url })
    this.frontend = this.group.spawn(rt.nodePath, [path.join(webPath, 'server.js')],
      { cwd: webPath, env: Object.assign({}, env, { PORT: String(frontendPort), HOSTNAME: '127.0.0.1', DEEPTUTOR_NEXT_DIST_DIR: '.next', DEEPTUTOR_NEXT_TSCONFIG: 'tsconfig.json', NEXT_TELEMETRY_DISABLED: '1' }) })
    await waitReady(url, { signal: this.controller.signal, alive: () => this.group.alive(this.frontend) && this.group.alive(this.backend) })

    let coreVersion = 'dev'
    try {
      const vf = await fsp.readFile(path.join(rt.sourcePath, 'deeptutor/__version__.py'), 'utf8')
      coreVersion = /__version__\s*=\s*['"]([^'"]+)/.exec(vf)?.[1] ?? 'dev'
    } catch (e) { /* 版本文件缺失不致命 */ }

    this.update({ phase: 'ready', step: 'ready', coreVersion, url, backendURL, owned: true })
    for (const child of [this.backend, this.frontend]) {
      child.done.then(() => { if (this.state.phase === 'ready') this.fail(new Error('核心进程已退出，请重新启动')) })
    }
    this.monitor = setInterval(async () => {
      if (this.checking || this.state.phase !== 'ready') return
      this.checking = true
      try {
        this.misses = await probe(`${backendURL}/health/ready`) ? 0 : (this.misses || 0) + 1
        if (this.misses >= 3 && this.state.phase === 'ready') this.fail(new Error('核心连续三次健康检查失败，请重新启动'))
      } finally { this.checking = false }
    }, 10000)
    return this.state
  }

  async fail (error) {
    clearInterval(this.monitor)
    this.update({ phase: 'error', step: null, message: error.message })
    await this.group.stop()
  }

  async stop () {
    if (this.state.phase === 'stopped') return
    clearInterval(this.monitor)
    this.update({ phase: 'stopping', step: 'stopping' })
    this.controller.abort()
    await this.group.stop()
    this.update({ phase: 'stopped', step: 'stopped' })
  }
}

module.exports = { CoreRuntime, resolveRuntime }
