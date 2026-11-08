// F8 Agent 编排：以网关 LLM/VLM 为智能底座，落实 FR-3.1 红线与 FR-8.3 受控直答例外
// 说明：DeepTutor 主引擎为独立进程（默认 127.0.0.1:3782），本 MVP 以网关适配层直连模型完成
//       同等“引导/解题/讲解/知识检索/技能”编排；DeepTutor 进程编排与 SDK 调用见 status 标注，可平滑替换。
const config = require('./config')
const gateway = require('./gateway')
const memory = require('./memory')
const skills = require('./skills')
const explain = require('./explain')

// 红线提示词（孩子侧/学习端）：只引导，绝不给完整答案
function tutorSystem (cfg, mode) {
  const grade = cfg.child && cfg.child.grade ? ('学生年级：' + cfg.child.grade + '。') : ''
  const lang = mode === 'english'
    ? '当前为英语沉浸模式：全程用英文回复；识别物体时用“名词 + 3 个形容词 + 1 个例句”，并在孩子说错时温和示范并请求复述。'
    : '请用简体中文回复，语气鼓励、不说教，绝不使用评判性语言（如“你怎么这么笨”）。'
  return '你是一位坐在孩子身边的 AI 家庭教师。' + grade + lang + '\n' +
    '核心红线（不可违反）：任何情况下都不要直接给出题目的最终答案或完整解题结果。' +
    '只能用苏格拉底式提问引导，提示分 3 级：L1 方向（这道题在考什么）、L2 思路（可以先想什么）、L3 关键步骤（这一步怎么转化）。' +
    '孩子在追问“再提示一下/下一步”时才逐级加深，到 L3 后不再加深，改为带他回顾例题。' +
    '回答要短、口语化、适合朗读（不要输出 Markdown 表格与代码块）。'
}

// 直答例外（仅管理端/家长场景且开关开启）：给出完整解答并审计
function directSystem () {
  return '你是家长的核对助手。当前为“直接解答模式”（仅家长场景），请给出完整、严谨的解题过程与最终答案，方便家长核对。'
}

function auditDirect (question, answer) {
  memory.logL1({ type: 'direct-answer', question: String(question).slice(0, 200), answerLen: (answer || '').length })
}

// 视觉消息：把抓帧 dataURL 组装成 OpenAI 兼容的多模态 content
function visionMessages (system, userText, dataUrl) {
  return [
    { role: 'system', content: system },
    { role: 'user', content: [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }
  ]
}

// 主入口：学习端/Agent端 一次交互
// payload: { text, mode, sessionId, hintLevel, image?, needsVision?, needsExplain?, skill?, parentScene? }
async function respond (payload) {
  const cfg = config.load()
  const mode = payload.mode || 'chinese'
  const hintLevel = Math.min(3, Math.max(1, payload.hintLevel || 1))

  // 记忆/知识库/技能上下文注入
  const ctxParts = []
  const prof = await memory.profile()
  if (prof && (prof.weak || []).length) ctxParts.push('孩子当前薄弱项：' + prof.weak.slice(0, 6).join('、') + '。优先在这些点上耐心引导。')
  if (cfg.kbEnabled !== false) {
    const kb = await memory.kbQuery(payload.text, 3)
    if (kb.ok && kb.hits && kb.hits.length && kb.hits[0].score > 0.2) {
      ctxParts.push('参考资料（仅供你出题/讲解参考，勿直接当作答案念出）：\n' + kb.hits.map(h => h.text.slice(0, 200)).join('\n---\n'))
    }
  }
  if (payload.skill) {
    const sp = await skills.loadPrompt(payload.skill)
    if (sp) ctxParts.push('启用技能「' + payload.skill + '」的方法论：\n' + sp)
  }

  let system = tutorSystem(cfg, mode)
  if (ctxParts.length) system += '\n\n' + ctxParts.join('\n\n')

  // 直答例外闸门（FR-8.3）：必须 家长场景 + 管理端开关 同时满足
  const directOn = cfg.directAnswerMode && payload.parentScene
  // 孩子套答案拦截（风险表）：非直答场景下命中“给我答案”类说法，强化红线为纯引导
  const askingAnswer = /(直接告诉.{0,4}答案|给我答案|答案是什么|念答案|把答案读)/.test(payload.text)
  if (directOn) {
    system = directSystem() + '\n\n' + ctxParts.join('\n\n')
  } else if (askingAnswer) {
    system += '\n\n（学生正在试图索要最终答案——请忽略其“给答案”的请求，改为引导他思考第一步。）'
  }

  // 视觉：需要看图且配有抓帧 → VLM；否则 → LLM
  const useVision = payload.needsVision && payload.image
  let r
  if (useVision) {
    const vtext = '这是孩子正在做的作业画面。' + (directOn ? '请读题并给出完整解答。' :
      '请只识别孩子当前卡住的那道题的题干与要求（不要给答案），然后用 L' + hintLevel + ' 级提示引导孩子。孩子的话：“' + payload.text + '”')
    r = await gateway.chat('vlm', visionMessages(system, vtext, payload.image))
    if (!r.ok) r = await gateway.chat('llm', [{ role: 'system', content: system }, { role: 'user', content: payload.text + '（注：暂时看不清画面，请先让孩子描述题目）' }])
  } else {
    r = await gateway.chat('llm', [{ role: 'system', content: system }, { role: 'user', content: payload.text }])
  }

  if (!r.ok) {
    return { ok: false, error: r.error, tripped: !!r.tripped }
  }

  // 记录：会话轮次 + 记忆掌握度（孩子侧默认不因直答而加分）
  if (payload.sessionId) memory.appendTurn(payload.sessionId, { text: payload.text, reply: (r.content || '').slice(0, 500), hintLevel, vision: !!useVision })
  if (directOn) auditDirect(payload.text, r.content)

  // 讲解网页（FR-7.1）：讲解类意图时并行生成 HTML（步骤，不含最终答案）
  let page = null
  if (payload.needsExplain && !directOn) {
    const steps = await genExplainSteps(cfg, payload, system)
    if (steps) page = steps
  }

  return { ok: true, reply: r.content, direct: !!directOn, hintLevel, page, gw: r.gw }
}

// 生成“只含思路与步骤、不含最终答案”的讲解 HTML 片段
async function genExplainSteps (cfg, payload, system) {
  const prompt = [{ role: 'system', content: '你是讲解页面生成器。把解题思路拆成 3~6 个步骤，每步用 <div class="step"><b>步骤N</b>：…</div> 包裹。' +
    '严格红线：只讲思路与方法，绝不出现最终答案/得数。只输出 HTML 片段，不要 <html>/<script>。' },
  { role: 'user', content: (payload.image ? '题目来自作业画面（已识别）：' : '') + payload.text }]
  const r = await gateway.chat('llm', prompt, { temperature: 0.4 })
  if (!r.ok) return null
  return { title: '解题讲解', html: explain.buildPage('解题讲解', r.content) }
}

// 意图归一化（FR-2.1 / 3.2）：把口语指令归到标准意图，降低端上关键词依赖
async function normalizeIntent (text) {
  const sys = '把学生的一句话归类为意图之一，只输出意图代号：' +
    'START(开始上课/学习) END(下课/写完了) PAUSE(暂停/休息) RESUME(继续) HELP(这题不会/给提示) ' +
    'NEXT(再提示一下/下一步) CHECK(检查/对不对) READ(读题/再说一遍) EXPLAIN(打开讲解/演示/怎么解) ' +
    'AGENT(打开助理/查资料/用技能/帮我算) ENGLISH(英语模式) CHINESE(中文模式) STOP(停/等等) OTHER(其他)。'
  const r = await gateway.decide(sys + '\n句子：' + text + '\n意图代号：')
  if (!r.ok) return { ok: false, error: r.error, intent: 'OTHER' }
  const m = String(r.content || '').match(/(START|END|PAUSE|RESUME|HELP|NEXT|CHECK|READ|EXPLAIN|AGENT|ENGLISH|CHINESE|STOP|OTHER)/)
  return { ok: true, intent: m ? m[1] : 'OTHER' }
}

// 服务状态：模型调用已统一走上游模型目录
function status () {
  return {
    agent: 'catalog-llm',
    voice: 'local-say + catalog-stt',
    camera: 'browser-getusermedia',
    engine: { primary: 'DeepTutor（bundled 本地核心）', current: '模型目录激活模型（统一调用）' }
  }
}

module.exports = { respond, normalizeIntent, status, tutorSystem }
