// F6 模型调用适配层：模型执行统一走上游 model_catalog，壳不自建网关。
// 所有模型调用按 service 走上游本地 HTTP 端点，由上游 model_catalog 解析激活的
// profile/model 并执行（提供方/凭证/激活均在 设置 → 模型设置 管理）；壳只保留
// 本机独有的每日成本熔断（NFR-3）与用量计量（FR-6.6）——口径由上游返回的 usage 喂入。
// 硬约束：所有调用仅由用户动作触发（点击/语音指令），绝不自动发起计费测试调用。
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const config = require('./config')

// 壳角色 → 上游 catalog service：
//  - vlm 与 llm 共用上游 llm 服务（视觉是模型能力，不是独立服务）
//  - decision 走 task 服务（未配置时上游自动继承 llm）
const SERVICE_BY_ROLE = { llm: 'llm', vlm: 'llm', decision: 'task' }

// —— 用量计量与熔断（本机独有；走上游返回的 usage，不再有壳网关 id）——
function usagePath () { return path.join(app.getPath('userData'), 'usage.json') }
function todayKey () { return new Date().toISOString().slice(0, 10) }

function loadUsage () {
  try { return JSON.parse(fs.readFileSync(usagePath(), 'utf8')) } catch (e) { return {} }
}
function saveUsage (u) {
  fs.writeFileSync(usagePath(), JSON.stringify(u, null, 2), { encoding: 'utf8' })
}

// FR-6.6 按「能力:模型」聚合 token/次数；联动 NFR-3 熔断。bucket 为 llm/embedding/stt。
function track (bucket, model, usage) {
  const u = loadUsage()
  const d = (u[todayKey()] = u[todayKey()] || {})
  const key = bucket + ':' + (model || 'catalog')
  const g = (d[key] = d[key] || { calls: 0, prompt: 0, completion: 0 })
  g.calls += 1
  g.prompt += (usage && (usage.prompt_tokens || usage.input_tokens)) || 0
  g.completion += (usage && (usage.completion_tokens || usage.output_tokens)) || 0
  saveUsage(u)
}

function totalCallsToday () {
  const d = loadUsage()[todayKey()] || {}
  let t = 0
  for (const g of Object.values(d)) t += g.calls || 0
  return t
}

function tripwire () {
  const cfg = config.load()
  const limit = cfg.costLimitDaily || 0
  if (limit > 0 && totalCallsToday() >= limit) {
    return { ok: false, tripped: true, error: '已达每日调用上限（熔断），请在管理端调整阈值' }
  }
  return null
}

function usageSummary () {
  const u = loadUsage()
  const d = u[todayKey()] || {}
  const rows = Object.entries(d).map(([k, g]) => ({ gateway: k, ...g }))
  return { ok: true, date: todayKey(), totalCalls: totalCallsToday(), rows, events: [] }
}

// —— 本地核心（上游）后端地址：由 main.js 注入 ——
let backendURL = ''
function setBackend (url) { backendURL = String(url || '').replace(/\/+$/, '') }
function hasBackend () { return !!backendURL }
function backendBase () { return backendURL }

// 壳→上游本地核心 HTTP 助手（技能/记忆/模型调用的统一入口）。
// 上游随包本地运行（launcher 拉起 deeptutor_cli），环回调用免鉴权——
// 后端 get_current_user 在无 token 时回退 local_admin_user（单用户模式）。
// 统一返回 { ok, data?, error?, status? }，调用方无需再各自拼 fetch/超时/错误。
async function apiCall (method, apiPath, body, opts = {}) {
  if (!backendURL) return { ok: false, error: '本地核心未启动，无法访问上游真源' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000)
  try {
    const headers = { 'Accept': 'application/json' }
    let payload
    if (opts.raw) {
      payload = { method: String(method).toUpperCase(), headers, body, signal: ctrl.signal }
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json'
      payload = { method: String(method).toUpperCase(), headers, body: JSON.stringify(body), signal: ctrl.signal }
    } else {
      payload = { method: String(method).toUpperCase(), headers, signal: ctrl.signal }
    }
    const resp = await fetch(backendURL + apiPath, payload)
    clearTimeout(t)
    const text = await resp.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (e) { data = { raw: text } }
    if (!resp.ok) {
      const detail = (data && (data.detail || data.error)) || ('HTTP ' + resp.status)
      return { ok: false, status: resp.status, error: String(detail), data }
    }
    return { ok: true, data }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, error: String(e && e.message || e) }
  }
}

// 统一文本/视觉调用：按调用场景选择上游 catalog service，非流式，回传 usage 供计量。
// 视觉消息约定：messages 内 content 可为 [{type:'text'},{type:'image_url'}] 数组（OpenAI 兼容），
// 由上层（agent.js）构造，上游 provider 适配层原样透传给兼容端点。
async function chat (roleKey, messages, opts = {}) {
  const trip = tripwire()
  if (trip) return trip
  const service = SERVICE_BY_ROLE[roleKey] || 'llm'
  const body = { service, messages }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.max_tokens) body.max_tokens = opts.max_tokens
  const r = await apiCall('POST', '/api/edu/llm/chat', body, { timeout: opts.timeout || 60000 })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  const data = r.data || {}
  track('llm', data.model, data.usage)
  return { ok: true, content: data.content || '', usage: data.usage, gw: 'catalog:' + service, model: data.model }
}

// FR-6.1：systemone 决策通道走 task 服务；上游在未配置 task 时已自动继承 llm，
// 这里只在仍失败（非熔断）时再兜底一次纯 llm 调用。
async function decide (prompt) {
  const r = await chat('decision', [{ role: 'user', content: prompt }], { temperature: 0 })
  if (r.ok || r.tripped) return r
  return await chat('llm', [{ role: 'user', content: prompt }], { temperature: 0 })
}

// 向量：单条/多条文本 → 上游 embedding（知识库检索触发，仅用户动作）
async function embed (texts) {
  const trip = tripwire()
  if (trip) return trip
  const r = await apiCall('POST', '/api/edu/llm/embed', { input: texts }, { timeout: 60000 })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  const data = r.data || {}
  track('embedding', data.model, data.usage)
  return { ok: true, vectors: data.vectors || [] }
}

// 语音转写：wavBuffer → 上游 /api/voice/stt（multipart，仅用户语音动作触发）
async function transcribe (wavBuffer) {
  const trip = tripwire()
  if (trip) return trip
  if (!backendURL) return { ok: false, error: '本地核心未启动，无法访问上游真源' }
  const form = new FormData()
  form.append('file', new Blob([wavBuffer]), 'audio.wav')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
  try {
    const resp = await fetch(backendURL + '/api/voice/stt', { method: 'POST', body: form, signal: ctrl.signal })
    clearTimeout(t)
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      return { ok: false, error: 'STT HTTP ' + resp.status + (txt ? ('：' + txt.slice(0, 160)) : '') }
    }
    const data = await resp.json()
    // 计量：STT 响应无标准 usage，至少计入次数（与 chat/embed 熔断口径一致）
    track('stt', 'stt', null)
    return { ok: true, text: String((data && data.text) || '').trim() }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, error: String(e && e.message || e) }
  }
}

// SkillHub 等任意 URL 的下载（用户选中后由 skills 模块下载；不自动执行）
function fetchUrl (url) {
  return fetch(url, { headers: { 'Accept': 'application/octet-stream, application/json, text/plain' } })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer() })
    .then(b => Buffer.from(b))
}

module.exports = { chat, decide, transcribe, embed, fetchUrl, usageSummary, setBackend, hasBackend, backendBase, apiCall }
