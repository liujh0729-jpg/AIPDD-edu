# Third-Party Notices

本产品的构建/运行依赖以下第三方开源组件。本仓库自有代码为 MIT（见 `LICENSE`），
以下组件各自保留其原始许可证，均按其条款使用并注明归属。

## DeepTutor — Apache-2.0

- 项目：https://github.com/HKUDS/DeepTutor （© HKUDS）
- 角色：Agent 主引擎（对话 / 讲解 / 记忆 / 知识库）与内嵌原生界面。
- 形态：本仓库**不包含**其源码；内置 runtime（发布为 Release 的 `runtime-macos-*.tar.gz` 归档）
  由其官方桌面版 `apps/desktop/scripts/build-runtime` 组装产出，基线 commit 记录于
  `UPSTREAM.json`。归档内完整保留上游 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`
  （位于 `runtime/<arch>/core/`）。
- 集成方式：桌面壳以本地子进程拉起其 python/node 服务，WebContentsView 内嵌其 Web UI；
  未修改上游代码（二开采用叠加层，见 UPSTREAM.json `integration` 字段）。

## HyperFrames — Apache-2.0

- 项目：https://github.com/heygen-com/hyperframes （© HeyGen）
- 角色：可选的多模态讲解视频渲染引擎，运行时以 `npx hyperframes render` 外部子进程调用。
- 形态：**不随安装包分发**；缺 Node/FFmpeg 时功能优雅降级。

## nanobot — 仅设计参考

- 项目：https://github.com/nanobrowser/nanobot
- 角色：设计理念参考（习惯固化 / 轻量网关 / 定时自动化），**未使用其任何代码**，不随产品分发。

## Electron 及运行时 — MIT / 各自许可证

- Electron © OpenJS Foundation（MIT）——桌面壳运行时，随 dmg 分发。
- Node.js v22.23.4 © OpenJS Foundation（MIT）——内置 runtime 组件，`node/LICENSE` 随归档保留。
- Python 3.12.13 © Python Software Foundation（PSF License）——内置 runtime 组件（uv standalone 构建）。
- Python 依赖 wheel 与 npm 依赖：许可证各自随 runtime/`core/THIRD_PARTY_NOTICES.md` 及上游声明保留。

## 模型网关

- AIPDD（https://api.aipdd.work）为按量付费的第三方模型网关服务，BYOK：
  密钥由用户自行配置，仅存于用户本机 `userData`，不随代码仓库或安装包分发。
