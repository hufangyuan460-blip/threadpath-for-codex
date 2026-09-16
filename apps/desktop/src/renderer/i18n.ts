import type { ConnectionState, Language } from "../shared/api";

export interface Messages {
  readonly setup: string;
  readonly firstLaunch: string;
  readonly detectingCli: string;
  readonly detectingDetails: string;
  readonly cliFound: string;
  readonly version: string;
  readonly chooseProjectBeforeConnect: string;
  readonly workingDirectory: string;
  readonly chooseWorkingDirectory: string;
  readonly connectVerify: string;
  readonly connecting: string;
  readonly connectingDetails: string;
  readonly setupAttention: string;
  readonly retryDetection: string;
  readonly chooseCli: string;
  readonly chooseAnotherCli: string;
  readonly detectAgain: string;
  readonly workspace: string;
  readonly workspaceHistory: string;
  readonly unclassified: string;
  readonly addWorkspace: string;
  readonly chooseWorkspace: string;
  readonly historyReadOnly: string;
  readonly confirmWorkspaceToSend: string;
  readonly collapseWorkspace: string;
  readonly expandWorkspace: string;
  readonly associateWorkspace: string;
  readonly bindWorkspace: string;
  readonly changeWorkspace: string;
  readonly threadActions: string;
  readonly moveToWorkspace: string;
  readonly noWorkspace: string;
  readonly renameChat: string;
  readonly renameHint: string;
  readonly cancel: string;
  readonly close: string;
  readonly copy: string;
  readonly copied: string;
  readonly linkUnavailable: string;
  readonly welcome: string;
  readonly threads: string;
  readonly refresh: string;
  readonly syncNow: string;
  readonly syncing: string;
  readonly syncedAt: (value: string) => string;
  readonly partialHistory: string;
  readonly syncFailed: string;
  readonly loading: string;
  readonly waitingConnection: string;
  readonly noThreads: string;
  readonly loadingThreads: string;
  readonly conversation: string;
  readonly selectThread: string;
  readonly chooseThread: string;
  readonly loadingConversation: string;
  readonly noReadableTurns: string;
  readonly noConversationContent: string;
  readonly searchLoadedTurns: string;
  readonly searchPlaceholder: string;
  readonly onlyLoaded: string;
  readonly match: (count: number) => string;
  readonly outline: string;
  readonly turns: (count: number) => string;
  readonly turn: (index: number) => string;
  readonly role: (role: "user" | "assistant" | "system") => string;
  readonly connectionStatus: string;
  readonly selectedConversation: string;
  readonly goToTurn: (index: number, label: string) => string;
  readonly loadEarlier: string;
  readonly loadingEarlier: string;
  readonly noMore: string;
  readonly noReadableItems: string;
  readonly tool: string;
  readonly status: string;
  readonly sendMessage: string;
  readonly inputPlaceholder: string;
  readonly starting: string;
  readonly ready: string;
  readonly turnRunning: string;
  readonly remoteTurnRunning: string;
  readonly localTurnRunning: string;
  readonly workspaceLocked: string;
  readonly stateUnknown: string;
  readonly refreshStatus: string;
  readonly newContent: string;
  readonly pauseUnavailable: string;
  readonly model: string;
  readonly reasoning: string;
  readonly codexDefault: string;
  readonly modelUnavailable: string;
  readonly reasoningUnavailable: string;
  readonly inputUnavailable: string;
  readonly send: string;
  readonly running: string;
  readonly reconnecting: string;
  readonly reconnect: string;
  readonly rename: string;
  readonly save: string;
  readonly resetName: string;
  readonly threadNamePlaceholder: string;
  readonly language: string;
  readonly server: string;
  readonly backToHistory: string;
  readonly questionOutline: string;
  readonly noQuestions: string;
  readonly connectionState: (state: ConnectionState) => string;
}

const englishWorkspaceMessages = {
  workspaceHistory: "Workspace history",
  unclassified: "Unclassified history",
  addWorkspace: "Add workspace",
  chooseWorkspace: "Choose a workspace directory before sending.",
  historyReadOnly: "History browsing mode",
  confirmWorkspaceToSend: "Confirm a working directory before sending.",
  collapseWorkspace: "Collapse workspace",
  expandWorkspace: "Expand workspace",
  associateWorkspace: "Move to current workspace",
  bindWorkspace: "Bind workspace",
  changeWorkspace: "Change workspace",
  threadActions: "Thread actions",
  moveToWorkspace: "Move to workspace",
  noWorkspace: "No workspace (unclassified history)",
  renameChat: "Rename chat",
  renameHint: "Keep it short and easy to recognize",
  cancel: "Cancel",
  close: "Close",
  copy: "Copy",
  copied: "Copied",
  linkUnavailable: "Links are disabled in this preview.",
  welcome: "What are we building in ThreadPath for Codex?",
  syncNow: "Sync history",
  syncing: "Syncing history…",
  syncedAt: (value: string) => `Synced locally at ${value}`,
  partialHistory: "This Codex version returned only part of the history.",
  syncFailed: "History sync failed.",
  localTurnRunning: "ThreadPath is responding.",
  workspaceLocked: "Another conversation is running in this workspace.",
  stateUnknown: "Workspace state is unknown. Refresh before sending.",
  newContent: "New content",
} as const;

const chineseWorkspaceMessages = {
  workspaceHistory: "工作区历史",
  unclassified: "未归类历史",
  addWorkspace: "新增工作目录",
  chooseWorkspace: "发送前请选择工作目录。",
  historyReadOnly: "历史浏览模式",
  confirmWorkspaceToSend: "确认工作目录后即可发送。",
  collapseWorkspace: "收起工作目录",
  expandWorkspace: "展开工作目录",
  associateWorkspace: "移动到当前工作目录",
  bindWorkspace: "绑定工作区",
  changeWorkspace: "更改工作区",
  threadActions: "线程操作",
  moveToWorkspace: "移动到工作区",
  noWorkspace: "无工作区（未归类历史）",
  renameChat: "重命名聊天",
  renameHint: "保持简短且易于识别",
  cancel: "取消",
  close: "关闭",
  copy: "复制",
  copied: "已复制",
  linkUnavailable: "当前预览不支持打开链接。",
  welcome: "我们要在 ThreadPath for Codex 中做什么？",
  syncNow: "同步会话历史",
  syncing: "正在同步会话历史…",
  syncedAt: (value: string) => `已于 ${value} 同步到本地`,
  partialHistory: "当前 Codex 版本仅返回部分历史。",
  syncFailed: "会话历史同步失败。",
  localTurnRunning: "ThreadPath 正在回复。",
  workspaceLocked: "该工作区中有其他会话正在运行。",
  stateUnknown: "无法确认工作区状态，请刷新后再发送。",
  newContent: "有新内容",
} as const;

export const messages: Record<Language, Messages> = {
  "en-US": { ...englishWorkspaceMessages,
    setup: "Codex setup", firstLaunch: "First launch setup", detectingCli: "Detecting Codex CLI…", detectingDetails: "Checking the configured executable, saved choice, PATH, and known Windows install locations.", cliFound: "Codex CLI found", version: "Version", chooseProjectBeforeConnect: "Choose a project directory before connecting.", workingDirectory: "Working directory", chooseWorkingDirectory: "Choose working directory", connectVerify: "Connect and verify", connecting: "Connecting to Codex…", connectingDetails: "Starting the local app-server and validating the protocol.", setupAttention: "Codex setup needs attention", retryDetection: "Retry detection", chooseCli: "Choose Codex CLI", chooseAnotherCli: "Choose another CLI", detectAgain: "Detect again", workspace: "Workspace", threads: "Threads", refresh: "Refresh", syncNow: "Sync history", syncing: "Syncing history…", syncedAt: (value) => `Synced locally at ${value}`, partialHistory: "This Codex version returned only part of the history.", syncFailed: "History sync failed.", loading: "Loading…", waitingConnection: "Waiting for the Codex connection.", noThreads: "No threads are available.", loadingThreads: "Loading threads…", conversation: "Conversation", selectThread: "Select a thread", chooseThread: "Choose a thread to read its linear conversation.", loadingConversation: "Loading conversation…", noReadableTurns: "No readable turns", noConversationContent: "This thread has no conversation content available.", searchLoadedTurns: "Search loaded turns", searchPlaceholder: "Search loaded history…", onlyLoaded: "Only loaded turns are searched.", match: (count) => `${count} match${count === 1 ? "" : "es"}`, outline: "Outline", turns: (count) => `${count} turn${count === 1 ? "" : "s"}`, turn: (index) => `Turn ${index}`, role: (role) => role === "user" ? "User" : role === "assistant" ? "Assistant" : "System", connectionStatus: "Connection status", selectedConversation: "Selected thread conversation", backToHistory: "Back to conversation history", questionOutline: "Question outline", noQuestions: "No readable questions yet.", connectionState: (state) => state, goToTurn: (index, label) => `Go to turn ${index}: ${label}`, loadEarlier: "Load earlier turns", loadingEarlier: "Loading earlier turns…", noMore: "No more loaded turns.", noReadableItems: "No readable items were provided for this turn.", tool: "Tool", status: "Status", sendMessage: "Send a message", inputPlaceholder: "Write a plain-text turn…", starting: "Starting…", ready: "Ready", turnRunning: "Turn running…", remoteTurnRunning: "This conversation is responding.", refreshStatus: "Refresh status", pauseUnavailable: "Pause is not available for this Codex server.", model: "Model", reasoning: "Thinking", codexDefault: "Codex default", modelUnavailable: "Model selection is unavailable for this Codex server.", reasoningUnavailable: "Thinking selection is unavailable for this Codex server.", inputUnavailable: "This conversation cannot accept direct input.", send: "Send", running: "Running…", reconnecting: "Reconnecting…", reconnect: "Reconnect", rename: "Rename", save: "Save", resetName: "Restore automatic name", threadNamePlaceholder: "Local thread name", language: "Switch language", server: "server",
  },
  "zh-CN": { ...chineseWorkspaceMessages,
    setup: "Codex 设置", firstLaunch: "首次启动设置", detectingCli: "正在检测 Codex CLI…", detectingDetails: "正在检查配置的可执行文件、已保存选择、PATH 和 Windows 已知安装位置。", cliFound: "已找到 Codex CLI", version: "版本", chooseProjectBeforeConnect: "请先选择项目目录再连接。", workingDirectory: "工作目录", chooseWorkingDirectory: "选择工作目录", connectVerify: "连接并验证", connecting: "正在连接 Codex…", connectingDetails: "正在启动本地 app-server 并验证协议。", setupAttention: "Codex 设置需要处理", retryDetection: "重新检测", chooseCli: "选择 Codex CLI", chooseAnotherCli: "选择其他 CLI", detectAgain: "再次检测", workspace: "工作区", threads: "线程", refresh: "刷新", syncNow: "同步会话历史", syncing: "正在同步会话历史…", syncedAt: (value) => `已于 ${value} 同步到本地`, partialHistory: "当前 Codex 版本仅返回部分历史。", syncFailed: "会话历史同步失败。", loading: "加载中…", waitingConnection: "等待 Codex 连接。", noThreads: "暂无可用线程。", loadingThreads: "正在加载线程…", conversation: "会话", selectThread: "选择线程", chooseThread: "选择一个线程以查看线性会话。", loadingConversation: "正在加载会话…", noReadableTurns: "没有可读回合", noConversationContent: "该线程没有可用的会话内容。", searchLoadedTurns: "搜索已加载回合", searchPlaceholder: "搜索已加载历史…", onlyLoaded: "仅搜索已加载回合。", match: (count) => `${count} 个匹配`, outline: "大纲", turns: (count) => `${count} 个回合`, turn: (index) => `回合 ${index}`, role: (role) => role === "user" ? "用户" : role === "assistant" ? "助手" : "系统", connectionStatus: "连接状态", selectedConversation: "选中线程会话", backToHistory: "返回会话历史", questionOutline: "问答目录", noQuestions: "暂无可读问题。", connectionState: (state) => ({ idle: "空闲", connecting: "连接中", ready: "就绪", error: "错误", stopped: "已停止" }[state]), goToTurn: (index, label) => `跳转到回合 ${index}：${label}`, loadEarlier: "加载更早回合", loadingEarlier: "正在加载更早回合…", noMore: "没有更多已加载回合。", noReadableItems: "该回合没有提供可读项目。", tool: "工具", status: "状态", sendMessage: "发送消息", inputPlaceholder: "输入纯文本回合…", starting: "正在启动…", ready: "就绪", turnRunning: "回合运行中…", remoteTurnRunning: "此会话正在回复中。", refreshStatus: "刷新会话状态", pauseUnavailable: "当前 Codex 服务端不支持暂停回合。", model: "模型", reasoning: "思考", codexDefault: "使用 Codex 默认设置", modelUnavailable: "当前 Codex 服务端不支持模型选择。", reasoningUnavailable: "当前 Codex 服务端不支持思考强度选择。", inputUnavailable: "此会话不能接受直接输入。", send: "发送", running: "运行中…", reconnecting: "正在重新连接…", reconnect: "重新连接", rename: "重命名", save: "保存", resetName: "恢复自动命名", threadNamePlaceholder: "本地线程名称", language: "切换语言", server: "服务端",
  },
};
