# Token Usage 与压缩观测

本轮实现前已完成 `READY_TO_CODE` 核对，范围限于协议 parser、内存观测服务、现有 IPC 与低干扰 UI。采用 `docs/development-baseline.md` 的 INFRA-001、DATA-001、UI-001、SAFE-001；实际桌面实现与旧 AGENTS 阶段说明的差异沿用已有记录。工作区起始无未提交修改。替代方案是将 usage 混入会话消息 reducer；本次使用独立内存服务，避免观测错误影响会话行为。不引入新依赖、数据库或迁移，回退只需撤回本轮代码。

## 数据语义

ThreadPath 当前展示服务器报告的 Token Usage，**不是精确 Context Occupancy**。

- 没有精确 context percentage，也没有 remaining context；模型报告窗口仅为服务器字段，不用于推算剩余空间。
- `total` 是累计消耗，不是当前上下文。`last` 是最近服务器 usage snapshot，不保证等于本回合消耗。六个字段分别展示，不推导合计或分项之间的关系。
- fork 可能继承截至分叉回合的累计值。已知分支使用现有 `sourceThreadId / forkTurnId` 显示继承提示，不算差值、独立消费或跨分支合计。
- 不提供费用、压缩率或节省 token 数。压缩前后即使未来展示也只能称为“观察快照”；本版不做前后关联，事件顺序不足以证明因果关系。

## 流程与生命周期

`AppServerClient.onNotification` → 严格 parser → `ObservatoryService` → `observatory:get / observatory:update` → 当前线程的 Usage 区域。已有 transport 保持不变。IPC 状态携带单调 revision，订阅后读取不会让迟到旧响应覆盖新事件。

每个 Observatory listener 独立隔离同步投递异常，失败后继续通知其余 listener，只记录不含 payload 或异常详情的固定诊断。parser 的异常处理仅包围解析阶段；有效快照不会因 subscriber / IPC 投递失败被标为 invalid-payload。核心 RPC 的错误仍按原路径抛出。

用量通知是绝对快照。同线程新值替换旧值，重复通知不累加，也不刷新相同快照的接收时间。缺失字段、负值、非整数和超出 JS 安全整数范围的值均拒绝；不伪造 0。无效且可归属线程的通知使该线程显示未知及兼容提示，后续有效快照可恢复。未知字段显式丢弃，不进入 IPC。

`live` 表示连接期间收到的普通报告；`resumed` 仅是客户端对成功 resume 接收路径的观察标签，不是服务器声明的 replay 事实，也不证明 last 属于整个回合。`beginResume` 只建立 pending；RPC 返回前最多暂存一份最新绝对快照及其实际接收时间。成功确认后可将暂存快照或随后第一份快照标为 resumed，并消费标记；失败取消时，暂存的有效数据按普通报告处理，相同快照的 source、revision 和 receivedAt 均不变。

发起 `turn/start` 或收到 `turn/started` 后关闭 resume 观察窗口，无法关联的迟到报告保守标为 live；重复快照保持原有来源，不因标记已消费而重新发布。断连、服务关闭、发送流程结束及各失败路径均清除 pending，不为观测新增定时器或持久化。

断连时已有快照标记 stale，重连本身不清除 stale，直到该线程收到新有效报告。快照和压缩记录只在当前进程内存中，重启后 usage 为未知。不解析 rollout，不为了 usage 批量或额外 resume 历史；因此仅浏览已有会话时可能始终无 usage。现有阅读、发送、fork、搜索和归档不依赖 usage。

压缩以线程、回合和 item ID 去重；读取历史、加载更早页和 fork 返回历史均可补充记录。`item/started` 与 `item/completed` 提供可靠生命周期；历史 `contextCompaction` 没有状态，显示未知，不因所属回合结束就推断成功。断连或回合结束而缺少 completed 时，将未完成观察标为未知，不声称 failed。计数是**当前运行已观察项数**，包含历史项与可能继承的项，不是完整历史、成功次数或当前分支独立次数。

正文重读和分页复用 Observatory 中相同 threadId / turnId / itemId 的状态与已有 item merge 规则：弱历史 unknown 不覆盖本进程已观察的 started / completed；纯历史项仍为 unknown。切换路线再返回不丢失这些内存观察，不新增第三套 compaction store。

## 验证范围

以 `artifacts/codex-schema/ts/v2` 的三个 usage schema 和 `ThreadItem.ts` 为字段依据。新 fixture 均为合成数据。专项离线测试覆盖字段校验、null 窗口、替换、重复、resume、重连 stale、多线程隔离、历史压缩与生命周期；桌面 E2E 使用真实 main/preload/renderer 与 fake app-server，覆盖展开明细、整数、来源、压缩标记、分支提示、线程切换、重启、语言和三种主题。

验证日期：2026-10-15；环境：Windows、Node 24。

- `pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`：通过，含原有回归及新增观测用例。
- 协议子包 `npx tsc --noEmit`：通过。
- 协议子包 `npm run smoke`：正常本地环境通过；初始化、读取历史、临时只读回合、流式通知和终态成功，本次确实收到 usage 通知。先前受限环境因无法取得用户主目录而在握手前退出；正常环境经历 Responses WebSocket 重试与 HTTP 回退后成功。这些是本次测试结果，不是跨版本或网络可用性保证。
- 本机 pnpm 的自动依赖检查试图重装已有模块并访问镜像站；验证进程使用 `pnpm_config_verify_deps_before_run=false` 运行现有依赖，未修改依赖或锁文件。没有修改 CLI 配置或认证。

截图在忽略的 `artifacts/e2e/observatory-{graphite,black,light}.png`，仅含合成测试会话。

2026-10-17 局部修复回归（Windows、Node 24）：三个原始复现先写入测试并确认修复前失败，修复后连同边界场景共 16 项专项回归通过。覆盖 listener 隔离与诊断失败、fork 后真实元数据登记、核心 RPC 错误保留、resume 成功/拒绝及响应前通知、断连清理、正文重读/路线切换和完整 compaction identity。`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build` 及协议子包 `npx tsc --noEmit` 通过；E2E 新增切换返回后正文与 Observatory 均保持 completed 的断言。未在本轮重新运行真实模型 smoke，协议文件和产品语义未修改。

## 修改文件

| 范围 | 文件（相对仓库根目录） |
| --- | --- |
| 协议 | `threadpath-protocol/src/token-usage.ts`、`threadpath-protocol/src/token-usage-tests.ts`、`threadpath-protocol/fixtures/token-usage.jsonl`、`threadpath-protocol/src/fake-fork-app-server.ts`、`threadpath-protocol/package.json` |
| 主进程与 IPC | `apps/desktop/src/main/observatory-service.ts`、`apps/desktop/src/main/observatory-service.test.ts`、`apps/desktop/src/main/conversation-service.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/shared/observatory.ts`、`apps/desktop/src/shared/api.ts`、`apps/desktop/src/preload/index.ts` |
| 界面与验收 | `apps/desktop/src/renderer/usage-observatory.tsx`、`apps/desktop/src/renderer/main.tsx`、`apps/desktop/src/renderer/i18n.ts`、`apps/desktop/src/renderer/styles.css`、`apps/desktop/src/shared/conversation-state.ts`、`apps/desktop/src/renderer/conversation-state.test.ts`、`apps/desktop/tests/e2e/observatory.e2e.ts`、`apps/desktop/package.json` |
| 文档 | `README.md`、`threadpath-protocol/README.md`、`threadpath-protocol/fixtures/README.md`、`docs/development-baseline.md`、`docs/token-usage-observatory.md` |

ThreadPath does NOT claim exact context occupancy.

## M6-C4 只读真实证据补充（2026-10-26）

CLI `0.163.0-alpha.11` / SHA-256 `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` 上，三条已确认归档历史的指纹与 C2/C3 一致。真实主分支历史含一个只有 id/type、无 status 的 contextCompaction；所属回合 completed 不改变该项应显示 unknown 的结论。

本轮没有执行 resume、fork、compact、归档或模型生成。没有捕获实时 Usage/item 生命周期通知，既有报告也没有保存对应 payload；不能把旧文档中的 smoke 观察、schema 或合成 fixture 当作本次版本的实时证明。四项真实历史/派生信封的本地回放通过，三项基于真实 Usage 的回放因无样本而 SKIP，均与 REAL_SERVER_OBSERVATION 分开。

当前 `account/usage/read({threadId})` 可以请求单线程估算 ThreadUsage，但其 credits/group totals 不是 ThreadTokenUsage 的 total/last/window。本次三次线程限定请求未提供可用 threadUsage，未回退账户级查询，也不将缺省值填零或推导费用。

现有 Observatory/parser 语义和业务实现未修改；本轮结果为 `M6_C4: NEED_APPROVAL`。完整证据、回归结果及零普通 turn/start 的待授权探针方案见 [C4 报告](m6-c4-real-observatory-acceptance.md)。未获得新的明确授权前，不实施其中任何状态操作或压缩。

## C4A 单次真实恢复通知补证

2026-10-26 的独立 C4A 授权执行中，source 在 metadata-only resume 回执后实际收到 1 条合法 thread/tokenUsage/updated；total/last 六字段与 number window 均通过严格 parser，客户端 source=resumed、revision=1。unarchive/resume/archive 各一次，source 的 3 回合/6 items/正文指纹不变且恢复归档，没有模型生成请求。source=resumed 仍只是客户端观察标签。

只有一条实际通知，真实重复和 null-window 继续 SKIP；随后以保存样本做本地幂等/隔离回放，通过不等于又收到服务器通知。未重新执行探针、fork 或 compact。完整证据见 [C4A 报告](m6-c4a-resume-usage-report.md)。结论 RESUME_USAGE: PASS；fork 用量与实时压缩生命周期等缺口保留，M6_C4: INCOMPLETE。
