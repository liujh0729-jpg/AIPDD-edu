// 全景标注覆盖窗专用 preload：只暴露两个事件订阅，覆盖层无导航/无 node/不读任何数据
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('panoramaAPI', {
  onDraw: (cb) => ipcRenderer.on('overlay:draw', (_e, p) => cb(p)),
  onClear: (cb) => ipcRenderer.on('overlay:clear', () => cb())
})
