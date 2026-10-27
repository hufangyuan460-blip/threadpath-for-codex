# M6-C2 Real History Acceptance Report

## Environment

验证日期：2026-10-26。本记录限于该二进制、该次专用合成历史与当前源码，不提供跨版本或任意长历史保证。

| 项目 | 实际值 |
| --- | --- |
| CLI version | `codex-cli 0.163.0-alpha.11` |
| CLI SHA-256 | `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` |
| App commit | `72c91dedef0c5cd1d5ee465b0c092ccd2851a867`，含原有验收基础设施未提交改动及本轮验收增量 |
| Execution identity | 正常登录 Windows 用户（已脱敏）；Profile 正常 |
| Runtime | Windows `10.0.19045`，Node `v24.19.0` |
| 最终采集时间 | `2026-10-26T03:10:34.544Z` |

本次重新使用该二进制生成 schema 到会话 scratch，核对 `ThreadReadParams`、`ThreadTurnsListParams`、`TurnItemsView` 和 `ThreadListParams`。schema 不计作真实 RPC 通过。确认默认回合顺序 descending、默认 itemsView 为 summary，合法视图为 notLoaded/summary/full；`thread/read includeTurns:true` 的 full hydration 对 paginated 线程已 deprecated，但本次仍实际返回完整正文。

## Test Threads

Identified count：**3**；全部通过 `archived:true` 筛选确认。

- 只查询 `artifacts/m6c-fork-workspace` 的状态数据库元数据；活动线程数 0，归档线程数 3。
- 三条记录的 cwd、ID 唯一性和 createdAt 均匹配上轮真实执行窗口 `02:34:10.474Z—02:42:32.450Z`。
- 同时核对上轮成功 fork 报告、创建数量 3、归档成功，以及包装器版本/摘要/commit。
- 列表中的 forkedFromId 全为 null；先验证候选组的目录、时间与归档身份，再仅允许 `thread/read includeTurns:false`。三条 metadata-only 响应的 turns 均为空，由其实际 forkedFromId 还原 source → branch → historical 链后，才开放正文白名单。
- 没有用标题、预览、列表首项或时间排序推测祖先关系。报告只记录角色和 ID 的 SHA-256，不输出真实正文或随机标记。

## Real RPC Results

| 项目 | 结果 | 实际证据 |
| --- | --- | --- |
| thread/read | PASS | 三条已归档线程均核对 ID/cwd；分别执行 metadata-only 与 includeTurns:true |
| notLoaded | PASS | 返回对应 itemsView，3/5/2 个回合、各 0 item；DTO 保留 notLoaded |
| summary | PASS | 返回对应 itemsView，item 身份仍可关联 full；未把该标记改成 full |
| full | PASS | 全部页面的原始 text/content 与 DTO 逐 item 相等；与已知合成提示、JSON 回复逐条比较成功 |
| turn pagination | PASS | 三种视图均使用 limit:1 和 desc；消费全部游标，终页无 nextCursor，无重复、缺失或顺序差异 |
| archived read | PASS | 未 unarchive/resume；直接读取三条归档历史成功 |
| thread/read 与 full 页面正文一致 | PASS | 回合顺序、itemsView、item 集合和正文逐项相等 |

实际页数与 item 数：

| 线程角色 | 每种视图页数/回合数 | notLoaded items | summary items | full items |
| --- | ---: | ---: | ---: | ---: |
| source | 3 | 0 | 6 | 6 |
| branch | 5 | 0 | 8 | 9 |
| historical | 2 | 0 | 4 | 4 |

最终采集共调用 `thread/list` 3 次、`thread/read` 9 次（其中 3 次为身份元数据补全）、`thread/turns/list` 30 次，另完成 initialize/initialized。模型调用请求 **0**、状态变更 RPC **0**；stderrBytes 和 protocolWarnings 均为 0。

## Body Integrity

### 真实服务端与协议 parser

- `includeTurns:false` 实际返回空 turns 及 historyMode=paginated；这只是未返回历史，不证明真实会话为空。
- `includeTurns:true` 本次返回 3/5/2 个 full 回合，与完整 full 分页逐 item 相等。
- full 中用户输入的 content 和模型回复的 text 均由现有 parser 原样保留，没有本次可见正文丢失。
- 从已确认源线程的合成 seed 恢复随机标记，仅在内存中重建 7 次原始提示与预期状态；包括继承副本的对话回合数为 3/4/2，去重后对应上轮 7 个对话回合。
- 共享 base 回合的 ID/item/正文在三条线程一致；各分支独有回合互不交叉。历史分支保留截止回合并排除源分支后续历史。
- 主分支 full 历史保留 1 个 contextCompaction item，压缩前后已知对话正文均通过对照；不根据纯历史 item 推断压缩通知生命周期。
- 主分支 summary 只有 8 个 item，而 full 有 9 个。这实际证明 summary 不是完整 item 集合，不能作为完整历史或完整压缩计数。

### 真实响应的本地回放（不是服务器时序证明）

将本次实际捕获的 DTO 与页面仅在内存中交给未修改的 `ConversationService`；重叠与迟到响应的调度由验收工具控制，没有伪造为服务端自然事件。

| 回放检查 | 结果 |
| --- | --- |
| notLoaded → summary → full：未加载保持未知，summary 不标 full，full 正文与实际 DTO 相等 | PASS |
| full → summary：已有 full 文本不被弱响应覆盖 | PASS |
| 重叠页面：同一回合不重复、不改变已确认正文 | PASS |
| 线程切换：分别保留各线程正文；继承的同一回合 ID 不污染不同分支 | PASS |
| 旧 read 晚于新 read：superseded 响应拒绝应用 | PASS |
| 旧页面晚于新 read：正文、游标和 paging 状态不被回退 | PASS |

最终共 **28 项 PASS**：21 项真实 RPC/身份/正文检查，7 项本地回放记录（含回放总项）。没有用离线 fixture 替代真实历史证据，也没有声称服务器产生过本地注入的时序。

## Compatibility Findings

实际发现的投影差异：`thread/list(useStateDbOnly:true)` 在本次三条记录中都返回 `forkedFromId:null`；metadata-only `thread/read` 则保留两个分支的真实来源。不能把索引中的 null 解释为“不是 fork”，也不能据此自动选取线程。最初工具要求列表自行给出完整来源链而被安全门禁阻止；仅修正验收身份补全过程，未修改业务功能。

正文 parser、历史视图标记和合并逻辑本次未复现不兼容。分页无异常；summary 与 full 的 item 数差异是实际投影差异，不当作正文丢失，也没有忽略它制造 PASS。

## Reports

均为新文件，未覆盖旧报告：

- 最终报告：`artifacts/m6c2-history-0e89d09017eb4edab2e5386e422c2dea.json`。
- 最终报告 SHA-256：`96d5579e7287c24f8e70d27f09736fc3a5cbebdefd7c903d0d6591bd2665adad`。
- 中间完整通过报告：`artifacts/m6c2-history-3bd197c8ab974673bac0e55e3040675c.json`；最终复验额外加强了 read/full 跨接口逐 item 比较和 summary item 身份对照。
- 初次门禁报告：`artifacts/m6c2-history-e22e860d2a4b41428e333a03cf965dec.json`，`IDENTITY_BLOCKED`，只有初始化和元数据请求，未读取正文。

三份报告全部保留。期间只重跑只读采集，没有任何模型、resume、fork、归档/恢复或压缩操作。上轮 fork 与包装器报告经 SHA-256 核对未变。

## Tests

以下命令实际执行通过，均为离线工程回归，不能计作真实服务端通过。pnpm 使用当前进程 `pnpm_config_verify_deps_before_run=false` 复用已安装依赖，无安装/锁文件修改。

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test`（含新增安全测试） | PASS |
| `pnpm.cmd test:e2e`（全部 8 组桌面 fake-server E2E） | PASS |
| `pnpm.cmd build` | PASS |
| 协议目录 `npx.cmd --no-install tsc --noEmit` | PASS |
| 独立运行新增安全测试与桌面编译器 | PASS |

日志位于会话 scratch 的 `m6c2-{diff-check,typecheck,test,test-e2e,build,protocol-tsc}.log`。安全测试覆盖身份数量/目录/时间/链冲突、索引 null 来源、候选只能读 metadata、写入 RPC 全拒绝、已有报告禁止覆盖、BOM 记录、重复游标、投影丢失和六组回放。

准备阶段一次 `pnpm --filter @threadpath/desktop typecheck` 返回 1 且未显示诊断；直接本机 tsc 和最终根类型检查均通过，回归未复现该启动结果，没有通过修改配置、安装依赖或忽略编译诊断制造通过。基础 smoke 会创建模型回合，按本轮只读限制未运行。

## Git Status

本轮新增或修改：

- `apps/desktop/scripts/real-history-acceptance.ts`：只读 RPC 白名单、候选/正文两级身份门禁、显式视图分页、正文对照与真实响应本地回放。
- `apps/desktop/scripts/real-history-acceptance.test.ts`：纯离线安全/失败路径与回放回归。
- `apps/desktop/package.json`：新增 `acceptance:history`，将安全测试接入 test。
- `threadpath-protocol/README.md`：运行方式、限制及本次证据链接。
- `docs/development-baseline.md`：补记索引来源 null 与 metadata-only hydration 的实际边界。
- `docs/m6-c2-real-history-acceptance.md`：本报告。

保留原有 6 个未提交改动，没有替换业务 parser、ConversationService、认证或 CLI 安装，没有新增依赖、数据库或迁移。报告位于 Git 忽略的 artifacts；原始正文和随机标记没有写入日志或 fixture。未 commit、push、tag 或发布。

## Remaining Beta.4 Blockers

- 本次 CLI、专用短合成历史上的历史正文/视图/分页及解析合并验收已关闭；不扩展为任意长历史保证。
- Archive 的 unarchive、恢复后的状态与续聊仍待独立授权验收。
- Observatory 的真实 Usage payload、fork 用量继承及压缩通知生命周期仍待验收；本次历史压缩 item 不替代这些证据。
- 全 M6-C 矩阵仍未完成；本轮不进入 M6-C3，也不发布 Beta.4。

## Final Result

**M6_C2: PASS**

**M6_C_FULL_MATRIX: INCOMPLETE**
