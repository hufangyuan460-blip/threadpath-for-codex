# ThreadPath for Codex

> 与 Codex 官方客户端并行使用的会话历史与工作区管理桌面工具。
> A desktop companion for browsing and organizing Codex history and workspaces alongside the official client.

[![Status: Beta](https://img.shields.io/badge/status-beta-64748b.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)
[![Windows](https://img.shields.io/badge/platform-Windows-64748b.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex/releases/tag/v0.1.0-beta.1)

## 产品定位

ThreadPath 不替代 Codex 官方客户端，而是它的本地历史管理伴侣：在官方客户端中完成日常编码、审批和关键操作；在 ThreadPath 中同步、搜索、浏览和整理会话与工作区。

- 从本地 Codex CLI `app-server` 读取已同步的会话和工作目录；
- 以工作区分组、搜索、收藏、隐藏和本地命名整理历史；
- 首页输入框显示当前工作区名称；支持归档到 Codex 历史并从“已归档”恢复；
- 提供回合目录、Markdown 阅读、分页与虚拟列表，适合长会话回溯；
- 仅在确认工作目录且服务器确认线程可写时允许发起或续聊，避免与其他客户端争用写入；
- 收藏、隐藏、命名等整理偏好保存在 ThreadPath 本地；归档和恢复通过 Codex 协议同步实际会话状态。

当前为 `v0.1.0-beta.1`。需要已安装并完成认证的 Codex CLI；安装包不包含 CLI、未签名，也暂未提供自动更新。

## 界面预览

**黑色主题**

![黑色主题下的工作区与会话界面](docs/screenshots/workspace-black.png)

**石墨灰主题**

![石墨灰主题下的工作区与会话界面](docs/screenshots/workspace-graphite.png)

**浅色主题**

![浅色主题下的工作区与会话界面](docs/screenshots/workspace-light.png)

## 技术栈

- **桌面端：** Electron、Vite、React、TypeScript；
- **会话协议：** Codex CLI `app-server`、stdio、JSONL / JSON-RPC；
- **长会话体验：** `react-virtuoso` 虚拟列表、安全 Markdown 渲染；
- **构建与质量：** pnpm、Node.js 24、NSIS、GitHub Actions、fake app-server E2E。

## 获取与运行

从 [GitHub Releases](https://github.com/hufangyuan460-blip/threadpath-for-codex/releases/tag/v0.1.0-beta.1) 下载最新 Windows 安装包。首次启动时，应用会自动发现已安装的 Codex CLI；找不到时可手动选择 `codex.exe` 与工作目录。

开发环境：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm package:win
```

真实协议验证依赖本机登录状态与网络：

```powershell
pnpm smoke
```

## 当前 Beta 功能与后续展望

2026-10-12 更新的 Beta 安装包包含分支讨论闭环：在已结束回合点击「从这里分支」，得到继承至该回合的新对话；通过卡片与连线切换原路线、同级分支和嵌套分支。输入区显示当前续聊对象，各会话草稿与分支关系在重启后恢复。

卡片显示来源会话与源问题，点击来源直接回到分叉回合；分支正文标出继承历史和新增讨论的分界。分叉点位于更早页面时会自动加载，缺失或读取失败会明确提示并允许重试。

当前 Beta 更新已接入编织图标，并修复首页新建后因历史索引延迟退回首页的问题；核对与验证见 [修复记录](docs/desktop-fixes-2026-10-12.md)。

新分支共用源会话的工作目录，按只读讨论模式续聊；每次发送前要求 Codex 确认只读策略。具体操作、验证范围和限制见 [分支讨论说明](docs/branch-conversation.md)。完整验收命令为 `pnpm test:e2e`。

![分支讨论路线图（合成测试会话）](docs/screenshots/branch-routes.png)

后续优先观察真实使用中是否减少重复描述上下文、方案混杂和找不到原路线的问题，再决定比较或工作目录隔离等功能的必要性。

## English

ThreadPath is a local companion to the official Codex client, not a replacement. Use the official client for day-to-day coding and approvals; use ThreadPath to synchronize, search, read, and organize Codex history and workspaces.

It connects to the local Codex CLI `app-server`, keeps workspace organization preferences locally, and allows sending only after a working directory and a writable thread have been confirmed. The current `v0.1.0-beta.1` Windows installer requires an installed and authenticated Codex CLI; it does not bundle the CLI, include code signing, or provide auto-updates yet.

The stack is Electron, Vite, React, TypeScript, the Codex `app-server` over stdio JSONL/JSON-RPC, `react-virtuoso`, pnpm, NSIS, and GitHub Actions. Near-term work focuses on reliability, complete history synchronization, performance, and accessibility before advanced workspace and conversation views.

## License

License terms have not been finalized.
许可证尚未最终确定。
