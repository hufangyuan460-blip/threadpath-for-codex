---
id: "TIP-20261026-account-usage-read-token-usage"
title: "account/usage/read 的线程估算不能替代 Token Usage 通知"
keywords: ["account/usage/read", "threadId", "ThreadUsage", "ThreadTokenUsage", "Token Usage", "估算", "modelContextWindow", "notification", "Observatory", "只读验收"]
status: active
created: 2026-10-26
source: pi-desktop
---

M6-C4 在 Codex CLI 0.163.0-alpha.11（SHA-256 00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c）的当前生成 schema 中确认：account/usage/read 支持可选 threadId；省略会请求账户级数据，必须限定已验证的测试线程 ID，不能以账户级查询作自动 fallback。返回 ThreadUsage 是 estimated credits 与分组 token 统计，不是 thread/tokenUsage/updated 中的 ThreadTokenUsage(total/last/modelContextWindow)；不能将组总数、估算费用或缺省值包装成通知、精确回合计费或上下文占用。本次对三条已确认归档线程的 thread-scoped 查询都未提供可用 threadUsage，实际只读窗口也没有 Usage 通知；缺省/空估算不等于零用量或 null context window。实时通知、resume重放、fork继承和compaction生命周期因此仍需独立活动证据，不能由历史item、schema、fixture或本地派生信封补作真实PASS。相关代码：apps/desktop/scripts/real-observatory-acceptance.ts（observatoryReadBoundary严格限定唯一threadId、估算仅记录结构且不保存金额）；证据与授权边界：docs/m6-c4-real-observatory-acceptance.md。
