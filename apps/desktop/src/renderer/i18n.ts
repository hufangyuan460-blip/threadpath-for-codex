import type { Language } from "../shared/api";

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
  readonly threads: string;
  readonly refresh: string;
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
}

export const messages: Record<Language, Messages> = {
  "en-US": {
    setup: "Codex setup", firstLaunch: "First launch setup", detectingCli: "Detecting Codex CLI…", detectingDetails: "Checking the configured executable, saved choice, PATH, and known Windows install locations.", cliFound: "Codex CLI found", version: "Version", chooseProjectBeforeConnect: "Choose a project directory before connecting.", workingDirectory: "Working directory", chooseWorkingDirectory: "Choose working directory", connectVerify: "Connect and verify", connecting: "Connecting to Codex…", connectingDetails: "Starting the local app-server and validating the protocol.", setupAttention: "Codex setup needs attention", retryDetection: "Retry detection", chooseCli: "Choose Codex CLI", chooseAnotherCli: "Choose another CLI", detectAgain: "Detect again", workspace: "Workspace", threads: "Threads", refresh: "Refresh", loading: "Loading…", waitingConnection: "Waiting for the Codex connection.", noThreads: "No threads are available.", loadingThreads: "Loading threads…", conversation: "Conversation", selectThread: "Select a thread", chooseThread: "Choose a thread to read its linear conversation.", loadingConversation: "Loading conversation…", noReadableTurns: "No readable turns", noConversationContent: "This thread has no conversation content available.", searchLoadedTurns: "Search loaded turns", searchPlaceholder: "Search this thread…", onlyLoaded: "Only loaded turns are searched.", match: (count) => `${count} match${count === 1 ? "" : "es"}`, outline: "Outline", turns: (count) => `${count} turn${count === 1 ? "" : "s"}`, turn: (index) => `Turn ${index}`, role: (role) => role === "user" ? "User" : role === "assistant" ? "Assistant" : "System", connectionStatus: "Connection status", selectedConversation: "Selected thread conversation", goToTurn: (index, label) => `Go to turn ${index}: ${label}`, loadEarlier: "Load earlier turns", loadingEarlier: "Loading earlier turns…", noMore: "No more loaded turns.", noReadableItems: "No readable items were provided for this turn.", tool: "Tool", status: "Status", sendMessage: "Send a message", inputPlaceholder: "Write a plain-text turn…", starting: "Starting…", ready: "Ready", turnRunning: "Turn running…", send: "Send", running: "Running…", reconnecting: "Reconnecting…", reconnect: "Reconnect", rename: "Rename", save: "Save", resetName: "Restore automatic name", threadNamePlaceholder: "Local thread name", language: "Switch language", server: "server",
  },
  "zh-CN": {
    setup: "Codex 设置", firstLaunch: "首次启动设置", detectingCli: "正在检测 Codex CLI…", detectingDetails: "正在检查配置的可执行文件、已保存选择、PATH 和 Windows 已知安装位置。", cliFound: "已找到 Codex CLI", version: "版本", chooseProjectBeforeConnect: "请先选择项目目录再连接。", workingDirectory: "工作目录", chooseWorkingDirectory: "选择工作目录", connectVerify: "连接并验证", connecting: "正在连接 Codex…", connectingDetails: "正在启动本地 app-server 并验证协议。", setupAttention: "Codex 设置需要处理", retryDetection: "重新检测", chooseCli: "选择 Codex CLI", chooseAnotherCli: "选择其他 CLI", detectAgain: "再次检测", workspace: "工作区", threads: "线程", refresh: "刷新", loading: "加载中…", waitingConnection: "等待 Codex 连接。", noThreads: "暂无可用线程。", loadingThreads: "正在加载线程…", conversation: "会话", selectThread: "选择线程", chooseThread: "选择一个线程以查看线性会话。", loadingConversation: "正在加载会话…", noReadableTurns: "没有可读回合", noConversationContent: "该线程没有可用的会话内容。", searchLoadedTurns: "搜索已加载回合", searchPlaceholder: "搜索当前线程…", onlyLoaded: "仅搜索已加载回合。", match: (count) => `${count} 个匹配`, outline: "大纲", turns: (count) => `${count} 个回合`, turn: (index) => `回合 ${index}`, role: (role) => role === "user" ? "用户" : role === "assistant" ? "助手" : "系统", connectionStatus: "连接状态", selectedConversation: "选中线程会话", goToTurn: (index, label) => `跳转到回合 ${index}：${label}`, loadEarlier: "加载更早回合", loadingEarlier: "正在加载更早回合…", noMore: "没有更多已加载回合。", noReadableItems: "该回合没有提供可读项目。", tool: "工具", status: "状态", sendMessage: "发送消息", inputPlaceholder: "输入纯文本回合…", starting: "正在启动…", ready: "就绪", turnRunning: "回合运行中…", send: "发送", running: "运行中…", reconnecting: "正在重新连接…", reconnect: "重新连接", rename: "重命名", save: "保存", resetName: "恢复自动命名", threadNamePlaceholder: "本地线程名称", language: "切换语言", server: "服务端",
  },
};
