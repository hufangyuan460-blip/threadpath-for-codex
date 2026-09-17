# ThreadPath for Codex

> 面向 Codex CLI 的可视化对话导航与工作区管理。
> A visual conversation navigation and workspace client for Codex CLI.

[![Status: Prototype](https://img.shields.io/badge/status-prototype-orange.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)
[![License: TBD](https://img.shields.io/badge/license-TBD-lightgrey.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)

## 中文

ThreadPath for Codex 是一个独立的桌面客户端原型，目标是让 Codex CLI 对话更容易浏览、搜索、导航和按工作目录整理，并为未来的线程 Fork、树视图、DAG 可视化与分支比较提供基础。当前实际可运行代码位于 `threadpath-protocol/` 和 `apps/desktop/`；`SPEC.md` 中尚未实现的未来架构不应视为当前功能。

项目已完成 `v0.0.1` 协议验证、`M0` 至 `M4-C` 桌面端能力，并包含 `M4-D` Windows x64 NSIS 安装配置。当前主分支是可运行的预发布桌面原型，尚未宣称为稳定的 GitHub Release；协议代码集中在 `threadpath-protocol/`，Electron 主进程管理 app-server 和会话应用服务。

### 当前能力

- 通过 stdio 启动 `codex app-server`；
- 使用 JSONL 和 JSON-RPC 通信；
- 验证 `initialize`、`thread/list`、`thread/read`、`thread/turns/list`；
- 验证 `thread/start` 和 `turn/start`；
- 接收并处理流式通知；
- 处理请求超时、进程退出、格式错误输出、服务端错误和协议错误；
- 以 fake app-server 覆盖已有/空线程、三种回合终态和关键故障路径；
- 按 `CODEX_EXECUTABLE`、已保存选择、PATH、已知 Windows 安装目录和手动选择的顺序自动发现 Codex CLI，并通过 `codex --version` 验证候选；
- 提供 `apps/desktop/` M0 安全桌面外壳，启用 context isolation 并禁用 renderer Node 集成；
- 由 Electron 主进程管理 app-server 连接状态、初始化、关闭和重连；
- 未确认工作目录时使用隔离的 `history-runtime` 进入只读历史模式；确认工作目录后才允许新建、续聊和发送回合；
- 同步未归档与已归档线程，构建 ThreadPath 本地历史镜像，并按本地绑定或 Codex 返回的 `cwd` 分组工作区；无法确认归属的线程进入未分类历史；
- 未选中线程时可选择工作目录并创建持久线程；线程工作区绑定、展开状态和本地展示名称保存在 ThreadPath 配置中，不修改 Codex 原始线程数据；
- 在主进程通过类型化服务加载线程列表，并读取选中线程的安全元数据视图；
- 既有线程发送前使用已验证的 `thread/resume` 流程；线程不可用、不可写或存在远端 active writer 时阻止发送、保留草稿并显示可操作提示；
- 以工作区和线程为粒度维护本地/外部写入锁，支持多个并发锁安全共存和分别释放；
- renderer 仅通过 preload 使用受限的线程列表和读取 API；
- 按回合顺序显示用户、助手、系统和工具状态的纯文本视图，并为回合保留稳定锚点；
- 将历史助手/系统文本与流式回合统一为带阶段的内容块；稳定历史和完成回合安全渲染 Markdown，流式与失败/中断内容保持纯文本降级；
- 助手和系统最终文本支持安全 Markdown 结构化展示；用户输入、流式文本、失败/中断内容和工具状态按不可信纯文本或独立状态块处理；
- 在线程选中且连接就绪时发送纯文本回合，接收助手 delta，并显示完成、失败和中断状态；
- 通过 preload 暴露可取消的受限会话更新订阅，并对重复事件和旧线程事件做去重/过滤；
- 从类型化会话模型生成安全回合大纲，支持键盘聚焦、Enter 激活和稳定锚点跳转；
- 根据滚动位置确定当前回合，高亮大纲项目，并在程序化跳转后保持状态同步；
- 在当前已加载线程中提供中英文不区分大小写的回合搜索、防抖输入和结果跳转；
- 使用游标分页加载更早回合，并按稳定回合 ID 合并重复或乱序页面；
- 使用 `react-virtuoso` 仅渲染可见附近的回合，支持稳定 ID 跳转和分页时的位置保持；
- 使用 fake app-server 自动验证桌面端 ready、线程读取、导航、搜索、流式回合和失败/中断路径；
- 通过异步、缓存化的工作区身份解析避免在 Electron 主进程同步探测文件系统或 Git；
- 提供中英文界面切换、本地线程命名、工作目录历史分组、分页、搜索、问答目录和虚拟化；
- 为未来的 Electron 桌面客户端积累协议事实。
- 使用主进程历史同步服务从公开 `thread/list` API 构建本地镜像索引；同步会同时尝试未归档和已归档线程，并显示完整、部分或失败状态。同步失败时保留已有镜像，不读取 `CODEX_HOME` 内部数据库或会话文件。
- 工作区分组优先使用本地显式绑定，其次使用 app-server 返回的 `cwd`；路径会规范化并在 Git 仓库中归一到仓库根目录，同时保留线程实际工作目录用于运行。无法确认的线程进入未分类历史。
- 发送前刷新当前线程状态，并对同线程及同一规范化工作区建立本地写入锁；发现活动回合、状态未知或工作区被占用时安全阻止发送。不同客户端之间的并发仍以 app-server 的 active-writer 拒绝为最终边界。
- 当 CLI 可用但尚未确认实际项目目录时，ThreadPath 会使用用户配置目录下的隔离 `history-runtime` 启动目录进入只读历史模式；该目录不会显示为工作区，也不会用于用户会话写入。确认工作目录后才切换到可写工作区模式。
- 官方线程返回的 `cwd` 会在可视化侧栏中自动形成工作区分组；这只是 ThreadPath 的本地整理，只有用户明确确认并由 ThreadPath 以该目录重启 app-server 后，才视为当前可写目录。

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

桌面端的本地质量检查：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

GitHub Actions 使用 Windows、固定的 Node.js/pnpm 版本和 `pnpm install --frozen-lockfile`，运行 fake app-server fixture 的 typecheck、test、build 和桌面端 E2E，并上传日志、失败截图与构建产物。`npm run smoke` 或对应的真实协议冒烟测试仍需在本地运行，因为它依赖 Codex 登录状态和上游网络，不属于 CI 门禁。

桌面端关键路径可运行：

```powershell
pnpm test:e2e
```

该命令通过 `CODEX_EXECUTABLE` 指向仓库内的 fake app-server，不使用真实 Codex 认证、桌面配置或网络模型调用；失败时会在 `artifacts/e2e/` 生成测试日志和截图。

生成 Windows x64 NSIS 安装程序：

```powershell
pnpm package:win
```

安装程序输出为 `release/ThreadPath for Codex Setup 0.1.0.exe`。安装包只包含 ThreadPath 桌面应用，不包含 Codex CLI；应用启动后仍会查找 PATH 中的 `codex`，或使用 `CODEX_EXECUTABLE` 指定的本地可执行文件。当前安装包未启用自动更新和代码签名。

首次启动时，应用会按以下顺序发现 Codex CLI：`CODEX_EXECUTABLE`、已保存的用户选择、系统 PATH 中的 `codex`、`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，最后提供手动选择。每个候选都会通过短超时的 `codex --version` 验证。工作目录由 `CODEX_CWD`、已保存选择或首次启动引导确定；只保存可执行文件路径和工作目录，不保存认证信息或对话内容。高级用户和开发测试仍可使用 `CODEX_EXECUTABLE` 与 `CODEX_CWD` 覆盖自动发现结果。

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
- `M4-D`：Windows x64 NSIS 安装程序配置，可本地生成安装包；当前未启用自动更新和代码签名；
- `v0.0.1`：Codex app-server 协议验证、JSONL/JSON-RPC 传输与可重复故障测试；
- `v0.0.2`：可复用的类型化协议客户端、版本化 fixture 和脱敏诊断事件日志；
- `v0.1.0`：线性对话基础、线程/回合加载、导航和搜索；
- `v0.2.0`：稳定性强化、诊断、性能和无障碍优化；
- `v0.3.0`：Fork 与分支领域模型基础；
- `v0.4.0`：树视图；
- `v0.5.0`：DAG 投影和分支比较；
- `v1.0.0`：稳定桌面版本。

### 项目状态

这是一个可运行的早期桌面原型。协议行为、Codex CLI 版本兼容性、工作区权限边界和桌面应用架构仍在验证中；`pnpm package:win` 可生成本地安装包，但当前不应将其视为稳定发布版本。真实 `pnpm smoke` 仍依赖本机 Codex 安装、认证和上游网络。

## English

ThreadPath for Codex is an independent desktop client prototype designed to make Codex CLI conversations easier to browse, search, navigate, and organize by working directory. It also lays the foundation for future thread forking, tree views, DAG visualization, and branch comparison. The currently runnable code lives in `threadpath-protocol/` and `apps/desktop/`; future architecture described in `SPEC.md` is not automatically implemented.

The project has completed `v0.0.1` protocol validation and the `M0` through `M4-C` desktop milestones, with `M4-D` Windows x64 NSIS packaging configured. The current main branch is a runnable pre-release desktop prototype, not a stable GitHub Release. The Electron main process owns the app-server and conversation service.

### Current capabilities

- Starts `codex app-server` over stdio;
- Communicates using JSONL and JSON-RPC;
- Verifies `initialize`, `thread/list`, `thread/read`, and `thread/turns/list`;
- Verifies `thread/start` and `turn/start`;
- Receives and handles streaming notifications;
- Handles request timeouts, process exits, malformed stdout, server errors, and protocol errors;
- Uses a fake app-server to cover existing/empty thread lists, three terminal turn outcomes, and key failure paths;
- Discovers Codex CLI from `CODEX_EXECUTABLE`, saved choices, PATH, known Windows install locations, or a manual picker, validating each candidate with `codex --version`;
- Provides an `apps/desktop/` M0 secure desktop shell with context isolation and renderer Node integration disabled;
- Lets the Electron main process own app-server connection, initialization, shutdown, and reconnection;
- Uses an isolated `history-runtime` for read-only history mode when no confirmed working directory exists; sending, creating, and continuing turns require a confirmed directory;
- Synchronizes archived and unarchived threads into a ThreadPath-local history mirror and groups them by explicit local binding or the `cwd` returned by Codex, with unclassified history as the safe fallback;
- Creates persistent threads from the selected working directory and stores workspace bindings, expansion state, and local display names in ThreadPath preferences without changing Codex thread data;
- Loads threads and reads selected-thread metadata through typed main-process services;
- Resumes existing threads through the verified `thread/resume` flow before sending; unavailable, non-writable, or externally active threads are blocked with a friendly prompt while preserving the draft;
- Tracks local and external write locks per workspace and thread, allowing multiple locks to coexist and release independently;
- Exposes only restricted thread-list and thread-read APIs through preload;
- Renders user, assistant, system, and tool-status text in turn order with stable turn anchors;
- Normalizes historical and streaming content into phase-tagged blocks; safely renders Markdown for stable history and completed turns while keeping streaming and failed/interrupted text in plain-text fallback;
- Safely renders Markdown for final assistant/system text; user input, streaming text, failed/interrupted content, and tool status remain untrusted plain text or separate status blocks;
- Sends one plain-text turn at a time and applies allowlisted assistant deltas and terminal states;
- Exposes a removable, restricted conversation-update subscription through preload with duplicate and stale-thread filtering;
- Generates a safe turn outline from typed conversation data and supports keyboard/click navigation to stable anchors;
- Computes the active turn from scroll position, highlights its outline entry, and keeps programmatic navigation synchronized;
- Searches the current loaded thread with debounced, case-insensitive substring matching and stable result navigation;
- Loads earlier turns with cursor pagination and stable-ID merging, and virtualizes the conversation list with `react-virtuoso`;
- Runs desktop critical-path E2E coverage against the fake app-server for ready state, thread reading, navigation, search, streaming turns, and failure/interruption paths;
- Resolves workspace identity asynchronously with caching so filesystem and Git probing does not block the Electron main process;
- Provides bilingual UI, local thread names, workspace history grouping, pagination, search, question outline navigation, and conversation virtualization;
- Builds protocol knowledge for the future Electron desktop client.

GitHub Actions runs the same authentication- and network-independent fixture typecheck, test, and build on Windows after a frozen pnpm install. The real `smoke` command remains a local check because it requires Codex authentication and upstream network access.

For the desktop critical-path check, run `pnpm test:e2e`. It builds the desktop app and launches it against the repository's fake app-server through `CODEX_EXECUTABLE`; it does not use Codex authentication, real desktop configuration, or network model calls. The Windows quality workflow runs the same E2E suite and uploads failure logs, screenshots, and build artifacts.

To build the Windows x64 NSIS installer, run `pnpm package:win`. The installer is written to `release/ThreadPath for Codex Setup 0.1.0.exe`. It contains the ThreadPath desktop app only, not the Codex CLI; the installed app still finds `codex` on PATH or uses the executable specified by `CODEX_EXECUTABLE`. Automatic updates and code signing are not enabled yet.

On first launch, the app discovers Codex CLI in this order: `CODEX_EXECUTABLE`, the saved user choice, `codex` on PATH, `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`, and finally a manual file picker. Each candidate is checked with a short-timeout `codex --version` call. The working directory comes from `CODEX_CWD`, the saved choice, or the first-launch guide. Only the executable path and working directory are stored; authentication data and conversation content are never copied into the app configuration. Advanced users and development tests can override discovery with `CODEX_EXECUTABLE` and `CODEX_CWD`.

When no confirmed working directory is available, the app still connects automatically in read-only history mode using an isolated `history-runtime` directory under its own user data. It can synchronize, read, and search official history, but sending, creating, and continuing turns stay disabled until the user confirms a project directory. The runtime directory is not shown in the workspace list.

The desktop app keeps ThreadPath-only preferences in its own user configuration: local thread display names and the selected UI language (`中文` / `English`). These values never call a Codex title-changing RPC and never alter conversation content. Existing threads are resumed with the verified `thread/resume` protocol operation before a new turn; if the thread disappeared, the input remains available while the app asks the user to refresh the list.

When a thread is selected, the compact left sidebar switches from conversation history to that thread's question outline. The history and outline are independently scrollable; returning to history restores its previous scroll position. The conversation pane keeps its title and composer fixed while only the virtualized turn list scrolls.

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
- `M4-D`: Windows x64 NSIS installer configuration; automatic updates and code signing are not enabled;
- `v0.0.1`: Codex app-server protocol validation, JSONL/JSON-RPC transport, and repeatable failure tests;
- `v0.0.2`: reusable typed protocol client APIs, versioned fixtures, and redacted diagnostic event logging;
- `v0.1.0`: linear conversation foundation, thread/turn loading, navigation, and search;
- `v0.2.0`: hardening, diagnostics, performance, and accessibility improvements;
- `v0.3.0`: fork and branch domain-model groundwork;
- `v0.4.0`: tree view;
- `v0.5.0`: DAG projection and branch comparison;
- `v1.0.0`: stable desktop release.

### Project status

This is a runnable early desktop prototype. Protocol behavior, Codex CLI compatibility, workspace permission boundaries, and desktop architecture are still being validated. `pnpm package:win` produces a local installer, but the current build should not be treated as a stable release. Real `pnpm smoke` still requires a local Codex installation, authentication, and upstream network access.

## License

License terms have not been finalized yet.  
许可证尚未最终确定。
