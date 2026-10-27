---
id: "TIP-20261026-codex-null-fork"
title: "Codex 状态数据库列表的 null fork 来源不能否定分支关系"
keywords: ["Codex", "thread/list", "useStateDbOnly", "forkedFromId", "null", "thread/read", "metadata-only", "fork身份", "历史验收"]
status: active
created: 2026-10-26
source: pi-desktop
---

M6-C2 在 CLI 0.163.0-alpha.11（SHA-256 00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c）的三条专用归档线程上实测：thread/list(useStateDbOnly:true) 均返回 forkedFromId:null，但 thread/read(includeTurns:false) 能返回两个分支的实际来源，且 turns 为空。索引投影的 null 不能推断“不是 fork”，更不能按列表首项或时间猜测祖先。安全验收先以专用 cwd、归档筛选、执行时间窗口和唯一 ID 确认候选组，只给候选 metadata-only 读取权限，来源链匹配后才开放正文读取。此次仅修正验收工具，不修改业务语义；该结论限于已测版本和样本。证据：docs/m6-c2-real-history-acceptance.md；apps/desktop/scripts/real-history-acceptance.ts（validateThreadGroup、identifyThreads、readOnlyBoundary）；对应安全测试。
