# ThreadPath for Codex — 开发规范

**状态：** MVP 实现草案  
**目标版本：** `v0.1.0`  
**仓库：** `threadpath-for-codex`

## 1. 概述

ThreadPath for Codex 是一个基于 Codex CLI `app-server` 构建的独立桌面客户端。它将线性 Codex 对话呈现为可导航的文档：主聊天区域显示完整对话，回合大纲则提供结构、搜索、跳转导航和滚动联动高亮。

MVP 有意先实现稳定的线性基础，同时保留清晰的领域与协议边界，以便未来支持线程 Fork、树视图、图/DAG 可视化以及分支比较/合并。

## 2. 目标与非目标

### 目标

- 启动并监管本地 Codex `app-server` 进程。
- 通过 stdio、JSONL 和 JSON-RPC 进行通信。
- 列出/读取线程和回合，启动线程并启动回合。
- 在易读的对话视图中渲染用户和助手内容。
- 提供支持点击跳转、滚动同步、当前回合高亮和搜索的回合大纲。
- 通过分页和虚拟化，让长对话保持响应流畅。
- 将 Codex 协议 DTO 与应用/领域模型隔离。
- 提供可复现构建、自动化测试、CI 检查和带标签的发布流程。

### MVP 非目标

- 线程 fork、分支创建、树或 DAG 渲染。
- 分支比较、合并、冲突解决或带版本的对话编辑。
- SQLite 或其他持久化应用数据库。
- React Flow 或图布局基础设施。
- 重新实现 Codex 执行、身份验证、模型策略或项目权限。
- 云同步或多设备状态复制。

## 3. 用户故事

1. 作为开发者，我可以打开应用并查看可用的 Codex 线程。
2. 作为开发者，我可以打开线程并按时间顺序阅读其中的回合。
3. 作为开发者，我可以点击大纲项目并跳转到对应回合。
4. 作为开发者，我可以滚动对话，并看到当前大纲项目随之更新。
5. 作为开发者，我可以搜索回合标题和消息文本，并跳转到搜索结果。
6. 当 Codex 不可用或请求失败时，我会收到清晰且可采取行动的错误提示。
7. 作为维护者，我可以在本地和 CI 中运行 lint、类型检查、测试和生产构建。
8. 作为未来的维护者，我可以添加分支，而无需替换线性对话模型。

## 4. 功能需求

### 4.1 应用生命周期

- 启动时验证已配置的 Codex 可执行文件和工作目录。
- 使用 stdio 管道将 `codex app-server` 作为子进程启动。
- 在发起领域请求前完成 JSON-RPC 初始化。
- 检测进程退出、管道断裂、格式错误的协议输出和初始化失败。
- 应用关闭时停止子进程并释放监听器。
- 绝不向 React 组件暴露原始子进程句柄。

### 4.2 线程和回合操作

适配器应支持最小但有用的协议接口：

- `thread/list`
- `thread/read` 或受支持的等价回合读取方法
- `thread/start`
- `turn/start`
- 流式通知/事件处理

具体的方法名和负载取决于协议版本，必须集中在适配器中管理。UI 和领域代码不得包含 RPC 方法字符串。

### 4.3 回合大纲

每个大纲项目必须包含稳定的回合 ID、显示序号、简洁标签和导航目标。要求的行为如下：

- 点击项目 → 滚动到回合；
- 滚动对话 → 更新当前大纲项目；
- 当前项目始终在大纲中可见；
- 搜索可筛选或排序匹配的回合；
- 键盘聚焦并按 Enter 可激活结果；
- 目标缺失或被移除时应优雅失败，不得导致视图崩溃。

### 4.4 对话渲染

- 按时间顺序渲染回合。
- 使用带类型的项目种类渲染用户、助手、系统以及工具/状态项目。
- 保留流式更新，且不得重复项目。
- 显示加载、空、部分加载和错误状态。
- 增量渲染期间保持回合锚点稳定。

## 5. 非功能需求

- **响应性：** 大纲交互应即时可感知；本地导航状态变化目标小于 100 ms。
- **启动：** 快速显示应用外壳和 Codex 连接状态；在参考机器上可用外壳目标小于 3 秒。
- **可靠性：** app-server 停止后，通过明确的重新连接操作恢复。
- **可扩展性：** 已加载会话至少支持 10,000 个回合，且不一次性渲染所有 DOM 节点。
- **无障碍：** 支持键盘导航、可见焦点、语义标签、可读对比度和减少动画。
- **可观测性：** 使用带关联/请求 ID 和脱敏功能的结构化本地日志。
- **可移植性：** 优先支持 Windows；领域/核心包避免平台特定假设。
- **可维护性：** 使用严格 TypeScript、明确的模块边界，并将协议 fixture 纳入测试。

## 6. 技术选型

| 领域 | 选择 | 约束 |
|---|---|---|
| 桌面外壳 | Electron | 启用 main/preload/renderer 隔离 |
| UI | React + TypeScript | renderer 中不得直接访问 Node |
| 构建 | Vite | 按需分别构建 main、preload、renderer |
| 包管理器 | pnpm workspace | 共享脚本和依赖锁文件 |
| 状态 | Zustand | UI 状态与领域/应用服务分离 |
| 长列表 | react-virtuoso | 稳定的项目 key，并支持滚动到索引 |
| 后端 | Codex CLI `app-server` | 作为本地子进程管理 |
| 协议 | stdio + JSONL JSON-RPC | 使用单一传输/解析实现 |
| MVP 排除项 | SQLite、React Flow | 仅在有文档化需求时重新评估 |

## 7. 总体架构

```text
Electron 主进程
  └─ CodexProcessManager
      └─ JsonlJsonRpcTransport
          └─ CodexClient
              └─ CodexAdapter
                  └─ 对话应用服务
                      └─ Preload IPC API
                          └─ Zustand Stores
                              └─ React UI
```

数据通过命令向下流动，并通过带类型的结果/事件向上返回。renderer 接收范围受限且经过验证的 preload API；它不能调用任意 IPC 通道或创建进程。

## 8. 模块边界

- `packages/domain`：与框架无关的实体、值对象、命令、事件和不变量。
- `packages/protocol`：JSON-RPC 信封、Codex DTO、运行时验证和协议 fixture。
- `packages/transport`：与进程无关的 JSONL 分帧、请求关联、超时、取消和通知路由。
- `packages/codex-client`：协议方法和流处理；不得导入 React/Zustand。
- `packages/codex-adapter`：将 Codex DTO/事件映射为领域模型和应用事件。
- `packages/application`：列表、打开、搜索、加载更多、启动回合等用例。
- `apps/desktop/main`：进程生命周期和特权 OS 集成。
- `apps/desktop/preload`：带类型且有白名单限制的 IPC 桥接。
- `apps/desktop/renderer`：React 视图、Zustand store、大纲、对话和搜索 UI。
- `tests/fixtures`：带版本管理的 JSONL 请求/响应/通知 fixture。

依赖方向必须指向领域层。领域层不得依赖 Electron、React、Zustand 或 Codex DTO。

## 9. 领域模型

```ts
type ThreadId = string;
type TurnId = string;

interface ConversationThread {
  id: ThreadId;
  title: string;
  status: 'active' | 'completed' | 'failed' | 'unknown';
  turns: ConversationTurn[];
  parentThreadId?: ThreadId; // 为 fork/tree 预留
  forkTurnId?: TurnId;       // 为 fork/tree 预留
}

interface ConversationTurn {
  id: TurnId;
  threadId: ThreadId;
  index: number;
  createdAt?: string;
  userMessage?: string;
  items: ConversationItem[];
  parentTurnId?: TurnId;     // 为分支预留
  branchId?: string;         // 为分支预留
}

type ConversationItem =
  | { kind: 'text'; id: string; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'completed' | 'failed'; summary?: string }
  | { kind: 'status'; id: string; text: string };
```

ID 是不透明且稳定的。数组顺序仅表示展示顺序；未来的图关系必须使用显式 ID，而不能使用数组位置。

## 10. Codex 适配器与客户端分层

1. **进程管理器：** 启停可执行文件、管理 stdio，并报告生命周期事件。
2. **传输层：** 对 JSONL 行分帧、解析 JSON、关联请求 ID、路由通知并执行超时控制。
3. **CodexClient：** 暴露带类型的协议操作，并映射原始协议事件。
4. **CodexAdapter：** 将协议 DTO 转换为领域实体和应用事件，并处理协议版本差异。
5. **应用服务：** 编排加载、搜索索引、选择、流式聚合和重试策略。
6. **UI store/视图：** 只消费带类型的应用状态和命令。

## 11. 事件流

```text
User action
 → renderer command
 → preload allowlisted IPC
 → main application service
 → adapter/client
 → JSON-RPC request over stdio
 → response/notification
 → adapter domain event
 → store update
 → virtualized view + outline update
```

每个请求都会获得一个关联 ID。流式事件在有事件/项目 ID 时使用幂等方式应用；否则由适配器维护每个回合的累加器，并发出不可变快照。

## 12. 长会话、分页和虚拟化

- 先加载线程元数据，再按页加载回合。
- app-server 提供游标分页时使用游标分页；否则使用确定性的分页边界，并记录降级方案。
- 使用线程 ID、回合 ID 和项目 ID 作为键维护规范化 store。
- 将有序回合 ID 列表与回合实体分开维护。
- 使用 `react-virtuoso` 渲染对话回合；使用基于回合 ID 的稳定 key。
- 根据已加载的元数据/文本构建大纲项目；搜索可以逐步包含尚未加载的页面。
- 对搜索输入进行防抖，并取消过时的搜索。
- 在前置较早页面时保持滚动位置。
- 为已加载内容设定并记录内存预算；不得静默丢弃用户可见数据。

## 13. 错误处理和日志

错误必须按类型归入以下类别：配置、进程、传输、协议、超时、取消、映射以及渲染/应用。用户提示应说明发生了什么以及下一步操作；原始 stderr 和负载应写入日志，而不是默认显示在 UI 中。

日志要求：

- 使用结构化 JSON 或等价的键值记录；
- 级别：debug、info、warn、error；
- 在可用时记录关联 ID、线程 ID 和回合 ID；
- 默认对 token、凭据、环境机密和敏感消息内容进行脱敏；
- 日志目录和保留策略可配置；
- 除非明确启用本地调试，否则绝不记录完整的 JSON-RPC 负载。

## 14. 配置

配置保存在本地，并在启动时验证：

- Codex 可执行文件路径或发现模式；
- 默认工作目录；
- 请求超时时间；
- 日志级别和诊断日志开关；
- 页面大小和 UI 偏好。

使用带版本的配置和安全默认值。无效配置必须提供字段级指导。不得将机密存储在本应用的配置中；应依赖 Codex 现有的身份验证/会话机制。

## 15. 安全边界

- renderer 中设置 `contextIsolation: true`，在兼容时启用 sandbox，并设置 `nodeIntegration: false`。
- 只暴露明确的 preload 方法；验证所有 IPC 输入。
- 对 IPC 通道名称使用白名单，并拒绝未知通道。
- 将 Codex 输出和工具输出视为不可信文本；对渲染内容进行转义，并限制链接/操作。
- 不得将返回文本作为代码或 HTML 执行。
- 将子进程调用限制为已配置的可执行文件和预期参数。
- 不得将对话内容发送到外部服务。

## 16. 测试策略

### 单元测试

测试领域不变量、DTO 到领域的映射、大纲提取、当前回合计算、搜索排序/筛选、分页合并、流聚合、错误分类、脱敏和配置验证。

**通过标准：** 所有测试通过；领域/应用包的分支覆盖率 ≥80%；测试运行期间不得出现未处理的 promise rejection。

### 集成测试

通过 stdin/stdout 使用 fake app-server，测试初始化、请求关联、通知顺序、格式错误的行、进程退出、超时、取消、重新连接、分页和流式回合更新。

**通过标准：** 由 fixture 驱动的运行结果确定；覆盖所有支持的协议流程和失败类别。

### 契约测试

为每个支持的方法和事件保留有代表性的 JSONL JSON-RPC fixture。验证请求结构、响应解析、通知映射、对未知字段的容忍度以及必填字段缺失时的失败行为。

**通过标准：** fixture 能通过 schema/类型验证；协议变更会让 CI 失败，并提供可采取行动的差异信息。

### E2E 测试

使用 fake app-server 启动已打包的桌面应用，并验证：启动、线程选择、回合渲染、大纲点击导航、滚动高亮、搜索导航、加载/错误/空状态、重新连接和优雅关闭。

**通过标准：** 关键路径在受支持的 Windows CI runner 上通过；不得使用不稳定的重试来掩盖失败。

### 性能测试

生成至少包含 10,000 个回合且项目大小符合实际的 fixture。测量应用外壳启动、初始加载、追加页面、搜索延迟、大纲导航、内存和滚动流畅度。

**通过标准：** 不渲染完整列表 DOM；本地大纲导航 p95 <100 ms；防抖后搜索 p95 <300 ms；重复加载页面期间不得出现持续且无界的内存增长。

### 回归测试

每个已修复缺陷都要添加最小复现 fixture/测试。适配器重构时保留协议 fixture，并在每次发布前运行完整关键路径套件。

## 17. CI/CD 与发布流水线

CI 必须在 pull request 和受保护分支上运行：

1. 使用冻结的 pnpm lockfile 安装；
2. 格式检查；
3. lint；
4. 类型检查；
5. 单元、集成、契约和 E2E 测试；
6. 性能冒烟测试；
7. 生产构建/打包；
8. 上传测试报告和构建产物。

发布流程由标签驱动：在具备签名凭据时构建已签名产物，根据 Conventional Commits 生成发布说明，发布校验和，并创建 GitHub Release。main 必须始终保持可发布状态；发布任务不得从未经审查的功能分支运行。

## 18. 版本管理

### 提交

使用 Conventional Commits：

```text
feat: add turn outline navigation
fix: recover after app-server exit
refactor: isolate codex dto mapping
test: cover pagination merge
docs: update tree migration constraints
```

在可行的情况下保持提交内聚且可构建。不得在一个提交中混合 UI、协议和无关的重构。

### 分支与审查

- `main`：受保护、可发布。
- `feat/<name>`：新功能。
- `fix/<name>`：缺陷修复。
- `refactor/<name>`：结构性变更。
- `docs/<name>`：仅文档变更。

共享工作使用 pull request、必需的 CI 和至少一次审查。按照仓库策略进行 squash 或 merge，同时保留有意义的发布历史。

### SemVer 与里程碑

- `v0.1.0`：引导、线性线程视图、大纲、搜索和导航。
- `v0.2.0`：稳定性强化、更丰富的搜索以及改进的诊断/性能。
- `v0.3.0`：线程 fork 领域/API 基础。
- `v0.4.0`：树视图。
- `v0.5.0`：图/DAG 和分支比较基础。
- `v1.0.0`：稳定且受支持的桌面版本。

补丁版本修复回归问题；次版本增加向后兼容的能力；主版本可以改变公开行为或存储/协议契约。每次发布都要打标签（`vMAJOR.MINOR.PATCH`），并为任何领域或协议变更记录迁移说明。

## 19. 代码规范

- 使用严格 TypeScript；除经过验证的协议边界外，避免使用 `any`。
- 优先使用不可变更新和纯映射函数。
- 为公开 API 使用明确的返回类型。
- 让 React 组件专注于渲染和交互。
- 使用命名的领域/应用错误，不使用字符串匹配。
- 新行为必须有测试，每个 bug 修复必须有回归测试。
- 在 CI 中执行格式化和 lint；受保护构建不接受警告。
- 在适配器附近记录协议假设和兼容性决策。

## 20. 建议的仓库结构

```text
.
├─ apps/
│  └─ desktop/
│     ├─ src/main/
│     ├─ src/preload/
│     └─ src/renderer/
├─ packages/
│  ├─ domain/
│  ├─ protocol/
│  ├─ transport/
│  ├─ codex-client/
│  ├─ codex-adapter/
│  └─ application/
├─ tests/
│  ├─ fixtures/
│  ├─ integration/
│  ├─ contract/
│  ├─ e2e/
│  └─ performance/
├─ .github/workflows/
├─ package.json
├─ pnpm-workspace.yaml
├─ pnpm-lock.yaml
├─ README.md
└─ SPEC.md
```

## 21. 里程碑与交付物

### M0 — 引导

工作区、Electron 外壳、Vite、React、TypeScript、lint/格式化/测试脚本、CI 骨架以及 app-server 进程冒烟测试。

### M1 — 协议与适配器

JSONL 传输、JSON-RPC 关联、初始化、带类型的 Codex 客户端、适配器映射、fixture 和失败处理。

### M2 — 线性对话

线程列表/读取、领域 store、对话渲染、流式更新以及空/加载/错误状态。

### M3 — 大纲与导航

大纲、稳定锚点、点击跳转、滚动联动高亮、键盘访问和搜索。

### M4 — 稳定性强化与发布

分页、虚拟化、性能测试、E2E 套件、安全审查、打包、发布清单和 `v0.1.0` 标签。

## 22. 完成定义

满足以下条件时，一项变更才算完成：

- 验收行为已实现并记录；
- 领域/协议/UI 边界保持完整；
- 已添加或更新单元测试及相关的集成/契约/E2E 测试；
- 已修复缺陷具备回归覆盖；
- lint、类型检查、测试、性能冒烟测试和生产构建均通过；
- 日志和错误可采取行动且已脱敏；
- 已验证受影响 UI 的无障碍和键盘行为；
- 在适用时更新文档、变更日志和迁移说明；
- pull request 已审查且 CI 为绿色。

## 23. 风险与缓解措施

| 风险 | 缓解措施 |
|---|---|
| app-server 协议变更 | 隔离 DTO、fixture 和适配器兼容性，并使用契约测试 |
| 进程挂起或退出 | 使用超时、生命周期事件、重新连接和有界缓冲 |
| 超大规模会话导致 UI 降级 | 使用游标分页、规范化状态、虚拟化和性能门禁 |
| 流式内容重复或乱序 | 使用稳定 ID、幂等 reducer 和事件顺序测试 |
| Electron 特权暴露 | 使用 preload 白名单、隔离和验证；禁止 renderer 访问 Node |
| 意外记录敏感信息 | 默认脱敏，负载日志采用显式启用 |
| 树迁移变成重写 | 现在就使用显式的 parent/fork/branch 字段和基于 ID 的关系 |
| 发布回归 | 使用受保护的 main、标签驱动的 CI、已打包的 E2E 和发布清单 |

## 24. 未来树/DAG 升级约束

- 一个线程是对话图中的一个节点；一个回合是具有稳定身份、可寻址的事件/节点。
- 即使暂未使用，也要保留 `parentThreadId`、`forkTurnId`、`parentTurnId` 和 `branchId` 的语义。
- 绝不能仅根据数组顺序或显示序号推断祖先关系。
- 将线性展示视为领域图的一种投影，而不是领域本身。
- 将分支操作建模为应用命令/事件，而不是 UI 变更。
- 为替代投影设计 selector：线性路径、树、DAG、比较和合并预览。
- 将合并保留为具备冲突表示的明确未来能力；不得静默覆盖回合。
- 避免向领域或传输包引入特定于图的依赖。
- 将对 fork/branch 操作的协议支持视为带能力检测的适配器扩展。

## 25. MVP 验收清单

- [ ] 应用启动并报告 Codex 可用性。
- [ ] 在线程列表和线程读取方面，fake server 与真实本地 app-server 均可正常工作。
- [ ] 回合按顺序渲染，并具有稳定锚点。
- [ ] 大纲点击、滚动高亮和键盘导航正常工作。
- [ ] 搜索可以找到已加载以及逐步加载的回合。
- [ ] 已覆盖流式、超时、格式错误响应、进程退出和重新连接状态。
- [ ] 10,000 回合性能 fixture 达到阈值。
- [ ] 安全和脱敏检查通过。
- [ ] CI 为绿色，且打包产物可复现。
- [ ] `v0.1.0` 发布说明和标签已准备就绪。
