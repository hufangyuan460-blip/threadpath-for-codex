# M6-C4A Resume Usage Execution Report

## Authorization

Approved: **YES**。用户在独立确认请求后回复“我同意”，仅批准 C4A 的 unarchive/resume/archive 各一次；不沿用 C4 较大待审批方案。

真实执行已于 `2026-10-26T08:43:24.702Z—08:43:34.449Z` 完成一次，退出码 0。后续收到的同任务附件明确禁止已执行时重跑，因此只核对旧执行证据、进行本地回放和完成工程回归，没有再次启动真实探针。

| RPC | 预算 | 实际调用 |
| --- | ---: | ---: |
| thread/unarchive | 1 | 1 |
| thread/resume | 1 | 1 |
| thread/archive | 1 | 1 |
| thread/start | 0 | 0 |
| turn/start | 0 | 0 |
| thread/fork | 0 | 0 |
| thread/compact/start | 0 | 0 |

只读调用：thread/list 13、thread/read 9、thread/turns/list 12，另完成 initialize/initialized。模型生成请求 **0**；没有 account/usage/read，也没有额外真实 smoke。

## Preflight

- CLI：`codex-cli 0.163.0-alpha.11`。
- SHA-256：`00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c`。
- App commit：`72c91dedef0c5cd1d5ee465b0c092ccd2851a867`，保留原有未提交增量。
- 执行身份已与本地验收基线核对（已脱敏），Profile 可用；Windows `10.0.19045`、Node `v24.19.0`。
- 首次执行前 Previous C4A execution detected：**NO**；无探针报告、日志或冲突进程。后续核对为 **YES，已完成且不得重跑**。
- Identity Gate：**PASS**。三条专用线程按 cwd、C1 创建时间、C2 ID 摘要和 metadata-only 来源链匹配；C2/C3/C4 报告固定 SHA-256 核对通过。
- 目标固定为 C2 source，而非列表首项。初始 archived 状态、3 回合/6 items 和 full 历史摘要匹配 C2；其他两条测试分支始终保持归档。

## Real RPC Results

| 检查 | 结果 | 真实依据 |
| --- | --- | --- |
| Archived baseline | PASS | source 在 archived、不在 active；full read 与全部页面一致，匹配 C2 指纹 |
| Unarchive | PASS | 一次成功，active 可见、archived 不含目标，身份复核通过 |
| Prepare listener | PASS | unarchive 后、resume 之前注册；已知回合白名单建立，监听就绪是传输前硬门禁 |
| Metadata-only resume | PASS | 一次请求，仅 threadId/excludeTurns:true/sandbox:read-only；返回同一 ID、cwd、空 turns 和 readOnly 回执 |
| Usage notification | PASS | 回执后实际接收 1 条合法、归属于目标已知回合的 thread/tokenUsage/updated |
| Rearchive | PASS | 唯一一次 archive 成功，目标回到 archived、active 不再显示，历史完全一致 |

## Usage Evidence

**REAL_SERVER_OBSERVATION**：1 条；pre-resume 通知 0，非法 payload 0、身份不匹配 0、缓冲溢出 0、意外 turn/started 0、协议警告 0。

- resume 发送前时间：`08:43:26.451Z`。
- 回执通过校验：`08:43:29.315Z`。
- 通知接收：`08:43:29.315Z`，在客户端事件顺序上为 **after-response**；相同毫秒时间戳不用于推测服务端因果。
- 观察窗口截止：`08:43:34.315Z`，回执后 5000 ms。
- threadId 摘要匹配 source；turnId 匹配执行前历史回合集合。报告不保存真实会话正文或原始认证 payload。

| TokenUsageBreakdown | total | last |
| --- | ---: | ---: |
| totalTokens | 61102 | 21463 |
| inputTokens | 60951 | 21406 |
| cachedInputTokens | 52736 | 21120 |
| cacheWriteInputTokens | 0 | 0 |
| outputTokens | 151 | 57 |
| reasoningOutputTokens | 0 | 0 |

`modelContextWindow=475000`。全部字段通过现有严格 parser 的非负安全整数校验，thread/turn 身份合法。

`total` 是累计服务器用量，`last` 是最近服务器快照，window 是模型报告的窗口大小。上述旧历史的快照不是本轮新生成消耗，不用于推导上下文占用率、剩余空间、费用或压缩节省。

真实重复通知：**SKIP**（仅一条）；真实 null window：**SKIP**（本次为 number）。没有执行第二次 resume，不能声称比较过两次真实 resume 的同快照重放，也不能证明快照与此前未保存的 Usage 完全相等。

## Observatory Behavior

- 执行前新建独立内存 Observatory：usage 未知，revision=0，source/receivedAt 均未设置。
- 使用 beginResume 建立 pending；只有回执身份和策略验证通过才 completeResume。
- 回执瞬间无 Usage：revision=0、usage 未知。
- 真实通知到达后 revision=1，source=`resumed`，receivedAt=`2026-10-26T08:43:29.316Z`。
- 窗口关闭时无额外快照，revision 保持 1。receivedAt 是客户端存入观测服务的时刻，与探针回调入口计时相差 1 ms，非服务端计费时间。
- `resumed` 仅是客户端确认恢复接收路径的观察标签，不是服务器承诺的 replay 分类。

## Local Replay

**LOCAL_REPLAY**，执行于 `2026-10-27T00:31:56.683Z`：读取已保存的实际 token 数字，只替换成本地 thread/turn ID；不建立真实传输。

| 检查 | 结果 |
| --- | --- |
| 保存样本经严格 parser 再解析 | PASS |
| 相同快照重复 3 次，revision/receivedAt/状态对象不变 | PASS |
| 不同线程写入独立内存状态，原线程不变 | PASS |
| 本地 pending→confirmed provenance，重复不改 resumed 标签/时间 | PASS |
| 探针排除无关线程，重复快照保持幂等 | PASS |

这些本地重复和恢复信封不是第二次服务器通知，不计作真实重复/新 resume 验证。离线安全测试中的合成输入也与真实观测分开。

## State Restoration

- Archived state restored：**true**，最终列表 active=false、archived=true。
- History digest unchanged：**true**，A/C/D/E 的 ID、3 回合/6 items、item 身份、完整历史指纹均相同且匹配 C2。
- New turns created：**0**；没有 turn/start 请求，也未观察到意外新回合信号。
- 固定 C4A 执行日志仅有一次预留及同一目标 unarchive/resume/archive 各一次记录。已有日志阻止再次写入运行，不删除日志绕过预算。
- 未新增线程、fork、压缩或改变其他分支状态。

## Reports

- 真实报告：`artifacts/m6c4a-resume-usage-d3b15f8e4eee4cc4a66915f3f0c27dac.json`。
- 真实报告 SHA-256：`f221af888b3401544a4bc6532f3f2a0f9464df9aef3eadc5a517aab75b8109ae`。
- 预算日志：`artifacts/m6c4a-resume-usage.mutations.jsonl`。
- 本地回放报告：`artifacts/m6c4a-local-replay-ec0aeaa044ba4a5981a587f0c9a593b3.json`。
- 回放报告 SHA-256：`ccf5524303c68fc892d034fbfb517e70cf65c79e852ed75b28b02fab7ed88107`。

均为独立新文件，旧报告未覆盖；回放中间脚本在会话 scratch。报告独占创建，保留方法/时间/摘要和严格投影的 token 数字，不记录私人正文或认证。

## Tests

以下实际执行全部通过，离线测试不替代上述唯一一次真实探针。设置进程级 `pnpm_config_verify_deps_before_run=false` 复用已安装依赖，未新增依赖或修改锁文件。

| 命令 | 结果 |
| --- | --- |
| `git diff --check`（含收尾新增文件检查） | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test`（含 resume-usage-probe 安全测试） | PASS |
| `pnpm.cmd test:e2e`（全部 8 组 fake-server 桌面 E2E） | PASS |
| `pnpm.cmd build` | PASS |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS |
| 独立探针安全测试、桌面 tsc 与保存样本本地回放 | PASS |

安全测试涵盖双确认/默认只读、错误参数/目标/账户估算接口拒绝、持久预算日志、已有报告禁止覆盖、监听器传输前门禁、响应前缓冲/确认/取消、响应后重复幂等、无事件 NOT_OBSERVED、错误身份/非法 payload 脱敏及恢复失败不能 PASS。全部输入为合成数据，不启动真实 CLI。

回归日志在会话 scratch 的 `m6c4a-{diff-check,typecheck,test,test-e2e,build,protocol-tsc}.log`。收尾 README 多余 EOF 空行已修正并复验差异通过。Git 换行提示和 Node deprecation warning 不作为失败；命令退出码均为 0。未运行其他真实模型 smoke。

## Git Status

本轮新增/增量修改：

- `apps/desktop/scripts/resume-usage-probe.ts`
- `apps/desktop/scripts/resume-usage-probe.test.ts`
- `apps/desktop/package.json`：acceptance:resume-usage 入口，安全测试加入默认 test
- `docs/m6-c4a-resume-usage-report.md`
- `threadpath-protocol/README.md`
- `docs/development-baseline.md`
- `docs/token-usage-observatory.md`

原 C1–C4 工具、报告、知识和未提交改动保留。不改业务代码或新增依赖；未修改 CLI、认证或 Windows 安全设置；未 git add、commit、push、tag 或发布。

## Remaining C4 Gaps

本次关闭单次 metadata-only resume 后合法 Usage 通知、六字段与客户端 resumed 接收路径的实际样本缺口，但 C4 仍不完整：

- fork 前后真实 Usage 与继承关系；本轮没有 fork。
- 实时 contextCompaction item started/completed 关联；本轮没有 compact。
- 实际 null window、真实重复通知，以及多次真实恢复的快照对照均未观察/执行。

本地幂等通过不替代这些服务端样本。不自动动用 C4 较大待授权预算，不新增生成请求弥补缺口。

## Final Result

**RESUME_USAGE: PASS**

**M6_C4: INCOMPLETE**

已停止真实操作，只完成证据分析与工程回归；不继续 Fork、Compact、模型生成、提交或发布。
