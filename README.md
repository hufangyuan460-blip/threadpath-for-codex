# ThreadPath for Codex

> 面向 Codex CLI 的可视化对话导航与分支工作区。  
> A visual conversation navigation and branching workspace for Codex CLI.

[![Status: Prototype](https://img.shields.io/badge/status-prototype-orange.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)
[![License: TBD](https://img.shields.io/badge/license-TBD-lightgrey.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)

## 中文

ThreadPath for Codex 是一个独立的桌面客户端项目，目标是让 Codex CLI 对话更容易浏览、搜索和导航，并为未来的线程 Fork、树视图、DAG 可视化与分支比较提供基础。

项目已完成 `v0.0.1` 协议验证、`M0` 桌面应用外壳、`M1-A` 生命周期接入、`M1-B` 线程列表读取、`M2-A` 只读线性对话渲染、`M2-B` 最小回合发送与流式更新、`M3-A` 回合大纲跳转、`M3-B` 滚动联动高亮、`M3-C` 已加载回合搜索、`M4-A` 回合分页加载、`M4-B` 对话虚拟化和 `M4-C` 桌面端关键路径 E2E。协议代码集中在 `threadpath-protocol/`，Electron 主进程管理 app-server 和会话应用服务；当前不提供跨线程搜索、未加载页面搜索、Tree View 或 DAG。

### 当前能力

- 通过 stdio 启动 `codex app-server`；
- 使用 JSONL 和 JSON-RPC 通信；
- 验证 `initialize`、`thread/list`、`thread/read`、`thread/turns/list`；
- 验证 `thread/start` 和 `turn/start`；
- 接收并处理流式通知；
- 处理请求超时、进程退出、格式错误输出、服务端错误和协议错误；
- 以 fake app-server 覆盖已有/空线程、三种回合终态和关键故障路径；
- 提供 `apps/desktop/` M0 安全桌面外壳，启用 context isolation 并禁用 renderer Node 集成；
- 由 Electron 主进程管理 app-server 连接状态、初始化、关闭和重连；
- 在主进程通过类型化服务加载线程列表，并读取选中线程的安全元数据视图；
- renderer 仅通过 preload 使用受限的线程列表和读取 API；
- 按回合顺序显示用户、助手、系统和工具状态的纯文本视图，并为回合保留稳定锚点；
- 在线程选中且连接就绪时发送纯文本回合，接收助手 delta，并显示完成、失败和中断状态；
- 通过 preload 暴露可取消的受限会话更新订阅，并对重复事件和旧线程事件做去重/过滤；
- 从类型化会话模型生成安全回合大纲，支持键盘聚焦、Enter 激活和稳定锚点跳转；
- 根据滚动位置确定当前回合，高亮大纲项目，并在程序化跳转后保持状态同步；
- 在当前已加载线程中提供中英文不区分大小写的回合搜索、防抖输入和结果跳转；
- 使用游标分页加载更早回合，并按稳定回合 ID 合并重复或乱序页面；
- 使用 `react-virtuoso` 仅渲染可见附近的回合，支持稳定 ID 跳转和分页时的位置保持；
- 使用 fake app-server 自动验证桌面端 ready、线程读取、导航、搜索、流式回合和失败/中断路径；
- 为未来的 Electron 桌面客户端积累协议事实。

### 快速开始

前置条件：

- 已安装 Codex CLI；
- Codex CLI 已完成认证；
- Node.js 支持 `--experimental-strip-types`；
- 当前工作目录可访问本地 Codex 服务。

运行协议冒烟测试：

```powershell
cd threadpath-protocol
npm run smoke
```

先运行不依赖认证或网络的类型检查与传输测试：

```powershell
npm run typecheck
npm test
```

GitHub Actions 使用 Windows、固定的 Node.js/pnpm 版本和 `pnpm install --frozen-lockfile`，运行 fake app-server fixture 的 typecheck、test、build 和桌面端 E2E，并上传日志、失败截图与构建产物。`npm run smoke` 或对应的真实协议冒烟测试仍需在本地运行，因为它依赖 Codex 登录状态和上游网络，不属于 CI 门禁。

桌面端关键路径可运行：

```powershell
pnpm test:e2e
```

该命令通过 `CODEX_EXECUTABLE` 指向仓库内的 fake app-server，不使用真实 Codex 认证、桌面配置或网络模型调用；失败时会在 `artifacts/e2e/` 生成测试日志和截图。

默认测试工作目录是当前项目目录 `D:\threadPath`。如需测试其他项目：

```powershell
$env:CODEX_SMOKE_CWD = "D:\another-project"
npm run smoke
```

可选的超时时间配置：

```powershell
$env:CODEX_SMOKE_TIMEOUT_MS = "180000"
npm run smoke
```

### 项目文档

- [开发规范](SPEC.md)：目标架构、功能需求、测试策略和未来设计约束；
- [Codex 指令](AGENTS.md)：供 Codex 使用的项目工作规则；
- [项目路线图](README-ROADMAP.md)：版本计划和里程碑；
- [`threadpath-protocol/README.md`](threadpath-protocol/README.md)：原型运行方式和协议验证记录。

### 路线图

- `M0`：安全 Electron 桌面应用外壳，暂不连接 app-server；
- `M1-A`：主进程接入 app-server 生命周期，renderer 仅显示连接状态；
- `M1-B`：线程列表与线程元数据读取，暂不显示消息正文；
- `M2-A`：只读线性对话渲染，支持回合锚点；暂不支持流式更新、Markdown、搜索和大纲；
- `M2-B`：支持发送单个纯文本回合和白名单流式更新；暂不支持取消、工具审批、Markdown、搜索和大纲；
- `M3-A`：支持回合大纲和点击/键盘跳转；暂不支持滚动联动高亮、搜索、分页和虚拟化；
- `M3-B`：支持滚动联动高亮、程序化跳转和大纲自动跟随；暂不支持搜索、分页和虚拟化；
- `M3-C`：支持当前已加载回合搜索和结果跳转；不搜索跨线程或未加载页面；
- `M4-C`：使用 fake app-server 验证桌面端关键路径，不依赖真实认证或网络；
- `v0.0.1`：Codex app-server 协议验证、JSONL/JSON-RPC 传输与可重复故障测试；
- `v0.0.2`：可复用的类型化协议客户端、版本化 fixture 和脱敏诊断事件日志；
- `v0.1.0`：线性对话基础、线程/回合加载、导航和搜索；
- `v0.2.0`：稳定性强化、诊断、性能和无障碍优化；
- `v0.3.0`：Fork 与分支领域模型基础；
- `v0.4.0`：树视图；
- `v0.5.0`：DAG 投影和分支比较；
- `v1.0.0`：稳定桌面版本。

### 项目状态

这是一个早期原型。协议行为、Codex CLI 版本兼容性和桌面应用架构仍在验证中，不应将当前原型视为稳定发布版本。

## English

ThreadPath for Codex is an independent desktop client project designed to make Codex CLI conversations easier to browse, search, and navigate. It also lays the foundation for future thread forking, tree views, DAG visualization, and branch comparison.

The project has completed `v0.0.1` protocol validation, the `M0` desktop shell, `M1-A` lifecycle integration, `M1-B` thread loading, `M2-A` read-only linear conversation rendering, `M2-B` minimal turn sending and streaming updates, `M3-A` turn outline navigation, `M3-B` scroll-linked active-turn highlighting, `M3-C` loaded-turn search, `M4-A` paginated turn loading, `M4-B` conversation virtualization, and `M4-C` desktop critical-path E2E coverage. The Electron main process owns the app-server and conversation service; cross-thread and unloaded-page search, Tree View, and DAG are not included.

### Current capabilities

- Starts `codex app-server` over stdio;
- Communicates using JSONL and JSON-RPC;
- Verifies `initialize`, `thread/list`, `thread/read`, and `thread/turns/list`;
- Verifies `thread/start` and `turn/start`;
- Receives and handles streaming notifications;
- Handles request timeouts, process exits, malformed stdout, server errors, and protocol errors;
- Uses a fake app-server to cover existing/empty thread lists, three terminal turn outcomes, and key failure paths;
- Provides an `apps/desktop/` M0 secure desktop shell with context isolation and renderer Node integration disabled;
- Lets the Electron main process own app-server connection, initialization, shutdown, and reconnection;
- Loads threads and reads selected-thread metadata through typed main-process services;
- Exposes only restricted thread-list and thread-read APIs through preload;
- Renders user, assistant, system, and tool-status text in turn order with stable turn anchors;
- Sends one plain-text turn at a time and applies allowlisted assistant deltas and terminal states;
- Exposes a removable, restricted conversation-update subscription through preload with duplicate and stale-thread filtering;
- Generates a safe turn outline from typed conversation data and supports keyboard/click navigation to stable anchors;
- Computes the active turn from scroll position, highlights its outline entry, and keeps programmatic navigation synchronized;
- Searches the current loaded thread with debounced, case-insensitive substring matching and stable result navigation;
- Loads earlier turns with cursor pagination and stable-ID merging, and virtualizes the conversation list with `react-virtuoso`;
- Runs desktop critical-path E2E coverage against the fake app-server for ready state, thread reading, navigation, search, streaming turns, and failure/interruption paths;
- Builds protocol knowledge for the future Electron desktop client.

GitHub Actions runs the same authentication- and network-independent fixture typecheck, test, and build on Windows after a frozen pnpm install. The real `smoke` command remains a local check because it requires Codex authentication and upstream network access.

For the desktop critical-path check, run `pnpm test:e2e`. It builds the desktop app and launches it against the repository's fake app-server through `CODEX_EXECUTABLE`; it does not use Codex authentication, real desktop configuration, or network model calls. The Windows quality workflow runs the same E2E suite and uploads failure logs, screenshots, and build artifacts.

### Quick start

Prerequisites:

- Codex CLI is installed;
- Codex CLI authentication is configured;
- Node.js supports `--experimental-strip-types`;
- The working directory can access the local Codex service.

Run the protocol smoke test:

```powershell
cd threadpath-protocol
npm run smoke
```

Run the authentication- and network-independent type check and transport tests first:

```powershell
npm run typecheck
npm test
```

The default test working directory is `D:\threadPath`. To test another project:

```powershell
$env:CODEX_SMOKE_CWD = "D:\another-project"
npm run smoke
```

An optional timeout can be configured with:

```powershell
$env:CODEX_SMOKE_TIMEOUT_MS = "180000"
npm run smoke
```

### Project documentation

- [Development specification](SPEC.md): target architecture, requirements, testing strategy, and future design constraints;
- [Codex instructions](AGENTS.md): project rules for Codex;
- [Roadmap](README-ROADMAP.md): release plan and milestones;
- [`threadpath-protocol/README.md`](threadpath-protocol/README.md): prototype usage and protocol validation notes.

### Roadmap

- `M0`: secure Electron desktop application shell without app-server integration;
- `M1-A`: main-process app-server lifecycle integration with renderer connection status;
- `M1-B`: thread list and thread metadata reading without message rendering;
- `M2-A`: read-only linear conversation rendering with stable turn anchors; no streaming, Markdown, search, or outline;
- `M2-B`: one plain-text turn at a time with allowlisted streaming updates; no cancellation, tool approval, Markdown, search, or outline;
- `M3-A`: turn outline with click/keyboard navigation; no scroll-linked highlighting, search, pagination, or virtualization;
- `M3-B`: scroll-linked active-turn highlighting, programmatic navigation, and outline auto-follow; no search, pagination, or virtualization;
- `M3-C`: loaded-turn search with stable result navigation; no cross-thread or unloaded-page search, pagination, or virtualization;
- `M4-C`: fake app-server desktop critical-path coverage without real authentication or network;
- `v0.0.1`: Codex app-server protocol validation, JSONL/JSON-RPC transport, and repeatable failure tests;
- `v0.0.2`: reusable typed protocol client APIs, versioned fixtures, and redacted diagnostic event logging;
- `v0.1.0`: linear conversation foundation, thread/turn loading, navigation, and search;
- `v0.2.0`: hardening, diagnostics, performance, and accessibility improvements;
- `v0.3.0`: fork and branch domain-model groundwork;
- `v0.4.0`: tree view;
- `v0.5.0`: DAG projection and branch comparison;
- `v1.0.0`: stable desktop release.

### Project status

This is an early prototype. Protocol behavior, Codex CLI version compatibility, and the desktop application architecture are still being validated. The current prototype should not be treated as a stable release.

## License

License terms have not been finalized yet.  
许可证尚未最终确定。
