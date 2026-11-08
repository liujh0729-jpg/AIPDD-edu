# AI学习助理（AIPDD-edu）

面向家庭学习场景的 AI 语音家教桌面应用（macOS）。孩子对着屏幕/作业开口提问，应用完成
**听得清（语音识别）→ 想得对（AI 讲解）→ 说得明（语音播报）** 的闭环，并提供三种学习模式：

- **沉浸式学习**：麦克风 + 摄像头 + 语音唤醒（默认唤醒词「小老师」），辅导作业全程免触屏。
- **全景学习**：全局热键把"当前屏幕"变成上下文——指着屏幕上的题直接问，支持屏幕标注讲解、追问窗口与文字记忆。
- **智能硬件**：局域网自动发现并配对 ESP32 语音外设（参考固件与协议见 `firmware/`），设备只做拾音/播报的 IO 前端，AI 全部在电脑端。

## 架构

```
┌─────────────────────────── Electron 桌面壳（本仓库 app/）───────────────────────────┐
│  学习端 UI / 语音管线(speech) / 全景(panorama) / 硬件(hardware) / 网关路由(gateway)   │
│                     │ bundled 自启（launcher.js）                                   │
├─────────────────────┴───────────────────────────────────────────────────────────────┤
│  内置 runtime（Release 二进制分发 / 或从上游源码组装，见下文）                        │
│   ├─ python + DeepTutor core   Agent 主引擎（对话/讲解/记忆/知识库）                 │
│   ├─ web (Next.js 产物)        DeepTutor 原生界面（内嵌于壳，WebContentsView）       │
│   └─ node                      本地服务进程                                          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  模型网关：AIPDD（BYOK，密钥仅存本机 userData，绝不进仓库/构建产物）                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 目录结构

```
app/                     Electron 桌面壳（产品主体代码）
  src/main/              主进程：网关路由 / 语音 / 全景 / 硬件 / Agent 编排 / 配置 / 记忆
  src/renderer/          学习端界面 + 屏幕 overlay
  build/                 electron-builder 钩子：runtime 注入、Developer ID 签名、公证
  scripts/               fetch-runtime.js（构建前置：拉取内置 runtime）
firmware/                ESP32 智能硬件参考固件 + 发现/配对协议（PROTOCOL.md）
需求/                    产品需求与方案文档
UPSTREAM.json            上游组件归属、许可证与基线（构建 runtime 的出处）
```

## 快速开始（macOS）

前置：macOS + [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/)（含 `codesign`/`tar`/`curl`）、Node.js ≥ 20。**无需安装 Python**——学习引擎随内置 runtime 分发。

```bash
git clone https://github.com/liujh0729-jpg/AIPDD-edu.git
cd AIPDD-edu/app
npm install

npm start                    # 开发运行（prestart 自动拉取 runtime，首次约 660MB）
npm run dist:mac:adhoc       # 构建本机可用的 universal dmg（无需苹果开发者账号）
```

构建链保证"成品而非半成品"：`fetch-runtime` 未就绪时，打包钩子会**直接报错中止**而不是静默产出没有后端的空壳包。

### 你需要知道的三件事

1. **模型密钥（BYOK）**：首次启动在应用内「设置 → 网关」填入你的 AIPDD（或兼容 OpenAI 协议）网关地址与 Key。Key 只写入本机 `userData`（0600），不进仓库、不进包。
2. **签名与公证**：官方 Release 的 dmg 由维护者的 Apple Developer 账号完成 Developer ID 签名 + 公证（`build/notarize.js`、`build/afterSign.js` 全部开源）。你自己构建时用 `dist:mac:adhoc` 即可在本机运行；要对外分发请替换为你自己的证书与公证凭证，流程完全一致。
3. **Windows**：当前未包含 Windows runtime 与打包配置，`--win` 暂不可用；上游 DeepTutor 官方桌面版支持 windows-x64，本仓库后续版本跟进。

## 从源码构建 runtime（不使用预组装二进制）

内置 runtime（python 3.12.13 · node 22.23.4 · DeepTutor core · web 构建产物）由
[DeepTutor](https://github.com/HKUDS/DeepTutor) 官方桌面版的 `build-runtime` 脚本组装，
基线 commit 见 `UPSTREAM.json` 与 `app/scripts/fetch-runtime.js` 注释：

```bash
git clone https://github.com/HKUDS/DeepTutor.git
cd DeepTutor/apps/desktop
node scripts/build-runtime --target macos-arm64     # 产出 .local/macos-arm64/runtime/
node scripts/build-runtime --target macos-x64
```

把两个 `runtime/` 目录放到 `AIPDD-edu/upstream/deeptutor/apps/desktop/.local/<arch>/`，
后续 `npm start` / `npm run dist:mac(:adhoc)` 会自动检测已有 runtime 并跳过下载，构建产物与
二进制路径完全一致（差异仅在你自己的签名）。

## 发布

- 最新 Release：[v0.11.0](https://github.com/liujh0729-jpg/AIPDD-edu/releases/tag/v0.11.0)
  —— 已公证的 dmg 安装包 + 双架构 runtime 归档（构建依赖，含 sha256 校验）。
- `npm run dist:mac` = universal 构建 → afterSign 注入 runtime 并逐文件 Developer ID 签名 → dmg → notarytool 公证 + staple。

## 上游归属与许可证

- 本仓库自有代码：MIT（见 `LICENSE`）。
- DeepTutor（Agent 主引擎，Apache-2.0）、HyperFrames（讲解视频渲染，Apache-2.0，可选外部调用）、nanobot（仅设计参考，未含其代码）等第三方归属与基线详见 `THIRD_PARTY_NOTICES.md` 与 `UPSTREAM.json`。runtime 归档内保留上游 `LICENSE` 及依赖声明。
