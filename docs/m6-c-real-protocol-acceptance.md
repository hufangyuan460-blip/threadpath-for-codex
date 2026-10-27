# M6-C Real Protocol Acceptance

## Environment

验收日期：2026-10-26（Windows 本地时间）。本报告仅证明本次执行，不复用旧版本的实测结果。

| 项目 | 本次证据 |
| --- | --- |
| CLI version | `codex-cli 0.163.0-alpha.11`，实际执行 `--version` |
| CLI SHA-256 | `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` |
| CLI executable | `%LOCALAPPDATA%\OpenAI\Codex\bin\6257d9e8f63c0f2b\codex.exe`，原生二进制而非 launcher；未出现在当前 PATH |
| App commit | `72c91dedef0c5cd1d5ee465b0c092ccd2851a867`（M6-B）；验收起始工作区干净，随后只有本报告所列验收基础设施/文档修改 |
| Execution identity | 正常登录用户（已脱敏）；Node `os.userInfo()` 与 `whoami` 一致，不记录机器名 |
| Windows / Node | Windows 10 build `19045`，`v24.19.0` |
| Shell / package manager | 工具执行为 Windows PowerShell `5.1.19041.6456`；已发现 PowerShell 7；pnpm `11.7.0` |

实际脱敏运行报告：`artifacts/m6c-readonly-report.json`（忽略目录），时间 `2026-10-26T00:44:13.795Z`。输出不包含标题、预览、会话正文、完整 RPC 或原始 stderr。`stderrBytes=0`、`protocolWarnings=0`。没有调用模型、创建线程、resume、fork、归档、恢复或压缩。

当前二进制另成功执行 `app-server --help` 和 `app-server generate-ts --out <session scratch>/m6c-current-schema`。schema 是本次版本生成的接口描述，**不是**真实历史/写入 RPC 验收证据；没有覆盖仓库旧 schema 或 fixture。

## Verification Matrix

`SKIP` 表示安全边界或未观测导致未执行；`BLOCKED` 表示缺少执行前提（本轮没有写入授权）。它们都不代表产品失败，也不计为通过。

### Connection

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| initialize | PASS | 使用项目 `AppServerClient`，真实响应完成解析 |
| initialized | PASS | 共享客户端发送通知，之后 `model/list` 成功；该通知本身无响应 |
| model/list | PASS | 同一实际连接返回 7 个模型 |

### History

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| thread/list | PASS | `archived:false` 和 `archived:true` 各以 `limit:1` 请求并解析；只处理元数据 |
| thread/read | SKIP | 未提供已确认的专用测试线程；没有自动读取列表首个用户会话 |
| thread/turns/list | SKIP | 同上 |
| notLoaded | SKIP | 未读取专用历史；本次 schema 声明不计作实测 |
| summary | SKIP | 同上 |
| full | SKIP | 同上 |
| 线程列表游标分页 | PASS | 消费第一页面的 nextCursor；两页各 1 条，身份不重叠且游标不重复 |
| 回合游标分页 | SKIP | 未提供专用测试线程；线程分页不替代回合分页 |
| 历史正文完整性 | SKIP | 没有已知合成输入/回复与各历史投影的真实对照；元数据成功不证明正文完整 |

### Conversation

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| thread/start | BLOCKED | 须批准专用测试工作区的状态变更 |
| turn/start | BLOCKED | 须批准真实模型调用及费用 |
| turn/completed | BLOCKED | 本轮不发起模型回合，未收到真实终态 |
| 已知终态处理 | BLOCKED | 同上；离线回归不能计作本项通过 |
| 未知终态处理 | SKIP | 当前 schema 的合法状态为 completed/interrupted/failed/inProgress；没有真实未知终态，不向真实用户线程制造异常。M6-B 离线负例单独列示 |
| thread/resume | BLOCKED | 只在后续专用测试线程上执行，不批量激活私人历史 |
| 只读策略确认 | BLOCKED | 未执行 resume；当前 schema 保留 sandbox 字段不证明实际返回 readOnly |

### Branch

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| thread/fork | BLOCKED | 未获专用线程写入授权 |
| lastTurnId 截断 | BLOCKED | 未执行 fork；schema 仍声明字段不等于行为验收 |
| forkedFromId | BLOCKED | 未执行 fork/read；schema 声明不计为实测 |
| 分支独立续聊 | BLOCKED | 未获模型调用授权 |
| 重新读取分支历史 | BLOCKED | 本轮未创建/指定测试分支 |

### Archive

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| thread/archive | BLOCKED | 未获专用线程状态变更授权 |
| thread/unarchive | BLOCKED | 同上 |
| 归档后读取 | BLOCKED | 没有专用归档线程；读取 archived 列表不等于归档正文可读 |
| 恢复线程 | BLOCKED | 未执行恢复和恢复后的读取/续聊 |

### Observatory

| 项目 | 结果 | 真实依据 |
| --- | --- | --- |
| thread/tokenUsage/updated | BLOCKED | 未发起模型回合；没有对应真实通知 |
| total | BLOCKED | 当前 schema 六计数器与 parser 声明一致，但没有实际 payload 验收 |
| last | BLOCKED | 同上；不得解释为精确回合消耗 |
| modelContextWindow | BLOCKED | 当前 schema 为 number/null；没有实际 payload 验收 |
| contextCompaction 生命周期 | BLOCKED | 未批准/执行 compact；仅声明 item 类型不证明 started/completed |
| 通知缺失 | SKIP | 没有应产生 usage 的真实回合，不能将未调用导致的无通知判为缺失 |
| 重复通知 | SKIP | 没有真实重复样本；不伪造真实 CLI 事件，去重仅有离线证据 |
| fork 继承用量 | BLOCKED | 未执行 fork 与前后 usage 观测；不将 inherited total 推算为独立消费 |

## Compatibility Findings

本次实际执行的 RPC 没有发现协议不兼容，也没有 Windows Profile、认证或网络错误。不能据此推断未执行链路兼容。

本次生成 schema 的实际注意事项（不是 RPC 失败）：

- `ThreadTurnsListParams` 默认 descending、默认 `itemsView: summary`，并可显式请求 itemsView。当前客户端的 `listTurns` 没有设置该字段；返回元数据/summary 不能当作完整正文。
- `ThreadReadParams.includeTurns` 对 paginated threads 的完整 hydration 已标记 deprecated，建议用 `thread/turns/list` 与 `thread/items/list`。是否导致当前 UI 正文缺失仍需专用线程实测，**未确认为产品缺陷**，本轮不改业务功能。
- 当前 schema 仍包含 lastTurnId、forkedFromId、resume sandbox、六个 usage 计数器、nullable modelContextWindow 和 contextCompaction；这些事实不能替代运行验收。

## Tests

以下命令实际执行通过；它们使用合成 fixture/fake app-server，不是 CLI 兼容性证据。pnpm 使用当前进程 `pnpm_config_verify_deps_before_run=false` 复用已安装依赖，没有安装依赖或修改锁文件。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `git diff --check` | PASS | 最终差异无空白错误；另检查新增文件 |
| `pnpm.cmd typecheck` | PASS | 协议与桌面端；最终接入安全测试后再次通过 |
| `pnpm.cmd test` | PASS | 原有全部离线测试；最终重跑包含新增 real-acceptance 安全测试 |
| `pnpm.cmd test:e2e` | PASS | 全部 8 组桌面 fake-server E2E，约 101 秒 |
| `pnpm.cmd build` | PASS | 桌面构建完成，无发布或打包操作 |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS | 使用本机已有编译器，无依赖下载 |
| `node --experimental-strip-types threadpath-protocol/src/real-acceptance-tests.ts` | PASS | 参数双确认、脱敏、只读 RPC allowlist、私人/空线程不自动读取、专用历史和视图观测 |

完整回归日志在会话 scratch 的 `m6c-{typecheck,test,test-e2e,build,protocol-tsc}.log`，最终重跑单元测试在 `m6c-final-test.log`。没有沙箱权限阻碍这些检查。M6-B 的未知终态、历史完整性与 Pending Input 合成负例仍仅属于离线证据。

`npm run smoke` 和 `npm run smoke:fork` 本轮均未自动执行：前者读取首个用户历史并创建真实模型回合，后者还会压缩、归档；用户的显式安全限制优先于 AGENTS 的一般 smoke 要求。本轮使用新增默认只读验收作为安全的真实连接检查。

## Manual Actions Required

以下命令在正常登录用户的 **PowerShell 7** 中执行；无需管理员权限，不修改注册表、认证或持久 CLI 配置。使用 `.cmd` 避免 `.ps1` shim 的执行策略限制。若 CLI 被更新/移除，重新发现，不借用历史版本/schema 的结果。

### 1. 可重复只读验收（无模型费用、不修改线程）

```powershell
Set-Location '<project-root>'
$exe = (Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $exe) { throw '未发现原生 Codex CLI，请确认安装位置后显式设置 $exe' }
& $exe --version
Get-FileHash -LiteralPath $exe -Algorithm SHA256
node --experimental-strip-types .\threadpath-protocol\src\real-acceptance.ts --executable $exe --report .\artifacts\m6c-readonly-report.json
```

如要只读一个**专用**测试线程（不要输入真实工作会话 ID），在上段同一窗口执行：

```powershell
$testThread = Read-Host '输入已确认的专用测试线程 ID（不要输入私人工作会话）'
if ([string]::IsNullOrWhiteSpace($testThread)) { throw '没有指定专用测试线程' }
node --experimental-strip-types .\threadpath-protocol\src\real-acceptance.ts --executable $exe --test-thread $testThread --confirm-test-thread --report .\artifacts\m6c-test-history-report.json
```

该模式不 resume，不调用模型；仅读取指定线程，正文只保留在内存。没有已知合成预期正文时，body integrity 仍为 SKIP；出现某个 itemsView 只证明该响应的字段/解析路径，不证明桌面合并行为。

### 2. 需用户明确批准的真实 fork 子集（会产生费用并修改测试历史）

**仅在批准之后执行。** 以下两项显式参数表示同意调用模型、创建持久测试线程、压缩和归档。工作目录固定为 `artifacts/m6c-fork-workspace`；不使用用户工作会话，不自动删除数据。完整成功运行预计创建 3 个测试线程、7 个对话回合并发起一次手动压缩；模型重试/压缩也可能产生费用。失败时只尝试归档脚本本次创建的线程，不保证归档一定成功。

在第 1 段同一 PowerShell 7 窗口执行：

```powershell
node --experimental-strip-types .\threadpath-protocol\src\real-acceptance.ts --executable $exe --write --confirm-cost-and-state --report .\artifacts\m6c-approved-fork-subset.json
Get-Content .\artifacts\m6c-fork-report.json
```

包装器复用 `fork-smoke.ts`：合成状态标记、指定回合截断、源线程保持、分支独立上下文、重启后 read/resume/只读策略、手动压缩、压缩前历史再 fork、最后归档。不要直接运行基础 smoke，不要设置任何真实会话写入 ID。子脚本输出被抑制，只查看结构化脱敏结果；模型/网络失败不静默跳过。

**这不是全部剩余验收的一键命令。** 包装器未覆盖 unarchive/归档后正文/恢复后续聊、显式三种 itemsView 与已知正文比对、usage total/last/window、压缩 item 生命周期、重复/缺失通知和 fork usage 继承。即使 fork 子集报告 passed=true，M6-C 仍为 NEED_USER_VALIDATION。上述项目须在批准后对新建专用线程逐项补证；本轮没有预先实现或执行这些额外写入测试。真实未知终态/重复事件若未自然出现，继续记录 SKIP，并保留离线故障注入结果，不能伪装真实 CLI 验收。

## Beta.4 Blockers

1. 尚未批准/完成当前 CLI 上 Conversation、Branch、Archive、Observatory 的完整专用线程真实验收。
2. 未验证 paginated 历史各加载视图、回合分页与已知合成正文完整性；尤其不能以 summary 或列表元数据替代 full。
3. 新增包装器仅提供既有 fork 子集，归档恢复及 Observatory 等剩余项仍需补充专项真实证据。未自然出现的未知终态/重复事件须明确决定发布门禁如何接受 SKIP，不能虚报 PASS。
4. 本轮没有执行正式发布产物门禁；后续仍须按 release-process 从干净发布提交/标签构建并验证实际 EXE。它不是本轮协议缺陷。

## Git Status

起始无用户未提交改动。任务修改：

- `threadpath-protocol/src/real-acceptance.ts`：默认只读验收及显式双确认的既有 fork smoke 包装。
- `threadpath-protocol/src/real-acceptance-tests.ts`：离线安全/脱敏回归。
- `threadpath-protocol/package.json`：验收命令及测试接入。
- `threadpath-protocol/README.md`：运行方法、安全边界及本次真实检查说明。
- `docs/m6-c-real-protocol-acceptance.md`：本报告。
- `docs/development-baseline.md`：增量记录默认只读验收规则与证据链接。

`artifacts/m6c-readonly-report.json` 为忽略的本机脱敏运行实例，未纳入 Git；临时 schema 与回归日志保存在会话 scratch，不提交环境数据。没有 commit、push、tag 或发布。

## Final Result

**M6_C: NEED_USER_VALIDATION**

当前 CLI 的真实只读链路通过。写入/模型验收尚未获批，未执行链路保留门禁；离线回归不替代真实兼容性验收。
