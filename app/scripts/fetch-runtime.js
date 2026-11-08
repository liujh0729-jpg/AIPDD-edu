// fetch-runtime.js — 一键获取打包所需的双架构内置 runtime（构建前置，非可选步骤）。
//
// 背景：桌面壳启动/打包都依赖封包内 runtime/{python,node,web,core}（launcher.js 定位、
// build/afterPack.js copyRuntime 注入）。该 runtime 由上游 DeepTutor 官方
// apps/desktop/scripts/build-runtime 组装产出（基线见仓库根 UPSTREAM.json），
// 体积约 2G，不进 git 仓库，而是作为 v0.11.0 Release 的二进制资产分发。
//
// 本脚本：查询 Release → 下载对应架构归档（走 api.github.com 重定向，免 token）→
// sha256 校验（期望值钉死在 runtime-sha256.json，防篡改/防损坏）→ 解包到与
// copyRuntime 对齐的 .local 路径。已存在则跳过；--force 强制重拉。
//
// 不想使用预组装二进制？可完全从源码自行组装，见 README「从源码构建 runtime」。
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const REPO = 'liujh0729-jpg/AIPDD-edu'
const TAG = 'v0.11.0'
const ARCHES = ['macos-arm64', 'macos-x64']
// 与 build/afterPack.js copyRuntime 及 launcher.js 开发态的定位路径保持一致
const LOCAL = path.resolve(__dirname, '../../upstream/deeptutor/apps/desktop/.local')
const EXPECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-sha256.json'), 'utf8'))
const force = process.argv.includes('--force')

function apiGet (url) {
  return new Promise((resolve, reject) => {
    const get = (u) => https.get(u, { headers: { 'User-Agent': 'edu-fetch-runtime', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location) }
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 200))))
    }).on('error', reject)
    get(url)
  })
}

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

async function main () {
  for (const arch of ARCHES) {
    // 就绪标记：launcher 启动必需的二进制存在即视为已就绪（BUILD_INFO.json 仅是上游组装
    // 元数据，x64 切片本就无此文件，代码不引用，不作判据）
    const marker = path.join(LOCAL, arch, 'runtime', 'node', 'bin', 'node')
    if (fs.existsSync(marker) && !force) {
      console.log('[fetch-runtime] 已存在，跳过：' + arch)
      continue
    }
    console.log('[fetch-runtime] Release ' + TAG + ' 查询资产 runtime-' + arch + '.tar.gz …')
    const rel = await apiGet('https://api.github.com/repos/' + REPO + '/releases/tags/' + TAG)
    const asset = rel.assets.find((a) => a.name === 'runtime-' + arch + '.tar.gz')
    if (!asset) throw new Error('Release 上未找到 runtime-' + arch + '.tar.gz')
    const tmp = path.join(os.tmpdir(), 'runtime-' + arch + '.tar.gz')
    console.log('[fetch-runtime] 下载 ' + Math.round(asset.size / 1048576) + 'MB → ' + tmp)
    execFileSync('curl', ['-fSL', '--retry', '3', '--connect-timeout', '15', '--progress-bar',
      '-H', 'Accept: application/octet-stream', '-o', tmp, asset.url], { stdio: 'inherit' })
    const got = await sha256(tmp)
    const want = EXPECT['runtime-' + arch + '.tar.gz']
    if (got !== want) throw new Error('sha256 校验失败！期望 ' + want + '，实际 ' + got + '（文件损坏或被篡改，已中止）')
    console.log('[fetch-runtime] sha256 校验通过')
    const dest = path.join(LOCAL, arch, 'runtime')
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    execFileSync('tar', ['-xzf', tmp, '-C', dest])
    fs.rmSync(tmp, { force: true })
    if (!fs.existsSync(path.join(dest, 'node', 'bin', 'node'))) throw new Error('解包后未找到 node/bin/node：' + dest)
    console.log('[fetch-runtime] 就绪：' + dest)
  }
  console.log('[fetch-runtime] 双架构 runtime 就绪，可继续 npm run dist:mac(:adhoc) / npm start')
}

main().catch((e) => { console.error('[fetch-runtime] 失败：' + e.message); process.exit(1) })
