# M6-C3 Real Archive Recovery Report

## Environment

日期：2026-10-26；真实执行窗口：`03:47:42.886Z—03:47:45.425Z`，退出码 0。只执行一次真实恢复闭环，不重试写入。

| 项目 | 实际值 |
| --- | --- |
| CLI version | `codex-cli 0.163.0-alpha.11` |
| CLI SHA-256 | `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` |
| App commit | `72c91dedef0c5cd1d5ee465b0c092ccd2851a867`，保留已有验收基础设施未提交改动 |
| Execution identity | 正常登录用户（已脱敏），Windows Profile 正常 |
| Runtime | Windows `10.0.19045`、Node `v24.19.0` |

执行前没有 C3 报告、执行日志或冲突验收进程。本次重新由当前二进制生成 schema，核对 archive 参数、unarchive 返回结构以及 resume 的 excludeTurns。schema 仅用于确定请求，不替代真实结果。

## Identity Gate

**PASS**

目标明确为上轮 `historical` 测试分支，不按列表首项、标题或时间顺序选取。

1. 校验 C2 成功报告的文件 SHA-256 `96d5579e7287c24f8e70d27f09736fc3a5cbebdefd7c903d0d6591bd2665adad`，确认其 CLI、commit 和完整身份验证通过。
2. 在 `artifacts/m6c-fork-workspace` 范围查询 active/archived 元数据，匹配三条线程的 ID 摘要、创建时间和 C1 成功执行窗口。
3. 活动线程 0、归档线程 3。候选 ID 先与 C2 记录匹配，只允许 metadata-only read；由真实 forkedFromId 重新确认 source → branch → historical 来源链。
4. 选择 historical 角色对应的同一条 ID；其 parent 摘要必须等于 C2 branch 身份。初始 full 历史必须与 C2 的 2 回合/4 items/正文摘要完全一致，才能启用写入。

本次继续遵守 `TIP-20261026-codex-null-fork`：状态数据库列表中的 null 来源不否定 fork，来源链只由 metadata-only read 确认。未选择、修改或读取其他工作区会话正文。

## Real RPC Results

| Step | Operation | Result | 实际断言 |
| --- | --- | --- | --- |
| A | Archived read | PASS | archived 列表包含目标，active 列表不含；read/full 分页与 C2 指纹一致 |
| B | Unarchive | PASS | 一次 RPC 成功、返回相同 ID；active 可见，archived 不再包含目标 |
| C | Active read | PASS | read 与全部 full 页面一致；正文、回合/item 身份和 fork 来源不变 |
| D | Metadata-only resume | PASS | 一次 `thread/resume`，仅传 threadId、excludeTurns:true、sandbox:read-only；返回同一身份及空 turns，sandbox 回执为 readOnly；再次读取正文不变 |
| E | Rearchive | PASS | 一次 archive；目标重新出现在 archived，active 不再显示；read/full 历史仍一致 |

每次状态检查都同时核对其他两个已知测试线程仍归档，没有新线程或目录成员变化。仅允许最多 5 次有界只读可见性轮询，不会重试任何写入 RPC。实际本次状态均正常，无须故障恢复路径。

## History Integrity

| 不变量 | 结果 | 本次证据 |
| --- | --- | --- |
| Thread ID preserved | PASS | A/C/D/E 均匹配 C2 同一 ID 摘要 |
| Turn count preserved | PASS | 始终 2 回合，无新增回合 |
| Item identity preserved | PASS | 始终 4 items，身份集合摘要完全相等 |
| History digest preserved | PASS | A/C/D/E 与 C2 full 页面正文摘要相等 |
| Fork origin preserved | PASS | 始终指向 C2 已确认的 branch 来源 |

正文摘要：`ed031bf0cc7d0df0596c8f224bf984f4e410bd67561f74c222353b8427b231fd`。

item 身份摘要：`4240de3f8ab1822f4f5bcb36bf66045a489e39b7bdc5e9ef73d1914d942d8e74`。

摘要比较包含完整已解析历史；原始服务端 text/content 同时通过既有 parser 投影校验，read 与 full 页面逐回合/item 对照。原始正文、随机标记、认证信息没有进入报告。未发现正文丢失、覆盖、身份或来源变化。

## State Mutations

| 操作 | 实际调用次数 |
| --- | ---: |
| thread/unarchive | 1 |
| thread/resume | 1 |
| thread/archive | 1 |
| turn/start | 0 |
| thread/start / thread/fork / thread/compact/start | 0 |
| 模型生成请求 | 0 |

只读请求计数：thread/list 13、thread/read 9、thread/turns/list 8，另完成 initialize/initialized。没有观察到目标 turn/started 通知，历史回合数不变。stderrBytes=0、protocolWarnings=0。

`originalArchivedStateRestored=true`。闭环结束后未再发起真实线程写入。模型调用为脚本发起生成请求的统计，不把模型列表/元数据查询称作生成。

## Safety Infrastructure

新增独立验收脚本复用 AppServerClient 与 C2 helpers，不修改业务功能：

- 默认只读；需同时提供 `--write`、`--confirm-archive-recovery` 才执行闭环。不接受任意 thread ID、模型覆盖或消息参数。
- 所有 RPC 经白名单与已确认目标检查；unarchive/resume/archive 各有独立的一次预算，在传输前消耗。超时、日志失败也不能自动重放不确定的写入。
- 第一次写入前独占创建固定执行日志，逐次记录方法、时间和目标摘要；已有执行日志时拒绝再次写入运行，不删除日志绕过限制。
- 功能性步骤失败立即停止；仅当目标 active 且 metadata 身份仍可靠时，允许剩余的唯一一次 archive。恢复失败、权限阻碍或历史变化均不能被掩盖成 PASS。
- 只有 A–E 全通过且原始状态恢复后才输出 PASS。只读预检本身不代表闭环通过。

## Reports

全部为新文件，未覆盖旧报告：

- `artifacts/m6c3-archive-39d4579a16704a69a6fc6fc140902b61.json`
- 报告 SHA-256：`f7450dcf95da512f8dc6dd028715cafb338ce214ffeb1eb50de827aa5d636f5d`
- 执行日志：`artifacts/m6c3-archive-recovery.mutations.jsonl`，1 条执行预留、3 条同目标写入尝试，方法各一次。

C1/C2 报告、既有工具、业务协议代码及知识记录共 14 个受保护文件经执行前后 SHA-256 核对均未变化。报告和执行日志位于 Git 忽略目录，不记录原始会话或认证。

## Tests

以下命令均实际通过；离线失败注入与真实协议结果分开，不以 fake server 结果替代上面的真实 A–E 证据。pnpm 仅以进程环境 `pnpm_config_verify_deps_before_run=false` 复用已有依赖，没有安装依赖或修改锁文件。

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test`（含 C2/C3 安全测试） | PASS |
| `pnpm.cmd test:e2e`（全部 8 组桌面 fake-server E2E） | PASS |
| `pnpm.cmd build` | PASS |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS |
| 独立安全测试及桌面直接 tsc | PASS |

新增测试覆盖默认不写入、错误身份/范围拒绝、明确双确认、已有报告与执行日志保护、传输前消耗预算、日志失败/不确定写入不重试，以及 13 个成功和失败生命周期：初始正文不符、预留失败、unarchive 前/后失败、active 正文变化、权限拒绝、sandbox 回执不符、身份丢失、不确定 archive 和意外回合通知等。仅使用本地替身，不启动真实 CLI。

准备阶段发现并修正了一处验收测试的 TypeScript 联合返回类型推断错误：为模拟传输明确标注 `Promise<JsonValue>`，没有改业务代码。修正后编译与全部回归通过。日志在会话 scratch 的 `m6c3-{diff-check,typecheck,test,test-e2e,build,protocol-tsc}.log`。基础 smoke 会调用模型，本轮没有运行。

## Git Status

本轮新增或增量修改：

- `apps/desktop/scripts/real-archive-acceptance.ts`
- `apps/desktop/scripts/real-archive-acceptance.test.ts`
- `apps/desktop/package.json`：增加 acceptance:archive，安全测试接入既有 test
- `threadpath-protocol/README.md`
- `docs/development-baseline.md`
- `docs/m6-c3-real-archive-recovery.md`

既有验收文件、知识记录和未提交改动均保留。未新增依赖，未修改协议客户端、业务服务、Observatory 或 fork 只读策略；没有修改认证、CLI 安装或 Windows 环境。未 git add、commit、push、tag 或发布。

## Remaining Beta.4 Blockers

- 本次版本与单条已确认专用线程的归档恢复门禁已关闭；不推广为全部 CLI/任意用户线程保证。
- Observatory 的真实 Usage payload、fork 用量继承及压缩通知生命周期仍待后续明确授权验收。
- 本轮 metadata-only resume 没有发送消息，不声称本轮重新验证过恢复后的模型生成；不为此扩大授权。
- 全 M6-C 矩阵仍未完成；不进入 M6-C4，不发布 Beta.4。

## Final Result

**M6_C3: PASS**

**M6_C_FULL_MATRIX: INCOMPLETE**
