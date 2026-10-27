# M6 Final Safety Fix Report

## Root Cause

修复前 `real-acceptance.ts` 的 fork 写模式只有参数双确认与执行后的报告时间检查，没有跨进程持久预留。重复或并发运行相同命令会再次启动完整 fork smoke；失败/超时不能证明服务器没有执行，因此不能作为自动重跑依据。

固定子报告以及可选总报告原来通过路径直接写入，可能截断已有证据。主代理此前手工做的目录/报告检查不构成可发布脚本内的保护。

本轮只改验收基础设施和对应说明，不运行 Codex CLI、真实 RPC 或模型。不暂存、不提交、不推送、不改版本。

## Fix 1 — Execution Reservation

- 原子机制：`openSync(path, "wx")` 独占创建，内容写入后 `fsyncSync`；不是以 existsSync 检查代替锁。
- 固定预留：`artifacts/m6c-fork-execution.json`。
- 首次允许执行的前提：旧预留、固定 fork 报告、旧测试目录均不存在；取得日志所有权、消耗记录、固定报告所有权及新目录所有权后才调用 runner。
- `existsSync` 仅用于提前识别 legacy 证据，真正竞争由 wx 和非递归 leaf mkdir 裁决。
- 同一批次 runner 只调用一次；日志绑定随机 executionBatchId，子报告和总报告绑定同批次。
- 重复启动：任何已有预留/报告/目录都拒绝，runner=0。
- 并发：两个独立 Node 进程只能一个取得执行权，第二个不能调用 runner。
- 失败、进程返回非零、spawn/超时结果不确定、报告写入失败、进程意外退出：已有预留和占位文件均保留；没有自动清理、删除或强制重跑开关。
- 当前 checkout 已存在 C1 的真实目录/固定报告，即使从未创建过新预留，也必须拒绝再次执行。未来新测试批次须重新审查路径与明确授权，不删除旧证据规避门禁。
- 默认只读不调用 runner，也不创建写入预留、fork 目录或 fork 报告；指定总报告仍按独占新文件规则处理。

## Fix 2 — Report Protection

### 固定 fork 报告

包装器在 child 启动前独占创建 `artifacts/m6c-fork-report.json`，持有其可写描述符。通过子进程 stdio fd 3 继承该已拥有文件，不再赋予子脚本按固定路径重开并截断的权限。fork smoke 的小幅适配只涉及报告输出和批次 ID，不改任何 RPC、合成提示、模型选取、归档对象或 sandbox 策略。

子脚本调用共享 `writeOwnedReport`，按显式 offset 写本次拥有的描述符、调整本文件长度并 fsync；不会打开其他旧文件。总报告解析子报告时同时要求本批次 ID 和现有新鲜度/结果条件。缺失、错误批次或未完成占位不能作为成功证据。

未通过包装器直接运行 fork smoke **不具备包装器的防重入及授权保护**；其路径报告写入也改为 wx 防覆盖，但这本身不限制直接脚本的付费操作。不得宣称此修复能拦截外部直接运行 smoke。

### 总报告

`withAcceptanceOutput` 在任何 CLI 进程和写入 runner 回调前独占取得可选 `--report`。已有总报告直接拒绝，字节和摘要不变。callback 执行期间仅更新本调用所拥有的同一 descriptor，不按路径重新打开。进程崩溃/启动失败时新文件保留 reserved 状态，不自动删除。

总报告与 fork 预留、固定报告、工作目录的同名/子路径/父路径重叠都拒绝；Windows 比较忽略路径大小写。这样只读模式也不能把 `execution.json/total.json` 意外创建成预留目录。两个调用竞争相同总报告时，wx 同样决定唯一所有者。

后续隐私修复进一步对总报告和受保护路径的最长现存祖先使用原生 realpath，拒绝 symlink/junction 别名重叠；解析失败时停止。临时 Windows junction 测试覆盖双向别名和缺失后缀。检查与独占创建之间仍有恶意并发替换的 TOCTOU 窗口，不构成对抗恶意文件系统篡改的保证。

文件内容 fsync 不等于父目录项在断电或系统崩溃后必然持久；这里验证的是正常并发和进程崩溃，不能保证磁盘故障或断电下的预留持久性。

### 旧证据

修复前保存了 10 份已有 M6 真实 JSON 报告的 SHA-256，其中包含 `artifacts/m6c-fork-report.json` 和已存在的 `artifacts/m6c-plan-*/approved-fork-subset.json`。修复后全部重新比较，内容和摘要均未改变。没有删除、改名或重写旧报告/日志，没有在真实 artifacts 创建新写入预留以进行测试。

## Security Tests

专项在现有 `threadpath-protocol/src/real-acceptance-tests.ts` 内追加，已由原默认 `npm test`/根 `pnpm test` 包含；无新测试依赖或新工具模块。

| 要求 | 离线验证方式 | 结果 |
| --- | --- | --- |
| A 首次预留 | fake runner 内检查持久 consumed 状态、批次和已拥有报告 | PASS |
| B 同执行第二次 | 同路径再次调用，runner 仍只调用一次，日志/报告 hash 不变 | PASS |
| C 两进程并发 | 两个独立 Node 进程以 stdin barrier 同步竞争，退出码为 0/2，counter 仅一条 runner | PASS |
| D 首次失败后 | throw、非零退出、processError/null 结果均保留预留，第二次拒绝 | PASS |
| E 意外退出 | 子测试进程在 fake runner 内 process.exit(17)，新进程重跑退出 2，counter 仍一条 | PASS |
| F 固定报告已存在 | 保护旧字节/hash，runner=0 | PASS |
| G 总报告已存在 | CLI/fork callback 均不执行，旧字节/hash 不变 | PASS |
| H 旧预留存在 | 无论内容/结果是否成功，runner=0 | PASS |
| I 少参数 | 原有双确认负例保持通过 | PASS |
| J 默认只读 | runRequestedFork(false) 不建任何写入状态，runner=0 | PASS |
| K 预检/冲突失败 | callback/runner=0；预留后 setup 失败也不可重跑 | PASS |
| L 旧证据不变 | 临时旧报告 hash 测试和真实既有报告修复前后 hash 检查 | PASS |
| M 有执行权才启动 | runner 检查日志 state；继承 fd 的 Node-only writer 完成同批次报告 | PASS |
| 路径重叠 | readonly/write 均拒绝预留/报告/目录的父子路径及 Windows case 变体，无路径污染 | PASS |

子测试脚本仅生成在 scratch 临时目录，fake runner 和 fd writer 都是本机 Node，不运行真实 fork smoke。删除仅限测试自身创建的临时目录；持久真实执行日志和旧 artifacts 不清理。

单次只读复核发现总报告子路径可污染预留路径的问题，已在本轮范围内修正并补测；Windows case 子路径亦已保护。没有重新开始宽泛审查。

## Full Regression

全部指定离线回归实际通过：

| 命令 | 结果 |
| --- | --- |
| `node --experimental-strip-types threadpath-protocol/src/real-acceptance-tests.ts` | PASS，含 A–M 与路径负例 |
| `git diff --check` | PASS |
| `pnpm.cmd typecheck` | PASS，最终路径修正后再验通过 |
| `pnpm.cmd test` | PASS，最终默认命令含新增专项实际通过 |
| `pnpm.cmd test:e2e` | PASS，全部既有桌面 fake-server E2E |
| `pnpm.cmd build` | PASS |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS |

pnpm 使用当前进程 `pnpm_config_verify_deps_before_run=false`，没有安装依赖或修改锁文件。日志在会话 scratch 的 `m6-safety-fix-{diff-check,typecheck,test,test-e2e,build,protocol-typecheck}.log`，最终复验另记 `m6-safety-fix-final-{typecheck,test}.log`。全部测试仅 fake server/本地 Node 进程，不代表重新验证真实协议；真实 Codex RPC 与模型调用次数为 0。

## Changed Files

- `threadpath-protocol/src/real-acceptance.ts`：原子日志、报告 descriptor 所有权、路径冲突门禁、runner 单次控制与批次关联。
- `threadpath-protocol/src/real-acceptance-tests.ts`：新增 A–M、并发/崩溃/路径回归。
- `threadpath-protocol/src/fork-smoke.ts`：只适配 owned fd 报告、batch ID 与直接路径输出 wx；不改变业务流程。
- `threadpath-protocol/README.md`：运行/恢复限制与保护边界。
- `docs/development-baseline.md`：增量记录新的验收入口安全规则。
- `docs/m6-final-safety-fix.md`：本报告。

没有修改 ConversationService、ObservatoryService、protocol.ts、CLI 认证、fork 只读策略、版本、依赖或旧验收报告。原有 22 个候选全部保留；最终数量以 Git 实际清点为准。

## Git Status

最终工作区：tracked modified **6**、untracked **18**、合计 **24**。原有 22 个候选全部保留；相对本轮开始仅新增 tracked `fork-smoke.ts` 的报告适配及本修复记录。其他本轮变更均为原候选内允许的验收源码/测试/说明增量。索引为空，HEAD 未变；artifacts/执行日志仍被忽略，没有纳入 Git。本轮未 git add、commit、push、tag 或发布。

## Remaining Risks

本轮目标范围内没有已知未解决的 P1/P2。保护边界仍限于本包装器，不能拦截外部直接调用 smoke；不能把独占报告写入等同于直接 smoke 的授权门禁。未知/损坏预留必须停止，没有绕过参数，未来新批次需新的明确审查授权。

真实 fork Usage 数值继承和压缩实时生命周期等 C4 缺项不由此安全修复关闭，也不重新跑真实验收来弥补。

## Final Result

**FIX_P1: PASS**

**FIX_P2: PASS**

**READY_FOR_COMMIT_REVIEW**

仅表示本轮两项安全修复及离线检查通过，不等于完整 M6 真实生命周期矩阵通过；本轮不暂存、提交、推送或发布。
