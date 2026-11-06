// 构建后公证步骤（npm run dist:mac 的第二段）。
// 为什么不用 electron-builder 内建 notarize：它发生在 app 签名阶段、runtime 注入（afterSign）
// 之前——公证的是旧内容，票据对不上终态 app，dmg 也不会钉票。正确做法是对最终 dmg 整体
// 提交公证并 staple（票据钉进 dmg，离线可验）。
// 凭证只从环境变量读取（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID），绝不落盘。
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const appleId = process.env.APPLE_ID
const pwd = process.env.APPLE_APP_SPECIFIC_PASSWORD
const teamId = process.env.APPLE_TEAM_ID
if (!appleId || !pwd || !teamId) {
  console.error('[notarize] 缺少环境变量 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，跳过公证')
  process.exit(2)
}

const dist = path.resolve(__dirname, '../dist')
const dmg = fs.readdirSync(dist).find((f) => f.endsWith('.dmg') && f.includes('universal'))
if (!dmg) {
  console.error('[notarize] dist 下未找到 universal dmg')
  process.exit(2)
}
const dmgPath = path.join(dist, dmg)

console.log('[notarize] 提交：' + dmg + '（排队通常 1~5 分钟）')
// argv 数组传参：凭证与路径不经过 shell 解析，元字符不会注入
execFileSync('xcrun', ['notarytool', 'submit', dmgPath, '--apple-id', appleId, '--password', pwd, '--team-id', teamId, '--wait'], { stdio: 'inherit' })
console.log('[notarize] 钉票 staple…')
execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' })
execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' })
console.log('[notarize] 完成：' + dmgPath + ' 公证就绪，可直接分发')
