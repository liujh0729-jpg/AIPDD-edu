// F9 Skill 生态（战②：上游 /api/skills 为唯一真源）
// 本机助理与内嵌引擎读同一份技能库；壳侧只保留三件上游没有、又必须留在壳的能力：
//   1) name→{enabled, source} 的极小覆盖层（上游无「启用/停用」概念，正文也不落壳）
//   2) 写穿上游前的静态安全扫描（FR-9.3：含危险命令/真实凭证者拒绝入库）
//   3) 任意 URL 的 hub 下载（skillhub.cn，仅用户点击触发；下载后按 SKILL.md 正文入库）
// 本地「目录」多文件导入按 SKILL.md 单文件正文入库（上游 create 以文本正文为最小单元）。
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const gateway = require('./gateway')

const DANGER = [/\brm\s+-rf\s+[/~]/i, /\bsudo\b/i, /\bmkfs\b/i, /:\(\)\s*\{.*\|.*&\s*\}/ /*fork bomb*/, /\bcurl\b.*\|\s*(ba)?sh/i, /\bwget\b.*\|\s*(ba)?sh/i, /\beval\s*\(/, /child_process/i]
const CRED = /\b(sk-[A-Za-z0-9]{6,}|Bearer\s+[A-Za-z0-9._\-]{12,}|api[_-]?key\s*[:=]\s*['"][^'"]{8,}|password\s*[:=]\s*['"][^'"]{4,})/i

// —— 覆盖层：启用开关 + 来源标记（不落技能正文，正文只存在上游 /api/skills）——
function overlayFile () { return path.join(app.getPath('userData'), 'skills-overlay.json') }
function readOverlay () { try { return JSON.parse(fs.readFileSync(overlayFile(), 'utf8')) } catch (e) { return {} } }
function writeOverlay (o) { try { fs.writeFileSync(overlayFile(), JSON.stringify(o, null, 2), 'utf8') } catch (e) {} }
function patchOverlay (name, patch) { const o = readOverlay(); o[name] = { ...(o[name] || {}), ...patch }; writeOverlay(o); return o[name] }
function dropOverlay (name) { const o = readOverlay(); if (o[name]) { delete o[name]; writeOverlay(o) } }

// FR-9.3 安全门：对正文文本做静态扫描（危险命令 / 真实凭证 / 隐藏文件名）
function scanContent (name, text) {
  const issues = []
  if (String(name).startsWith('.')) issues.push('隐藏文件：' + name)
  for (const re of DANGER) if (re.test(text)) { issues.push('危险命令 @ ' + name); break }
  if (CRED.test(text)) issues.push('疑似真实凭证 @ ' + name)
  return { clean: issues.length === 0, issues: Array.from(new Set(issues)) }
}

// —— 读取（上游列表 + 覆盖层合并）——
async function list () {
  const r = await gateway.apiCall('GET', '/api/skills/list')
  if (!r.ok) return [] // 读取失败返回空：UI 维持「暂无」，不阻断，下次刷新自动重试
  const items = (r.data && r.data.skills) || []
  const ov = readOverlay()
  return items.map((it) => {
    const o = ov[it.name] || {}
    return {
      name: it.name,
      enabled: o.enabled !== false, // 无覆盖记录时默认可用
      source: o.source || it.source || 'user', // 保留 hub/local 溯源标记
      desc: it.description || '',
      tags: it.tags || [],
      readOnly: it.source && it.source !== 'user'
    }
  })
}

async function setEnabled (name, on) { patchOverlay(name, { enabled: !!on }); return { ok: true } }

async function remove (name) {
  const r = await gateway.apiCall('DELETE', '/api/skills/' + encodeURIComponent(name))
  if (!r.ok) return { ok: false, error: r.error }
  dropOverlay(name)
  _promptCache.delete(name)
  return { ok: true }
}

// 以正文入库：clean→写穿上游 create（已存在则 update 覆盖）；unsafe→拒绝，绝不落真源
async function commit (name, content, description, sourceTag) {
  const scan = scanContent(name, content)
  if (!scan.clean) return { ok: false, error: '安全扫描未通过，未入库', scan }
  const payload = { name, description: description || '', content, tags: [] }
  let r = await gateway.apiCall('POST', '/api/skills/create', payload)
  if (!r.ok && r.status === 409) r = await gateway.apiCall('PUT', '/api/skills/' + encodeURIComponent(name), { content, description: description || '' })
  if (!r.ok) return { ok: false, error: r.error, scan }
  patchOverlay(name, { source: sourceTag, enabled: true })
  _promptCache.delete(name) // 正文变更，失效注入缓存
  return { ok: true, name, scan, enabled: true }
}

// FR-9.1 本地导入：单文件取其正文；目录取 SKILL.md 正文（多文件目录降级为正文入库）
async function installLocal (srcPath) {
  const name = path.basename(srcPath).replace(/\.(md|zip)$/i, '') || ('skill-' + Date.now())
  let content
  try {
    const st = fs.statSync(srcPath)
    if (st.isDirectory()) {
      const md = ['SKILL.md', 'skill.md', 'README.md'].map((n) => path.join(srcPath, n)).find((p) => fs.existsSync(p))
      if (!md) return { ok: false, error: '目录内未找到 SKILL.md，无法入库' }
      content = fs.readFileSync(md, 'utf8')
    } else {
      content = fs.readFileSync(srcPath, 'utf8')
    }
  } catch (e) { return { ok: false, error: '读取失败：' + e.message } }
  return commit(name, content, '', 'local')
}

// FR-9.2/9.3 从 SkillHub 下载（用户选中才下载，不自动执行）→ 安全扫描 → 正文入库
async function installFromHub (item) {
  const url = item.downloadUrl || item.url || item.file || item.archive
  if (!url) return { ok: false, error: '该技能无可用下载地址' }
  const name = (item.name || item.title || 'skill-' + Date.now()).toString()
  let buf
  try { buf = await gateway.fetchUrl(url) } catch (e) { return { ok: false, error: '下载失败：' + e.message } }
  if (buf.length > 5 * 1024 * 1024) return { ok: false, error: '下载内容过大，已拒绝' }
  return commit(name, buf.toString('utf8'), (item.description || '').slice(0, 120), 'skillhub')
}

// —— 供本机助理注入的正文（内存缓存，避免热教学路径每轮走 HTTP）——
const _promptCache = new Map()
async function loadPrompt (name) {
  if (_promptCache.has(name)) return _promptCache.get(name)
  const r = await gateway.apiCall('GET', '/api/skills/' + encodeURIComponent(name))
  const text = (r.ok && r.data && typeof r.data.content === 'string') ? r.data.content.slice(0, 4000) : ''
  _promptCache.set(name, text)
  return text
}
async function enabledNames () { const l = await list(); return l.filter((s) => s.enabled).map((s) => s.name) }

module.exports = { list, installLocal, installFromHub, setEnabled, remove, loadPrompt, enabledNames, scanContent }
