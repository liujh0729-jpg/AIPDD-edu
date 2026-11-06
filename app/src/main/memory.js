// F4 数据、知识库与记忆（本地文件存储，隐私：全部留本机，不上云）
// L1 轨迹：append-only 事件流；L2 事实：分场景掌握度；L3 综合：学情画像
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const gateway = require('./gateway')

function dir (...s) { return path.join(app.getPath('userData'), ...s) }
function ensure (p) { fs.mkdirSync(p, { recursive: true }); return p }
const DIRS = {
  data: () => ensure(dir('data')),
  frames: () => ensure(dir('data', 'frames')),
  kb: () => ensure(dir('data', 'kb'))
}
const f = (name) => path.join(DIRS.data(), name)
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return fb } }
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8')

// —— 会话（课次）——
function sessionFile (id) { return f('session-' + id + '.json') }
function startSession () {
  const id = Date.now().toString(36)
  const s = { id, startedAt: new Date().toISOString(), endedAt: null, events: [], turns: [], hints: {}, wrong: [] }
  writeJson(sessionFile(id), s)
  return id
}
function getSession (id) { return readJson(sessionFile(id), null) }
function appendTurn (id, turn) {
  const s = getSession(id); if (!s) return
  s.turns.push({ at: new Date().toISOString(), ...turn })
  if (turn.hintLevel) s.hints[turn.hintLevel] = (s.hints[turn.hintLevel] || 0) + 1
  writeJson(sessionFile(id), s)
  logL1({ type: 'turn', sessionId: id, ...turn })
}
function addWrong (id, item) {
  const s = getSession(id); if (!s) return
  s.wrong.push({ at: new Date().toISOString(), ...item })
  writeJson(sessionFile(id), s)
}
function addFrame (id, dataUrl) {
  // FR-1.2 抓帧本地缓存；NFR-1 默认 7 天清理（这里按会话目录保存，清理见 prune）
  const p = path.join(DIRS.frames(), id + '-' + Date.now() + '.jpg')
  try {
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '')
    fs.writeFileSync(p, Buffer.from(b64, 'base64'))
    const s = getSession(id); if (s) { s.frames = (s.frames || []); s.frames.push(p); writeJson(sessionFile(id), s) }
    return p
  } catch (e) { return null }
}
function endSession (id) {
  const s = getSession(id); if (!s) return null
  s.endedAt = new Date().toISOString()
  writeJson(sessionFile(id), s)
  const report = buildReport(s)
  const rs = readJson(f('reports.json'), [])
  rs.unshift(report)
  writeJson(f('reports.json'), rs.slice(0, 180))
  return report
}

// FR-4.2 学习报告
function buildReport (s) {
  const durMin = s.endedAt ? Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000) : 0
  const hintStats = Object.entries(s.hints || {}).map(([lvl, n]) => 'L' + lvl + '×' + n).join(' ')
  const topics = Array.from(new Set((s.turns || []).map(t => t.topic).filter(Boolean)))
  return {
    id: s.id, date: (s.startedAt || '').slice(0, 10),
    startedAt: s.startedAt, endedAt: s.endedAt, durationMin: durMin,
    turns: (s.turns || []).length, hintStats,
    stuckTopics: topics.slice(0, 10),
    wrongCount: (s.wrong || []).length,
    frames: (s.frames || []).slice(-8),
    suggestion: genSuggestion(topics, s)
  }
}
function genSuggestion (topics, s) {
  if (!topics.length) return '本次练习顺利，可尝试稍微提升难度巩固。'
  return '建议明日重点复习：' + topics.slice(0, 3).join('、') + '；' +
    ((s.wrong || []).length ? '回顾错题本中的截图并重做一遍。' : '保持当前节奏。')
}
function listReports () { return readJson(f('reports.json'), []) }
function getReport (id) { return listReports().find(r => r.id === id) || null }

// —— 三层可审计记忆（战②：上游 memory 存储为唯一真源，壳为无状态瘦客户端）——
// 决策：per-topic 掌握度、学情画像、事件尾巴都落上游（/api/memory/tutor-state）——
// 上游随包本地运行、环回免鉴权，tutor_state.json 是唯一权威文件；壳侧不再维护
// 任何并行缓存或本机副本，每次读写都直接走上游，杜绝「两份」数据。
async function getState () {
  const r = await gateway.apiCall('GET', '/api/memory/tutor-state')
  if (!r.ok || !r.data) return null
  const d = r.data
  return {
    facts: (d.facts && typeof d.facts === 'object') ? d.facts : {},
    profile: (d.profile && typeof d.profile === 'object') ? d.profile : {},
    events: Array.isArray(d.events) ? d.events : []
  }
}
function putState (patch) { return gateway.apiCall('PUT', '/api/memory/tutor-state', patch) }

async function logL1 (ev) {
  const entry = { at: new Date().toISOString(), ...ev }
  // 上游负责把单条事件追加进尾部并限长（_TUTOR_STATE_MAX_EVENTS）
  await putState({ event: entry })
  return entry
}
async function readL1 (limit = 200) {
  const s = await getState()
  return s ? s.events.slice(-limit).reverse() : []
}
async function facts () { const s = await getState(); return s ? s.facts : {} }
async function bumpFact (topic, delta) {
  if (!topic) return
  const s = await getState(); if (!s) return
  const cur = s.facts[topic] || { mastery: 0, count: 0 }
  cur.count += 1
  cur.mastery = Math.max(0, Math.min(3, cur.mastery + (delta == null ? 1 : delta)))
  s.facts[topic] = cur
  await putState({ facts: s.facts })
  await recomputeL3()
  await logL1({ type: 'fact', topic, mastery: cur.mastery })
  return s.facts
}
async function editFact (topic, mastery) {
  const s = await getState(); if (!s) return {}
  s.facts[topic] = { ...(s.facts[topic] || { count: 0 }), mastery: Math.max(0, Math.min(3, mastery)) }
  await putState({ facts: s.facts })
  await recomputeL3()
  return s.facts
}
async function deleteFact (topic) {
  const s = await getState(); if (!s) return {}
  delete s.facts[topic]
  await putState({ facts: s.facts })
  await recomputeL3()
  return s.facts
}
async function profile () { const s = await getState(); return s ? s.profile : {} }
async function recomputeL3 () {
  const s = await getState(); if (!s) return {}
  const entries = Object.entries(s.facts)
  const weak = entries.filter(([, v]) => v.mastery <= 1).map(([k]) => k)
  const strong = entries.filter(([, v]) => v.mastery >= 3).map(([k]) => k)
  const avg = entries.length ? (entries.reduce((a, [, v]) => a + v.mastery, 0) / entries.length) : 0
  const p = { weak, strong, avgMastery: Math.round(avg * 100) / 100, updatedAt: new Date().toISOString(),
    trend: avg >= 2 ? '上升' : avg >= 1 ? '平稳' : '需加强' }
  await putState({ profile: p })
  await logL1({ type: 'profile', avg: p.avgMastery })
  return p
}
async function clearMemory () {
  const r = await gateway.apiCall('DELETE', '/api/memory/tutor-state')
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

// —— 知识库（资料库）：入库→向量化→余弦检索（FR-4.4，向量化走网关，仅用户点击触发）——
function kbFile () { return f('kb.json') }
function kbAll () { return readJson(kbFile(), []) } // [{id,source,chunk,text,vec}]
function splitChunks (text, size = 400) {
  const clean = String(text).replace(/\r/g, '')
  const out = []
  let buf = ''
  for (const para of clean.split(/\n{2,}/)) {
    buf += (buf ? '\n' : '') + para
    if (buf.length >= size) { out.push(buf); buf = '' }
  }
  if (buf.trim()) out.push(buf)
  return out.filter(x => x.trim())
}
async function kbIngest (files) {
  const chunks = []
  for (const fp of files) {
    let text
    try { text = fs.readFileSync(fp, 'utf8') } catch (e) { continue }
    for (const c of splitChunks(text)) chunks.push({ source: path.basename(fp), text: c })
  }
  if (!chunks.length) return { ok: false, error: '没有可入库的文本（当前支持 txt/md 等纯文本）' }
  const r = await gateway.embed(chunks.map(c => c.text))
  if (!r.ok) return { ok: false, error: '向量化失败：' + r.error + '（请先在管理端配置 Embedding 角色并点击测试）' }
  const all = kbAll()
  chunks.forEach((c, i) => all.push({ id: 'kb' + Date.now() + i, source: c.source, text: c.text, vec: r.vectors[i] }))
  writeJson(kbFile(), all)
  logL1({ type: 'kb', count: chunks.length })
  return { ok: true, added: chunks.length, total: all.length }
}
function cosine (a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
async function kbQuery (q, k = 4) {
  const all = kbAll()
  if (!all.length) return { ok: true, hits: [] }
  const r = await gateway.embed([q])
  if (!r.ok) return { ok: false, error: r.error }
  const qv = r.vectors[0]
  const hits = all.map(c => ({ source: c.source, text: c.text, score: cosine(qv, c.vec) }))
    .sort((x, y) => y.score - x.score).slice(0, k)
  return { ok: true, hits }
}
function kbList () { return kbAll().map(c => ({ id: c.id, source: c.source, len: c.text.length, preview: c.text.slice(0, 60) })) }
function kbDelete (id) { writeJson(kbFile(), kbAll().filter(c => c.id !== id)); return { ok: true } }

// —— NFR-1：抓帧 7 天清理 ——
function prune () {
  const cutoff = Date.now() - 7 * 86400000
  try {
    for (const name of fs.readdirSync(DIRS.frames())) {
      const p = path.join(DIRS.frames(), name)
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p) } catch (e) {}
    }
  } catch (e) {}
  return { ok: true }
}

module.exports = {
  startSession, getSession, appendTurn, addWrong, addFrame, endSession,
  listReports, getReport,
  logL1, readL1, facts, bumpFact, editFact, deleteFact, profile, recomputeL3, clearMemory,
  kbIngest, kbQuery, kbList, kbDelete, prune
}
