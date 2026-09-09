# ThreadPath for Codex

> 面向 Codex CLI 的可视化对话导航与分支工作区。  
> A visual conversation navigation and branching workspace for Codex CLI.

[![Status: Prototype](https://img.shields.io/badge/status-prototype-orange.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)
[![License: TBD](https://img.shields.io/badge/license-TBD-lightgrey.svg)](https://github.com/hufangyuan460-blip/threadpath-for-codex)

## 中文

ThreadPath for Codex 是一个独立的桌面客户端项目，目标是让 Codex CLI 对话更容易浏览、搜索和导航，并为未来的线程 Fork、树视图、DAG 可视化与分支比较提供基础。

项目已完成 `v0.0.1` 协议验证和 `M0` 桌面应用外壳。协议代码集中在 `threadpath-protocol/`，用于验证本地 Codex `app-server` 的通信协议和流式事件行为；`apps/desktop/` 当前只提供安全的 Electron + React 空壳，不连接 app-server。

### 当前能力

- 通过 stdio 启动 `codex app-server`；
- 使用 JSONL 和 JSON-RPC 通信；
- 验证 `initialize`、`thread/list`、`thread/read`、`thread/turns/list`；
- 验证 `thread/start` 和 `turn/start`；
- 接收并处理流式通知；
- 处理请求超时、进程退出、格式错误输出、服务端错误和协议错误；
- 以 fake app-server 覆盖已有/空线程、三种回合终态和关键故障路径；
- 提供 `apps/desktop/` M0 安全桌面外壳，启用 context isolation 并禁用 renderer Node 集成；
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

The project has completed `v0.0.1` protocol validation and `M0` desktop shell setup. The protocol implementation lives in `threadpath-protocol/`; `apps/desktop/` currently provides only a secure Electron + React shell and does not connect to `app-server`.

### Current capabilities

- Starts `codex app-server` over stdio;
- Communicates using JSONL and JSON-RPC;
- Verifies `initialize`, `thread/list`, `thread/read`, and `thread/turns/list`;
- Verifies `thread/start` and `turn/start`;
- Receives and handles streaming notifications;
- Handles request timeouts, process exits, malformed stdout, server errors, and protocol errors;
- Uses a fake app-server to cover existing/empty thread lists, three terminal turn outcomes, and key failure paths;
- Provides an `apps/desktop/` M0 secure desktop shell with context isolation and renderer Node integration disabled;
- Builds protocol knowledge for the future Electron desktop client.

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
