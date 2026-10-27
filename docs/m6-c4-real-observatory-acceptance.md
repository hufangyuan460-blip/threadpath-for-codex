# M6-C4 Real Observatory Acceptance

## Environment

日期：2026-10-26；采集报告时间 `2026-10-26T06:27:39.844Z`。

| 项目 | 实际值 |
| --- | --- |
| CLI version | `codex-cli 0.163.0-alpha.11` |
| SHA-256 | `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` |
| App commit | `72c91dedef0c5cd1d5ee465b0c092ccd2851a867`，保留既有未提交验收增量 |
| Execution identity | 已与本地验收基线核对（已脱敏）；Profile 正常 |
| Runtime | Windows `10.0.19045`，Node `v24.19.0` |
| 执行前冲突进程 | 0 |

本次由同一二进制重新生成 schema，核对 Usage 六字段、nullable window、通知方法及 item 生命周期时间字段。schema 声明不是实时通知证据。

身份门禁通过：专用 `artifacts/m6c-fork-workspace`、C1 创建窗口、C2 的三条 ID 摘要与 metadata-only 来源链全部匹配；C3 报告确认原始归档状态已恢复。三条 full 历史仍为 3/5/2 回合，正文指纹与 C2 一致。只读采集结束再次核对 active=0、archived=3，没有修改它们。

## Existing Evidence

| 证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| C1 fork 报告 | 真实 fork、resume、手动压缩操作及上下文检查成功 | 没有保存 Usage payload 或 item/started、item/completed，不能重建实时生命周期 |
| C2 最终报告 | 身份、历史 full/summary/notLoaded、分页及压缩历史成员 | 历史 item 不携带实时 started/completed 事实；没有保存 Usage 快照 |
| C3 最终报告 | metadata-only resume 与归档恢复闭环、正文不变 | 不统计/保存 Usage 通知，不能推断 resume 是否重发过快照 |
| 本轮真实读取 | 一个实际 contextCompaction 历史 item、字段结构、parser 完整性与不变的历史指纹 | 不是新的压缩生命周期或新的模型 Usage |
| 当前生成 schema | 请求/通知字段依据 | 不计作真实 RPC 或通知通过 |

审查当前 C1/C2/C3 及旧 fork/archive 的六份脱敏报告，均没有 Usage payload/实时 item 方法记录；旧版本文档、合成 JSONL、fake server 和 E2E 截图不作为本次二进制的实时证据。报告没有保存某事件，并不等于该事件当时没有发生。

## Real Protocol Results

| Capability | Status | Evidence |
| --- | --- | --- |
| Token Usage notification | BLOCKED | 本轮有界只读窗口接收 0 个已确认线程的合法 Usage 通知，旧报告没有可复用 payload；不为此触发活动 |
| total / last / window | BLOCKED | 没有真实 payload；仅 schema 和离线严格 parser 测试不能满足本项 |
| Resume snapshot | BLOCKED | 本轮明确禁止 resume；C3 未保存重放样本 |
| Fork usage inheritance | BLOCKED | 无可信 fork 前后 Usage 快照，不用 total 相等或增长猜测独立消耗 |
| Compaction item history | PASS | 主分支 full 历史实际返回 1 项 contextCompaction，ID/type 经 parser 保留；其他线程无该历史项 |
| Compaction live lifecycle | BLOCKED | 没有本轮真实 item/started 和 item/completed 配对；C1 的压缩操作通过不能代替 item 生命周期 |
| Null context window | SKIP | 没有实际 null Usage 样本；不把未提供 Usage 或 null 线程估算当作 null window |
| Duplicate notification | SKIP | 未观察到真实重复通知，不制造服务器事件填补结果 |

真实压缩历史 item 的已知字段为 `id/type`，没有 status；所属 turn 虽为 completed，仍不能推断 item completed。报告只保留 thread/turn/item 的 SHA-256，不保存会话正文。

### 单线程估算元数据

当前 schema 还有 `account/usage/read({threadId})`，明确支持以线程估算替代账户级活动；返回类型是 ThreadUsage（估算 credits、分组 token 字段），不是 ThreadTokenUsage（total/last/window）。

本轮仅对已确认的三个测试 ID 各调用一次，均未提供可用 threadUsage 数据，分别记 SKIP。没有省略 threadId 回退到账户查询，没有记录账户 summary、金额或推导费用。这个接口即使返回估算，也不能冒充 Usage notification 或精确回合账单。

本轮实际 RPC：thread/list 6、thread/read 6、thread/turns/list 10、严格单线程 account/usage/read 3，另完成 initialize/initialized。监听器安装于读取之前，读完后额外等待 500 ms；这只是有界观测，不是对通知缺失的服务端故障断言。

Usage 通知 0、实时压缩通知 0、非法通知 0、缓冲溢出 0、范围外历史事件 0；stderrBytes=0、protocolWarnings=0。状态修改 RPC=0、模型生成请求=0。本轮没有 resume、unarchive、fork、compact 或 archive，也没有重跑 C1 smoke。

## Local Replay

所有下列结果单独标记为 **LOCAL_REPLAY**，不算实时通知 PASS：

| 检查 | 结果 | 输入来源与结论 |
| --- | --- | --- |
| 历史重复、逆序重读 | PASS | 实际 full 历史回放；同一 thread/turn/item 不重复、revision 不变，历史状态保持 unknown，不伪造 Usage=0 |
| 历史线程隔离 | PASS | 实际三条历史；只有拥有该项的主分支含压缩记录，共享回合不混淆线程 |
| completed 不被历史 unknown、重复 completed、迟到 started 降级 | PASS | **以真实历史 ID/item 构造的本地生命周期信封与合成时间戳**；不是抓取的实时生命周期 |
| completed-before-start、缺 completed 时断连 | PASS | 同上，局部故障调度；completed 保持、未完成观察变 unknown，不猜 failed/成功/节省量 |
| Usage 重复、revision/receivedAt | SKIP | 没有实际 Usage payload，不能把合成样本冒充本项输入 |
| source=resumed 客户端标签 | SKIP | 同上；真实 resume 本轮未执行 |
| null/未知/缺失字段的 Usage 变体 | SKIP | 同上；现有纯离线 fixture 测试另列 |

本地生成的事件只投给独立 ObservatoryService，不进入真实通知采集器，真实计数仍为 0。没有用已结束父回合把历史压缩项标为 completed。

既有工程测试和代码语义仍坚持：total 为累计服务器用量，last 为最近快照，window 为模型报告窗口。重复快照是绝对替换，不累加；resumed 是客户端成功恢复接收路径的标签，不是服务器承诺。合法的 stale/provenance 状态变化与未变化快照的重复需分别判断，不将 revision 变化解释为新消费。不得推算上下文占用、剩余量、百分比、精确回合计费或压缩节省量。

## Compatibility Findings

本轮没有复现协议/业务 parser 不兼容。实际历史项与既有安全降级逻辑一致；实时证据不足是授权和已保存数据范围的缺口，不是产品失败。

实际发现的接口差异是线程估算 API 与 Usage 通知类型不同，且本次三个线程没有可用估算；未把空/缺省估算填成零，也没有将其替代 total/last/window 通知。

## Reports

- 新报告：`artifacts/m6c4-observatory-d93f57eab4f242e2a146a4774273878c.json`。
- SHA-256：`ef87535f2bab7d6d5a7f033a5487d00df9535620b7d2c6e252a7f765986f0af6`。
- 新报告独占创建，没有覆盖旧报告。当前 24 个受保护业务文件、既有工具、知识记录、C1/C2/C3 报告及 C3 执行日志经 SHA-256 核对未变。

## Tests

以下命令实际通过，均为离线工程结果，不能替代上述 REAL_SERVER_OBSERVATION 证据。使用进程级 `pnpm_config_verify_deps_before_run=false` 复用现有依赖；未安装依赖或修改锁文件。

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test`（含 C2/C3/C4 安全测试） | PASS |
| `pnpm.cmd test:e2e`（完整 8 组桌面 fake-server E2E） | PASS |
| `pnpm.cmd build` | PASS |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS |
| 新安全测试独立运行、桌面直接 tsc | PASS |

安全测试覆盖所有活动 RPC 拒绝、候选不能读正文、禁止账户级空参数/未确认线程估算查询、无写入参数、报告独占、无样本不判 PASS、通知范围与容量限制、未知字段脱敏、严格 parser/异常降级、真实/本地计数隔离。测试中的 Usage/lifecycle 输入全部是合成数据，明确不充作本轮真实样本。

日志位于会话 scratch 的 `m6c4-{diff-check,typecheck,test,test-e2e,build,protocol-tsc}.log`。未运行真实模型 smoke，没有将离线 resume/fork/压缩替身当成真实状态操作。

## Git Status

本轮新增/增量修改：

- `apps/desktop/scripts/real-observatory-acceptance.ts`
- `apps/desktop/scripts/real-observatory-acceptance.test.ts`
- `apps/desktop/package.json`：新增 acceptance:observatory，并将安全测试接入默认 test
- `docs/m6-c4-real-observatory-acceptance.md`
- `docs/token-usage-observatory.md`
- `threadpath-protocol/README.md`
- `docs/development-baseline.md`

保留所有原有未提交验收工具、测试、知识和历史报告；没有新增依赖、改写业务功能、修改认证/Windows 环境或执行 git add、commit、push、tag、Release。

## Remaining Gaps

仅剩尚未由真实样本验证的能力：

1. Usage 通知的 thread/turn 身份、total/last 六字段及 modelContextWindow。
2. 实际 null window、真实重复/重放、resume 前后同快照及客户端接收时序。
3. fork 前后服务器 Usage 报告与不同线程的真实用量隔离。
4. 实时 contextCompaction started/completed 的完整 thread/turn/item 关联。

历史压缩项及其本地安全处理已经覆盖，但不关闭这些实时门禁。

## Minimum Approval Request

**以下仅为待授权方案，本轮未实现或执行活动路径。当前只读入口没有写入开关。**

优先以零普通回合探测，减少模型额度：复用 C2 已确认的 **source（3 回合）** 作为只读历史来源，仅在它的归档状态临时恢复后观察 resume 是否提供 Usage；新压缩只作用于新 fork，不改 source 正文或现有两条分支。

### 明确预算上限

| 操作 | 最多次数 | 对象 |
| --- | ---: | --- |
| thread/start | 0 | 不新建源线程 |
| turn/start / 发送用户消息 | 0 | **本申请不授权普通生成回合** |
| thread/unarchive | 1 | 仅 C2 source |
| metadata-only thread/resume | 3 | source 最多 2 次，用于首次快照与重放对照；新 fork 最多 1 次 |
| thread/fork | 1 | 仅从 source 最后已结束回合分出新专用分支 |
| thread/compact/start | 1 | 仅新 fork；可能产生模型额度消耗 |
| thread/archive | 2 | source 恢复原归档状态、新 fork 归档，各最多一次 |
| 新线程数 | 最多 1 | 由上述 fork 创建 |

### 执行顺序与停止条件

1. 再次固定 CLI 版本/摘要、源码、C2/C3 身份与 source 正文指纹，检查无旧活动执行日志和冲突进程。监听器先于请求安装。
2. unarchive source 一次，metadata-only resume 一次，不发消息。**若有界等待内无合法 Usage，立即停止后续活动，安全归档 source 并报告缺口；不 fork、不 compact，更不追加 turn/start。**
3. 只有已有合法 source 快照时，才进行预算内的第二次 source resume（可按既有连接生命周期重连），对照快照数值和身份，单独记录 stale/provenance 变化。没有再次通知则保留重放缺口，不额外 resume。
4. fork 一次，lastTurnId 为已核对的最后结束回合，明确采用包含式截断；为新 fork 设置新的 `artifacts/m6c4-live-<nonce>` 专用 cwd 和既有 read-only 策略。校验返回新 ID、来源与运行窗口，再认领通知。
5. 新 fork metadata-only resume 一次，尽可能捕获新分支在任何压缩前的累计快照。缺失则不能根据之后 total 的变化猜测继承。
6. 对新 fork 发起一次 compact，捕获真正的 item/started、item/completed（含 startedAtMs/completedAtMs）及 turn/started、turn/completed，并与同 thread/turn/item 的 Usage 报告关联。派生回放与实时事件继续分栏。
7. 验证 source 正文保持 C2 指纹，两个原有分支不变；在身份可靠且状态允许时，source 与新 fork 各归档一次。source 回到原始 archived 状态，保留新分支和脱敏证据，不删除数据。

### 证据与异常策略

- 严格捕获 `thread/tokenUsage/updated` 的真实六字段、last、window、线程/回合摘要与到达顺序；source/resumed 仅按客户端 pending/确认窗口标记。
- fork 前后只陈述实际服务器快照与血缘，不计算独立消耗、费用、上下文百分比或节省量。
- 原始事件的敏感正文/认证不落盘；只存严格投影的用量数字、已知生命周期字段、身份摘要、请求结果和预算日志。通知在 RPC 返回前到达时，只暂存有界的脱敏相关字段，返回身份确认后才能认领。
- 所有写入在传输前消耗一次预算并持久记录；超时/结果不确定不能自动重放。失败即停止功能性写入，仅在剩余预算且所有权/状态可靠时执行归档恢复。busy、身份不明或恢复失败须保留当前状态报告，不猜测对象、不额外中断、不创建替代线程。
- 真实重复、null 或继承快照不保证自然出现，缺项继续 SKIP/BLOCKED，不扩充普通回合或重复 compact。若零普通回合方案取不到 Usage，后续是否新增合成回合必须另行申请，不在本预算内。
- 费用不可可靠估算：没有普通 turn/start，但手动 compact 可能调用模型并发生 CLI 内部传输重试。这里限制的是客户端 RPC 次数，不承诺供应商物理请求数或费用上限。

这会临时改变 source 的归档/激活状态，但不会向它追加正文；相较重新创建源线程并生成种子回合，可避免一个普通模型回合。若未经新授权，不实施上述任何状态操作或压缩。

**NEED_APPROVAL_FOR_LIVE_OBSERVATORY**

## Final Result

**M6_C4: NEED_APPROVAL**

**M6_C_FULL_MATRIX: INCOMPLETE**

当前授权内的只读检查已完成；停止，等待单独的活动验收授权。不提交、不推送、不发布，也不自动进入下一阶段。
