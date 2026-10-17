# 开发基线

基线状态：`BASELINE_PARTIAL`；最后核对：2026-10-17。

基线范围为根目录工作区配置、`threadpath-protocol` 的共享客户端、桌面端调用边界，以及随后获授权的分支导航、逐会话草稿、偏好写入、锁检查、会话归档和构建版本追溯。打包领域仅核对图标、源码标签、安装器内容和校验文件；未扫描完整 UI、安全审查或全部历史。适用的用户指令与 `AGENTS.md` 优先，任务专项证据见 [分支协议验证](protocol-fork-verification.md)、[分支讨论闭环](branch-conversation.md) 和 [发布流程](release-process.md)。

## 指令与工具链

| 编号 | 已核对规则 | 证据与复核方式 | 状态 / 置信度 |
| --- | --- | --- | --- |
| AUTH-001 | 修改前阅读文件；保持严格 TypeScript、ESM；保留已有修改；不得记录凭据或敏感对话 | `AGENTS.md`；`threadpath-protocol/tsconfig.json` | 已核对 / 高 |
| TOOL-001 | 根工作区使用 pnpm；声明 Node `>=24.0.0 <25.0.0`；协议子包可以独立使用 npm 脚本 | 根及协议 `package.json`；本次 `node --version` 为 `v24.19.0` | 已核对 / 高 |
| QA-001 | 协议修改至少执行 `npm run smoke`；类型修改同时执行 `npx tsc --noEmit`；离线测试与真实模型调用分开报告 | `AGENTS.md`；协议 README；`npm test`、`npx tsc --noEmit` | 已核对 / 高 |

## 共享设施与默认行为

| 编号 | 规则与复用要求 | 证据与复核方式 | 状态 / 置信度 |
| --- | --- | --- | --- |
| INFRA-001 | 所有协议请求复用 `AppServerClient` 的请求 ID、关联表、JSONL 解析、超时和进程生命周期；业务调用使用类型化方法 | `src/app-server-client.ts`；`src/transport-tests.ts` | 离线验证 / 高 |
| CFG-001 | 默认启动 `codex app-server --stdio`；通用客户端请求超时为 120 秒；真实 smoke 默认请求和终态超时为 300 秒 | `AppServerClient`、`src/app-server-smoke.ts`；复核 `CODEX_EXECUTABLE`、`CODEX_SMOKE_CWD`、`CODEX_SMOKE_TIMEOUT_MS`，不输出秘密值 | 已核对 / 高 |
| INFRA-002 | 诊断默认关闭，只记录方法、ID、时间、结果与错误分类；不得添加完整参数、响应、对话或原始认证配置 | `DiagnosticRecord`；`verifyDiagnostics` | 离线验证 / 高 |
| OBS-001 | Usage 经严格 parser 投影后只存内存，按线程替换绝对快照；resume 确认/取消且不累加，断连 stale，重连等新报告；listener 投递异常逐个隔离；total/last 不代表精确上下文或整回合费用；压缩按 thread/turn/item 去重，纯历史状态未知，重读保留已观察强状态 | `token-usage.ts`、`ObservatoryService`、`ConversationService`、类型化 IPC；2026-10-17 parser/主进程专项回归与桌面 E2E，详见 [观测语义与验收](token-usage-observatory.md) | 离线及桌面验证 / 高 |
| DATA-001 | `thread/read` 读取历史；`thread/resume` 激活历史线程以便续聊；空线程列表有效 | 客户端和 smoke；`thread-resume.jsonl`；transport tests | 离线及本机 smoke 验证 / 高 |
| DATA-002 | 只有服务器明确给出能力集合时才做调用前拒绝；缺省集合不能当作完整能力发现。未知方法仍须处理真实 RPC 错误 | `requireCapability`、`supports`；fork/transport tests | 离线验证 / 高 |
| DATA-003 | 普通 fork 来源使用 `forkedFromId`；协议 `parentThreadId` 是子代理关系；保留 `sessionId`，但不能用其相等推断普通 fork 关系 | 本机生成的 `Thread.ts`；2026-10-12 专用线程实际 fork/read；fork tests | 本机及离线验证 / 高 |
| DATA-004 | 展示回合身份使用稳定 ID；本次本机查询验证 `thread/turns/list` 默认最新优先，`thread/read` 最早优先；不能根据时间猜测祖先关系 | `AppServerClient` 的顺序事实；本机专用测试线程；fixtures | 本机及离线验证 / 高 |
| OPS-001 | 服务端请求不支持时显式回复 `-32601`；网络超时、请求超时、进程错误与协议错误分开处理 | `replyUnsupportedServerRequest`；错误类；transport tests | 离线验证 / 高 |
| TOOL-002 | 离线测试通过 Node `--experimental-strip-types` 运行；不要新增需转换的 TypeScript 参数属性等语法 | 桌面及协议 package scripts；`pnpm test` | 离线验证 / 高 |
| UI-001 | renderer 只用 preload 的类型化 IPC；新分支操作复用主进程连接、源状态协调和工作目录锁 | `preload/index.ts`、`main/index.ts`、`ConversationService`、`WorkspaceLockService`；桌面 E2E | 离线验证 / 高 |
| DATA-005 | 分支来源与截止回合存于 `threadpath-ui.json`；树投影不推断时间关系；完整同步也保留有本地关系的遗漏节点并标记缺失 | `UserPreferencesService`、`CodexHistorySyncService`、`branchGraph`；对应 tests 与重启 E2E | 离线验证 / 高 |
| DATA-006 | 逐会话草稿本地明文保存，上限 100000 字符；偏好写入通过队列和临时文件替换，正常退出等待队列 | `UserPreferencesService.persist/flush`；并发保存及重启 E2E | 离线验证 / 高 |
| SAFE-001 | 新讨论分支共用实际目录；每次模型续聊前用只读 resume 并检查响应策略，未确认则不发起回合 | `AppServerClient.resumeThread`、`ConversationService.startTurn`；错误策略测试及真实重启续聊 | 本机及离线验证 / 高 |
| UI-002 | 来源导航按稳定回合 ID 查找，分页完成后同时设置列表初始位置；定位取消须阻止迟到响应应用到新路线；分界未知时不猜测继承区间 | `branch-navigation.ts`、`Conversation`、`branch-points.e2e.ts`；正文视口与只读请求断言 | 离线验证 / 高 |
| UI-004 | 会话目录从已加载正文按消息顺序派生，以回合 ID 和消息 ID 定位；角色文字区分用户与模型，虚拟列表挂载后对齐消息；搜索和分支摘要继续复用回合级大纲 | `buildMessageOutline`、`ThreadDirectory`、`Conversation.navigate`；目录单元测试、长输入后的回复定位与全部桌面 E2E | 2026-10-14 离线验证 / 高 |
| DATA-007 | 成功创建的会话 ID 不因历史列表暂缺而取消选择；安全元数据立即进入镜像，显式本地工作目录关联参与遗漏保留，仍标记本次快照缺失 | `conversation:start-new`、`loadThreads`、`getRetainedThreadIds`；空历史列表的新建与重启 E2E | 离线验证 / 高 |
| DATA-008 | 服务器返回回合 ID 不代表用户正文已可用；本地已接受输入保留至历史包含原输入，服务器消息 ID 与本地占位 ID 不同也必须去重 | `ConversationService.rememberAcceptedInput/preserveAcceptedInput`；完成前后稀疏历史、正文视口与重启 E2E | 离线验证 / 高 |
| DATA-009 | Codex 归档与本地隐藏分开；已核实筛选能力时由查询补全 archived；成功操作在历史索引确认前不能被迟到扫描撤销，确认后接受外部变更 | `AppServerClient.archiveThread/unarchiveThread`、`CodexHistorySyncService.confirmArchived`；两类列表及并发扫描测试、真实专用会话归档/恢复 | 本机及离线验证 / 高 |
| UI-003 | 首页工作区入口显示现有 Git 根归组后的目录名称和完整路径；已归档历史可读，恢复后续聊；主进程锁和只读核对先于归档，草稿与分支关系保留 | `main.tsx`、`threads:set-archived`、`WorkspaceService`；目录切换、最小窗口、活动拒绝与重启 E2E | 离线验证 / 高 |
| BUILD-001 | Windows 图标需同时配置主 EXE 资源编辑、NSIS 图标和 BrowserWindow 运行时资源；仅设置 `win.icon` 而禁用 `signAndEditExecutable` 不足以更新主 EXE | `electron-builder.yml`、electron-builder 26.0.12 的 `winPackager.signApp`；实际 PE 资源与 ICO 对照 | 产物验证 / 高 |
| BUILD-002 | 应用版本、源码提交和未提交状态在构建时固定，经已有 IPC 提供给「关于」；运行时不依赖 Git；源码归档不能借用上级仓库提交 | `scripts/build-info.ts`、`electron.vite.config.ts`、`app:get-info`；Git 临时仓库 guard 测试和 About E2E | 离线及开发产物验证 / 高 |
| BUILD-005 | electron-vite 的 ESM 配置加载会在源码目录生成 `electron.vite.config.<timestamp>.mjs`；精确忽略该生成文件，E2E 另以实际 Git 状态核对构建信息 | electron-vite 4.0.0 配置加载器、`.gitignore`、`about.e2e.ts`；Beta.2 的 Release 工作流阻止了误标 dirty 的安装包 | 本机及线上失败路径验证 / 高 |
| BUILD-003 | 正式构建必须来自干净源码且 `v<package.version>` 指向 HEAD；打包前后比较元数据，核对 ASAR 和安装器压缩内容；每版生成清单与 SHA-256 | `package-windows.ts`、`release-artifacts.ts`、`verify-release.ts`；缺失/错位标签、未提交文件测试与开发安装器逐字节对照 | 离线及开发产物验证 / 高 |
| BUILD-004 | 发布工作流从版本标签构建，源码及打包 EXE 测试通过后才上传；远程标签须与产物提交一致，已有 release 不替换；上传先保留草稿再核对大小与摘要 | `.github/workflows/release.yml`、`publish-release.ts`；每个版本的线上验证结果见其工作流与公开清单 | 代码核对 / 高；线上结果按版本核对 |

接口使用 stdio JSONL 的 `method/id/params`，并非 HTTP Controller；不额外引入 HTTP 请求约定。

## 已知风险、冲突与历史决策

- `AGENTS.md` 的阶段描述称只有协议原型可运行，但当前仓库实际包含 `apps/desktop` 和根工作区构建脚本。首次任务限定协议验证；后续用户明确授权分支讨论闭环，才扩展至桌面 UI。保留冲突记录，不根据旧阶段描述推断目录不存在。
- 2026-10-12 的受限执行环境无法取得用户主目录，app-server 在握手前退出；正常本地环境可启动。该环境错误不能归类为协议不支持或认证失效。
- 真实 smoke 观察到 Responses WebSocket 超时重试后回退到 HTTP，随后回合成功；不要把等待网络的时间当作握手失败。
- `ad92ccd`（延长真实回合等待超时）及当前 smoke 默认值说明真实测试需要容纳工具启动和传输回退；不为加快测试修改用户认证或持久配置。
- fork 的历史上下文与工作目录中的文件状态独立。产品新增讨论分支使用只读策略，共用源目录；代码隔离与历史文件快照尚未实现或验收。
- Windows 临时目录可能使用短路径，服务层会规范为实际路径；测试须使用原生 `realpath` 对齐，不硬编码本地仓库文件夹名称。同步的 `realpathSync` 不展开所有 8.3 别名，构建来源核对使用 `realpathSync.native`。证据：`workspace-service.test.ts`、`workspace-archive.e2e.ts`、`build-info.ts` 及 Quality 工作流。
- Beta.1 曾更新同名安装包，与旧版本标签的源码不能视为严格对应；Beta.2 起按独立版本标签发布，保留旧发布而不移动标签。不同机器的 NSIS 安装器可能因构建时间而产生不同字节，以该版公开构建清单为准。

## 验证记录与待确认事项

| 日期 | 检查 | 结果 | 范围 |
| --- | --- | --- | --- |
| 2026-10-12 | 修改前 `npm test`、`npx tsc --noEmit` | 通过 | 已有传输及 fixture |
| 2026-10-12 | 本地正常环境 `npm run smoke` | 通过 | 初始化、历史读取、临时回合与流式终态 |
| 2026-10-12 | 新增 fork 离线测试及类型检查 | 通过 | 历史截断、独立历史、重启、元数据与失败路径 |
| 2026-10-12 | 改动后 `pnpm typecheck`、`pnpm test` | 通过 | 协议及桌面端类型检查、全部现有离线测试和新增 fork 测试 |
| 2026-10-12 | 改动后 `npm run smoke` | 通过 | 流式回合在传输回退后成功完成 |
| 2026-10-12 | `npm run smoke:fork` 完整真实分支验收 | 10 项通过，3 个测试线程已归档 | 截断、独立上下文、重启恢复、一次压缩与压缩前历史分叉 |
| 2026-10-12 | 桌面分支增量的类型、构建、离线测试与 E2E | 通过 | 原有 17 场景、新分支闭环、偏好恢复、错误路径、中文主题及最小窗口 |
| 2026-10-12 | 桌面增量后的基础 smoke 与不含压缩的 fork smoke | 通过；fork 7 项、2 个测试线程已归档 | 独立上下文及重启后确认只读策略；报告 `artifacts/branch-readonly-report.json` |
| 2026-10-12 | 来源导航的类型、离线测试和完整桌面 E2E | 通过 | 多页正文跳转、读取重试、缺失回合、取消迟到响应、继承分界和重启追溯 |
| 2026-10-12 | 图标与首页新建修复 | 类型、离线、完整 E2E、实际打包 EXE 的新建与重启测试通过；应用/安装器图标验证通过 | 历史索引延迟、保留与重启；与远程图标 7 种尺寸的资源逐一对照 |
| 2026-10-12 | 首条用户消息补修 | 类型、桌面离线、完整 E2E 与实际打包 EXE 测试通过 | 有回合 ID 但无正文时仍显示输入，完成后保留、去重、恢复；展示占位不干扰活动状态判断 |
| 2026-10-12 | 工作区标签与真实会话归档 | 类型、离线、完整桌面 E2E、基础 smoke 和真实归档/恢复通过 | 归档筛选字段补全、延迟索引、失败、并发扫描、活动阻止、恢复与草稿保留；详见 [验收记录](workspace-archive.md) |

本文件的持久基线状态保持部分就绪，因为完整桌面 UI、打包和跨版本兼容不在扫描范围。全局机制变化后应重新核对对应编号，而非覆盖无关规则。

2026-10-13 增量验证：类型检查、全部离线测试、原有桌面 E2E 和最终 About 增量测试通过；Beta.2 开发包通过五组实际打包程序 E2E，应用与安装器的 7 种图标资源均匹配。开发包明确记录未提交状态；正式干净标签的线上结果由 Release 工作流与公开构建清单提供，不把开发包当作正式发布结果。

## 变更记录

- 2026-10-17：局部修复 Observatory 投递隔离、resume 确认/取消和正文重读压缩状态保护；专项回归覆盖三个原始复现、真实分支元数据登记、断连及完整 identity。复用现有 transport、IPC 和内存观测，无新增依赖或持久化。

- 2026-10-15：增量核对 Token Usage 与压缩观测数据流；复用 transport 和 IPC，保留原有 resume/fork 策略。类型、离线测试、全部桌面 E2E、构建与正常本地环境 smoke 通过；受限环境主目录错误和 WebSocket 回退单独记录，不修改无关基线。

- 2026-10-14：将同回合多段模型消息合为一个目录入口，使用最后一条非空模型消息作为摘要与定位，不改正文、不跨回合合并。类型、桌面单元测试及重新打包后的目录/新建验收通过；最新安装包校验值见 [打包记录](message-outline.md)。

- 2026-10-14：重新生成包含独立工作目录及消息目录的本地 Beta.3 开发安装包；六组实际 EXE 验收和消息目录专项通过，安装器内容与 ASAR 一致，应用及安装器 7 种图标一致。保留 `dirty: true`，未覆盖 GitHub 发布；校验值见 [打包记录](message-outline.md)。

- 2026-10-14：会话目录同时显示用户输入与模型回复，复核消息定位、虚拟列表、流式更新及搜索/分支兼容。类型、全部离线测试和桌面 E2E 全部场景通过；两个旧断言改为限定回复正文后续跑剩余场景。详见 [消息目录](message-outline.md)。

- 2026-10-13：首页新增“不在工作区工作”；使用应用独立目录，保留选择且不归入项目工作区。核对新建、重启、语言切换、从历史模式开始以及项目切换，详见 [验收记录](outside-workspace.md)。

- 2026-10-12：首次建立受范围限制的基线，记录普通 fork 会话身份差异、真实运行环境约束与最终验证结果。
- 2026-10-12：依后续授权扩展桌面分支范围，补记 IPC、工作目录锁、只读确认、偏好写入、草稿和路线恢复机制。
- 2026-10-12：补验来源导航及继承分界；记录虚拟列表首次定位必须同时验证实际正文可见性。
- 2026-10-12：核对远程新增的图标与初始化提交，接入图标资源；补记历史索引延迟及 Windows EXE 图标资源编辑约束。详细差异见 [修复记录](desktop-fixes-2026-10-12.md)。
- 2026-10-12：补记首条用户输入在稀疏历史快照中的保留与服务端去重，避免把回合 ID 出现误当作正文已同步。

- 2026-10-12：补记 Codex 归档/恢复与列表筛选补全，核对迟到扫描、只读活动检查、目录标签及实际打包程序验收；详见 [工作区与归档验收](workspace-archive.md)。

- 2026-10-12：发布前整合远程初始化和 CLI 自动发现，适配弹窗重试 E2E；复验全部静态/离线/桌面检查及最终安装器，按中英文 Conventional Commits 分层提交。

- 2026-10-13：扩展版本与发布基线，记录冻结构建信息、干净标签检查、安装器内容对照、实际打包程序验收和独立发布约束；保留首次线上工作流验证边界。

- 2026-10-13：Beta.2 正式检查发现构建器临时文件导致 dirty 误报并阻止发布，工作流 `38331407343` 未公开安装包；保留候选标签，修正精确忽略规则与独立 E2E 核对后使用 Beta.3 接续发布。
