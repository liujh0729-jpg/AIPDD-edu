// electron-builder afterSign：正式签名链的 runtime 注入与终签（公证就绪）。
// 为什么放 afterSign 而不是 afterPack：builder 的 readDirectoryAndSign 在 afterPack 之后
// 会对 app 目录做遍历签名，几万文件的 python runtime 会触发句柄泄露 EMFILE（24.x 已知问题）。
// afterSign 在 builder 签名完成、dmg 制作之前执行——此时拷入 runtime 并自行完成全部签名：
//  1) 逐个 Developer ID + hardened runtime + 时间戳签 runtime 内 Mach-O；
//  2) 外层 app 带 entitlements 重签（覆盖新增文件对封条的影响）。
// 之后 builder 直接打 dmg，notarize 提交的就是终态签名。adhoc 模式由 afterPack 全权处理，此处跳过。
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { copyRuntime } = require('./afterPack')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  if (/-temp$/.test(context.appOutDir)) return
  if (process.env.ADHOC_SIGN === '1') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, appName + '.app')
  const identity = process.env.CSC_NAME || 'Developer ID Application'
  const entitlements = path.join(__dirname, 'entitlements.mac.plist')

  const destRuntime = copyRuntime(appPath)

  // 公证要求包内每一个 Mach-O 都有 Developer ID 签名 + 安全时间戳。
  // runtime 是普通目录树（非嵌套 bundle），--deep 盖不到，需逐个签。
  if (fs.existsSync(destRuntime)) {
    const out = execSync(`find "${destRuntime}" -type f -exec file {} + 2>/dev/null | grep -a Mach-O`, { maxBuffer: 64 * 1024 * 1024 }).toString()
    // fat 二进制的 file 输出按架构切片多行（"path (for architecture x86_64):\t…"），
    // 后缀在冒号前，先截冒号再剥离切片后缀，去重得到真实文件路径。
    const bins = Array.from(new Set(out.split('\n')
      .map((l) => l.slice(0, l.indexOf(':')).replace(/ \(for architecture [^)]*\)$/, ''))
      .filter(Boolean)))
    console.log('[afterSign] 签名 runtime 内 Mach-O：' + bins.length + ' 个')
    for (const bin of bins) {
      // 跳过条件必须是「真名签发」：Authority=Developer ID 且带安全时间戳。
      // 不能用 codesign --verify：runtime 自带的 adhoc 签名也能通过 verify，
      // 会被误跳过导致公证 Invalid（notarytool 拒收 adhoc/无时间戳）。
      let info = ''
      try { info = execSync(`codesign -dvv "${bin}" 2>&1`, { stdio: 'pipe' }).toString() } catch (e) {}
      if (/Authority=Developer ID/.test(info) && /Timestamp=/.test(info)) continue
      execSync(`codesign --force --options runtime --timestamp --sign "${identity}" "${bin}"`, { stdio: 'pipe' })
    }
  }
  // 外层 app：带 entitlements + hardened runtime + 时间戳，--deep 兼容其余嵌套项
  execSync(`codesign --force --deep --options runtime --timestamp --entitlements "${entitlements}" --sign "${identity}" "${appPath}"`, { stdio: 'inherit' })
  console.log('[afterSign] 已用 Developer ID 完整重签 ' + appName + '.app（公证就绪）')
}
