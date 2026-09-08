# AGENTS.md

本文档仅用于指导 Codex 在本项目中的阅读、修改、运行和验证行为。

## 项目定位

ThreadPath for Codex 是一个面向 Codex CLI `app-server` 的独立桌面客户端。

当前仓库处于原型验证阶段。实际可运行代码位于：

- `codexcli_test/`

根目录中的 `SPEC.md` 描述的是未来完整 Electron 应用的目标架构，不代表当前仓库已经实现了其中的目录和模块。

## 当前原型

`codexcli_test` 是一个 Node.js + TypeScript 原型，用于验证本地 Codex `app-server` 协议。

当前覆盖的协议流程包括：

- `initialize`
- `thread/list`
- `thread/read`
- `thread/turns/list`
- `thread/start`
- `turn/start`
- `turn/completed`
- 流式通知处理
- 请求超时和进程错误处理

运行冒烟测试：

```powershell
cd codexcli_test
npm run smoke
```

默认测试工作目录是：

```text
D:\threadPath
```

如需测试其他项目目录，可设置：

```powershell
$env:CODEX_SMOKE_CWD = "D:\another-project"
npm run smoke
```

## Codex 工作原则

1. 修改前先阅读相关文件，不要假设 `SPEC.md` 中规划的目录已经存在。
2. 优先保持当前原型简单、可运行、可验证。
3. 不要为了实现未来 Electron 架构而提前创建大量空目录或抽象层。
4. 协议方法名、请求字段和事件名必须以实际 Codex `app-server` 行为为准。
5. 不要把协议细节扩散到与协议无关的代码中。
6. 修改协议处理时，同时检查日志、错误处理和测试说明是否需要更新。
7. 保留用户已有的修改，不要覆盖或删除与当前任务无关的内容。
8. 不要提交凭据、token、完整敏感对话内容或本地环境机密。

## TypeScript 约定

- 使用严格 TypeScript。
- 尽量避免新增 `any`。
- 如果协议边界必须使用宽泛类型，应将其集中在边界处，并说明原因。
- 优先使用明确的类型、窄化检查和小型纯函数。
- 保持 Node.js ESM 配置兼容。
- 未确认 Node.js 版本支持情况前，不要引入新的运行时特性。

## app-server 协议约定

- 通过 `codex app-server --stdio` 启动本地服务。
- 使用 JSONL，每行一个 JSON 消息。
- 请求必须具备可追踪的请求 ID。
- 必须处理响应错误、格式错误输出、进程退出和超时。
- 服务端主动发起的请求不能被静默忽略；当前客户端不支持时，应明确返回错误。
- 流式事件处理必须避免重复完成、重复解析或丢失等待中的请求。
- 不要假设每个本地环境都存在已有线程。
- 不要把网络连接超时误判为协议握手失败。

## 修改后的验证

修改 `codexcli_test` 后，至少运行：

```powershell
cd codexcli_test
npm run smoke
```

修改类型或静态结构时，也应运行：

```powershell
npx tsc --noEmit
```

分析失败时，区分以下情况：

- 客户端代码错误；
- Codex CLI 未安装或未认证；
- app-server 启动失败；
- 本地 Responses、WebSocket 或 HTTPS 连接超时；
- 没有可用的已有线程；
- 测试自身的断言失败。

## 文档更新规则

- 修改运行方式、协议覆盖范围或测试结果时，更新 `codexcli_test/README.md`。
- 修改长期架构目标时，更新 `SPEC.md`。
- 修改版本路线或里程碑时，更新 `README-ROADMAP.md`。
- 不要把一次性的本地测试结果写成普遍保证。
- 记录测试日期和环境时，避免写入敏感机器信息。

## 当前阶段的任务边界

除非用户明确要求，优先处理：

- app-server 协议验证；
- 请求、响应和事件处理；
- 错误分类与超时；
- 可重复运行的测试；
- 为未来 Electron 实现积累可靠的协议事实。

除非用户明确要求，不要主动实现：

- 完整 Electron UI；
- Tree View、DAG、分支和合并；
- 持久化数据库；
- 云同步；
- 自动修改 Codex 配置或认证状态。

## 版本管理与提交信息

每次提交必须使用中英文双语描述。提交标题格式为：

```text
<type>(<scope>): 中文描述 / English description
```

示例：

```text
feat(smoke): 完善流式事件验证 / Improve streaming event validation
fix(protocol): 修复请求超时处理 / Fix request timeout handling
docs(agent): 增加 Codex 项目指令 / Add Codex project instructions
refactor(client): 拆分协议客户端层 / Separate protocol client layer
test(smoke): 增加线程读取验证 / Add thread reading verification
```

提交类型使用 Conventional Commits：

- `feat`：新功能；
- `fix`：缺陷修复；
- `refactor`：重构；
- `test`：测试；
- `docs`：文档；
- `chore`：工具、配置或维护；
- `perf`：性能优化；
- `build`：构建或依赖；
- `ci`：CI/CD。

`scope` 应使用具体模块，例如 `smoke`、`protocol`、`client`、`docs`、`agent` 或 `build`。

复杂提交可以在正文中分别提供中文和英文说明；简单提交只需保证标题同时包含中文和英文。不要为了双语要求重复无关内容。

推荐的分支命名：

```text
main
feat/<name>
fix/<name>
refactor/<name>
docs/<name>
```

版本遵循 SemVer：

- `MAJOR`：不兼容的公开行为或协议变更；
- `MINOR`：向后兼容的新功能；
- `PATCH`：向后兼容的缺陷修复。

发布版本使用 `vMAJOR.MINOR.PATCH` 标签，例如 `v0.1.0`。

尽量保持每个提交单一、完整且可验证。文档、协议原型和无关重构应拆分为不同提交。除非用户明确要求，不要在同一个提交中混合不相关的改动。
