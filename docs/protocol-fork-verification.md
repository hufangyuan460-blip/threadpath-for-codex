# 分支协议验证

日期：2026-10-12；实现门禁：`READY_TO_CODE`；验证状态：本机完整验收通过。本文件描述上一轮协议阶段，后续桌面增量另见 [分支讨论闭环](branch-conversation.md)。

## 目标与范围

验证从指定历史回合分支、保持原线程、独立续聊、进程重启恢复，以及上下文压缩后的历史分支。修改范围为 `threadpath-protocol` 客户端、类型、专用 fake server、fixture、测试脚本和说明文档。没有实现树/图 UI、应用数据库、代码快照或工作目录隔离，也不修改 Codex 认证及持久配置。

适用规则来自 `AGENTS.md` 与用户确认的协议验证范围；共享不变量见 [开发基线](development-baseline.md) 的 `INFRA-001`、`DATA-002`、`DATA-003` 和 `QA-001`。工作开始时 Git 工作区干净。

## 证据与设计约束

| 事实 | 证据 | 置信度 |
| --- | --- | --- |
| app-server 提供 `thread/fork`，`lastTurnId` 为包含该回合的截止位置；不能指定进行中的回合 | [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)；本机 `codex app-server generate-ts --out <temporary-directory>` 生成的 `ThreadForkParams.ts` | 接口确认；运行结果另列 |
| 本机 CLI 版本为 `0.162.0-alpha.17.2`；Node 为 `v24.19.0` | 2026-10-12 版本命令 | 高，仅代表本机 |
| 新线程提供 `forkedFromId`；普通 fork 的 `sessionId` 在本机为新线程自己的 ID | 2026-10-12 专用线程 fork/read 实测 | 高，仅代表该版本 |
| `parentThreadId` 表示子代理关系，不能映射成普通 fork 来源 | 本机生成的 `Thread.ts` 注释 | 高 |
| 原型已经提供请求关联、终态等待、脱敏诊断、历史读取与续聊 | `src/app-server-client.ts`；已有 transport tests | 高 |

因此客户端透传 `sessionId`，不要求它与来源线程相同。普通分支边应记录“新线程 ID、来源线程 ID、创建时传入的源回合 ID”；当前 API 没有提供可直接替代本地分叉点记录的返回字段。

采用直接 `thread/fork`，不通过复制对话文本或回滚原线程模拟分支。客户端对明确缺失的能力做提前拒绝；未知能力的旧服务器通过实际 RPC 返回结果或错误。`supports("thread/fork")` 在服务器未声明能力时仍返回 false，不能据此宣称该服务器已经经过 fork 验证。

## 调用路径与配置

`smoke:fork` / fork tests → `AppServerClient.forkThread` → JSONL `thread/fork` → `getThread` 元数据映射 → 分别 `turn/start` / 重启后 `thread/resume`。

真实脚本新建专用只读持久线程；每条回复使用随机合成标记检查继承与隔离，不读取已有用户线程。手动压缩通过已有通用请求边界调用 `thread/compact/start`，按通知和终态等待，不按请求响应顺序假定压缩完成。结束后只归档脚本创建的线程，不删除历史。

配置与运行命令见 [协议 README](../threadpath-protocol/README.md)。不需要新增依赖。原有 timeout 历史与默认值见基线；应用 API 保持向后兼容。回退方式为移除本次新增 API 和脚本，不涉及数据库迁移。

## 验收与验证记录

| 验收项 | 可重复离线验证 | 真实验收 |
| --- | --- | --- |
| 从指定结束回合分支，截止回合保留，之后历史排除，原线程不变 | `fork-tests.ts` | 通过；源和分支回合 ID 顺序、成员均符合预期 |
| 两个线程独立追加，双方看不到对方独有的后续上下文 | 独立历史断言 | 通过；随机标记检查模型可见上下文 |
| 重启后来源元数据保留，并能恢复续聊 | 持久 fixture 与第二个子进程 | 通过；read/resume 保留元数据，续聊状态正确 |
| 压缩后仍能继续当前上下文，并从压缩前历史回合准确分叉 | 不由 fake server 证明模型行为 | 通过；当前上下文保留、历史 fork 排除分叉后的标记 |
| 能力缺失、未知方法、坏响应、同 ID 响应、超时、退出、进行中回合拒绝 | `fork-tests.ts` 与 transport tests | 无需对用户线程制造失败 |
| 分支元数据在 fork/read/list/resume 边界保留；旧响应兼容 | fixture 与生命周期 tests | fork/read/resume 实测通过；list/旧响应由离线覆盖 |

已运行：

- `pnpm typecheck`：协议包和桌面端均通过。
- `pnpm test`：协议传输、JSONL fixture、新增 fork 生命周期，以及桌面端全部现有测试均通过。
- `npx tsc --noEmit`（协议目录）：通过。
- `npm run smoke`（改动后、正常本地环境）：初始化、历史读取、流式临时回合均通过；观察到 WebSocket 重试后回退 HTTP 并完成回合。
- `npm run smoke:fork`（正常本地环境）：10 个真实检查全部通过，包含压缩；本次创建的 3 个持久测试线程全部归档。

最后一次真实分支运行的脱敏报告写在忽略目录 `artifacts/protocol-fork-report.json`，`passed: true`、`compactionRequested: true`、`archivePassed: true`。没有提交报告中的运行实例数据，也没有保存对话、认证或机器路径。可按协议 README 的命令重新生成报告。

首次真实 fork 检查触发了原先“sessionId 必须与来源线程相同”的断言。随后只读检查证明 cutoff 与原线程保持行为正确，但身份与文档描述存在差异，已修正客户端注释、fixture 和断言。该失败是验收假设错误，不是 fork 方法不可用。

结论：在本机 CLI `0.162.0-alpha.17.2` 上，可直接使用 `thread/fork + lastTurnId` 支持分支对话，无需复制文本或回滚原线程模拟。本次短合成会话验证了持久化、独立上下文和一次手动压缩；长历史、多次压缩、旧版本 CLI 及代码文件历史状态均不在验收保证范围。没有实现或声称支持对话合并。
