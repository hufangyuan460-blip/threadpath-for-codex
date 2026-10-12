# 工作区入口与会话归档任务上下文

状态：`READY_TO_CODE`；日期：2026-10-12。

## 目标与验收

首页输入框目录入口显示当前目录名称，完整路径可查看且入口仍可切换目录。历史列表与会话页菜单可归档和恢复会话；归档成功退出常用列表，已归档筛选可恢复。失败不更改列表；正在响应时拒绝归档；保留本地草稿、名称、目录关联和分支关系。验收覆盖重启、同步延迟、实际打包程序及最小窗口。

## 指令与现有约束

遵守 `AGENTS.md` 的严格 TypeScript、先读后改、保留已有修改和敏感数据限制。其仅协议原型阶段描述已过时；本次用户明确授权桌面功能，延用现有架构。基线 `AUTH-001`、`QA-001`、`DATA-002`、`DATA-005`、`DATA-006`、`DATA-007`、`UI-001` 适用。不提交已有工作，不修改认证、部署或安装状态。

## 调用路径与证据

- `renderer/main.tsx`：`currentWorkspacePath`、输入框入口、`WorkspaceSidebar` 和 `ThreadDirectory` 菜单；类型化 preload → 主进程 IPC → `AppServerClient`。
- `history-sync-service.ts`：两类列表完整扫描及安全元数据镜像；`workspace-state.ts`：归档筛选已有，普通筛选需排除归档；全局搜索继续可查已归档。
- `ConversationService.reconcileThread` 为只读状态核对；`WorkspaceLockService` 防止与本地发送冲突。归档不用 resume，不发起模型回合。
- 本机生成协议 `artifacts/codex-schema/ts/v2/ThreadArchiveParams.ts` 和 `ThreadUnarchiveParams.ts` 均为 `{threadId}`；archive 响应为空对象，unarchive 返回 thread。前次真实 fork 测试已实际调用 archive；恢复将用专门生成的测试线程验证。
- 归档并非本地隐藏。复用 Codex 存储，安全镜像只保存元数据；不新增数据库或保存正文。

## 配置、风险与替代方案

沿用 Node 24、pnpm、Electron 构建与离线 fake-server 测试。能力未知可实际探测，明确缺失则返回兼容错误。选择真实归档而非本地隐藏，因为已有隐藏动作不能满足 Codex 跨客户端状态一致性。历史对象未必包含 archived，已确认筛选能力时按查询类型补全；历史索引迟到不能覆盖刚成功的操作，确认后继续接受外部变化。运行状态读取失败则拒绝归档；操作失败不伪造成功；偏好保存失败区分远端已成功，避免重复操作。

## 假设、验证与回退

假设归档为单会话操作，不加批量菜单；归档会话先恢复再续聊。无影响设计的未决项。运行 `pnpm typecheck`、`pnpm test`、完整 `pnpm test:e2e`、协议 `npm run smoke`；归档/恢复真实测试只使用本次创建的无敏感内容线程，最终归档清理。重建 Windows 包并验证实际 EXE。回退仅撤回本次增量，不覆盖之前未提交改动；无需偏好迁移，服务器归档可用恢复动作撤销。
