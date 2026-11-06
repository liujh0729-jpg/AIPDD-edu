// electron-builder afterPack / afterSign 双钩子（正式签名链）。
// 背景与分工：
//  • adhoc 模式（ADHOC_SIGN=1，npm run dist:mac:adhoc）：builder 不签名（identity=null），
//    afterPack 拷入 runtime 后做稳定 adhoc 深度重签（cdhash 固定，TCC 授权可持久）；仅本机调试。
//  • 正式模式：runtime 改在 afterSign 阶段注入（见 afterSign.js）——builder 的
//    readDirectoryAndSign 会对包内目录做签名遍历，碰上几万文件的 python runtime 会
//    泄露句柄报 EMFILE（app-builder-lib 24.x 已知问题，提 ulimit 也只能缓解）。
//    故 afterPack 在正式模式下什么都不做，让 builder 先干净签完小 app。
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  // universal 构建会先生成 x64/arm64 两个临时 app 再 lipo 合并；
  // 若对临时 app 操作会让两侧 _CodeSignature 不一致、合并校验失败，故只处理最终合并后的 universal app。
  if (/-temp$/.test(context.appOutDir)) return
  const { execSync } = require('child_process')
  const path = require('path')
  const fs = require('fs')
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, appName + '.app')
  const adhoc = process.env.ADHOC_SIGN === '1'
  if (!adhoc) return // 正式模式：交给 afterSign

  // —— 以下仅 adhoc 模式 ——
  copyRuntime(appPath)
  try {
    // 本机调试：adhoc 稳定签名，cdhash 固定，TCC 授权可持久化
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
    console.log('[afterPack] 已对 ' + appName + '.app 做稳定 adhoc 重签名')
  } catch (e) {
    console.warn('[afterPack] 重签名失败（不影响打包，但授权可能无法持久化）：' + e.message)
  }
}

// 内置 DeepTutor 双架构 runtime 拷入最终 app（合并完成后才操作，避免
// @electron/universal 看到两份逐字节相同的 Mach-O 触发 x64ArchFiles 校验冲突）。
function copyRuntime (appPath) {
  const path = require('path')
  const fs = require('fs')
  const runtimeBase = path.resolve(__dirname, '../../upstream/deeptutor/apps/desktop/.local')
  const destRuntime = path.join(appPath, 'Contents', 'Resources', 'runtime')
  // fail-fast：缺任一架构 runtime 就直接中止构建（npm 链已前置 fetch:runtime，
  // 走到这里还缺说明拉取被跳过/手工绕过了）——绝不静默产出无后端的“半成品”包。
  for (const archDir of ['macos-arm64', 'macos-x64']) {
    if (!fs.existsSync(path.join(runtimeBase, archDir, 'runtime'))) {
      throw new Error('缺少内置 runtime：' + path.join(runtimeBase, archDir, 'runtime') +
        '\n  请先执行：npm run fetch:runtime（从 GitHub Release 拉取预组装归档）\n' +
        '  或按 README「从源码构建 runtime」自行组装后放置到该路径。')
    }
  }
  for (const archDir of ['macos-arm64', 'macos-x64']) {
    const src = path.join(runtimeBase, archDir, 'runtime')
    const dest = path.join(destRuntime, archDir)
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    console.log('[afterPack] 拷入 runtime：' + archDir)
    fs.cpSync(src, dest, { recursive: true, force: true })
    // 开发机 uv/node 安装产物里的符号链接是指向 .local/<arch>/runtime 的绝对路径：
    // 拷进 bundle 后在用户机全部失效，codesign --strict/Gatekeeper 会因
    // "invalid destination for symbolic link in bundle" 拒绝启动。必须改写为
    // bundle 内相对链接（源前缀 .local/<arch>/runtime/<rel> ≙ bundle <destRuntime>/<arch>/<rel>）。
    rewriteAbsLinks(destRuntime, archDir, src)
  }
  return destRuntime
}

function rewriteAbsLinks (destRuntime, archDir, srcRuntime) {
  const path = require('path')
  const fs = require('fs')
  const root = path.join(destRuntime, archDir)
  let fixed = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isSymbolicLink()) continue
      const tgt = fs.readlinkSync(p)
      if (!path.isAbsolute(tgt) || !tgt.startsWith(srcRuntime + path.sep)) continue
      const inApp = path.join(root, tgt.slice(srcRuntime.length + 1))
      const rel = path.relative(path.dirname(p), inApp)
      fs.unlinkSync(p)
      fs.symlinkSync(rel, p)
      fixed++
    }
  }
  walk(root)
  if (fixed) console.log('[afterPack] 重写绝对符号链接为包内相对链接：' + archDir + ' ×' + fixed)
}

module.exports.copyRuntime = copyRuntime
