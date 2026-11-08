// 内嵌 DeepTutor 视图专用 bridge preload（CommonJS，sandbox 预加载）。
// 目的：让上游设置页（我们新增的原生分区）能读写本产品存于 Electron 本地 config.json 的配置，
//       并调用本产品自有能力（用量计量 / 记忆 / 知识库 / 报告 / 技能 / 智能硬件）。
// 模型提供方/凭证统一由上游模型目录管理，桥不再暴露网关/密钥方法。
// 硬约束：只暴露极窄的一组命名方法；不暴露 Node/fs。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__edu', {
  // 标记：上游页据此判断"是否运行在本产品壳内"，普通浏览器环境下这些分区显示不可用
  inShell: true,

  // 配置（本产品本地 config.json，非 DeepTutor 后端）
  getConfig: () => ipcRenderer.invoke('config:load'),
  patchConfig: (patch) => ipcRenderer.invoke('config:patch', patch),

  // 用量
  usageSummary: () => ipcRenderer.invoke('usage:summary'),

  // 学习记忆
  memoryFacts: () => ipcRenderer.invoke('memory:facts'),
  memoryL1: (limit) => ipcRenderer.invoke('memory:l1', limit),
  memoryProfile: () => ipcRenderer.invoke('memory:profile'),
  memoryFactEdit: (topic, mastery) => ipcRenderer.invoke('memory:fact:edit', { topic, mastery }),
  memoryFactDelete: (topic) => ipcRenderer.invoke('memory:fact:delete', topic),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),

  // 知识库
  kbList: () => ipcRenderer.invoke('kb:list'),
  kbIngest: () => ipcRenderer.invoke('kb:ingest'),
  kbDelete: (id) => ipcRenderer.invoke('kb:delete', id),

  // 学习报告
  reportList: () => ipcRenderer.invoke('report:list'),
  openFrame: (p) => ipcRenderer.invoke('report:openFrame', p),

  // 技能生态（上游 /api/skills 为唯一真源；hub 浏览/安装已统一进上游 hub API）
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillEnable: (name, on) => ipcRenderer.invoke('skill:enable', { name, on }),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),
  skillInstallLocal: () => ipcRenderer.invoke('skill:installLocal'),
  skillInstallHub: (item) => ipcRenderer.invoke('skill:installHub', item),

  // 智能硬件
  hwStatus: () => ipcRenderer.invoke('hardware:status'),
  hwDevices: () => ipcRenderer.invoke('hardware:devices')
})
