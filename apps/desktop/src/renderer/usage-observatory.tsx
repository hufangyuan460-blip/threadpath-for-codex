import { useEffect, useState } from "react";
import type { Language, ThreadBranch } from "../shared/api";
import type { ThreadObservatoryState } from "../shared/observatory";
import type { TokenUsageBreakdown } from "../../../../threadpath-protocol/src/token-usage";

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  return `${Number((value / divisor).toFixed(1))}${divisor === 1_000 ? "K" : "M"}`;
}

export function UsageObservatory({ threadId, branch, language }: { threadId: string; branch: ThreadBranch | undefined; language: Language }): React.JSX.Element {
  const [state, setState] = useState<ThreadObservatoryState>();
  useEffect(() => {
    let active = true;
    const accept = (incoming: ThreadObservatoryState): void => {
      if (!active || incoming.threadId !== threadId) return;
      setState((current) => current !== undefined && current.threadId === threadId && current.revision > incoming.revision ? current : incoming);
    };
    const unsubscribe = window.threadPath.onObservatoryUpdate(accept);
    void window.threadPath.getThreadObservatory(threadId).then(accept).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [threadId]);
  const zh = language === "zh-CN";
  const current = state?.threadId === threadId ? state : undefined;
  const usage = current?.usage;
  const compactions = current?.compactions ?? [];
  const cumulative = zh ? "累计 Token" : "Cumulative Tokens";
  const windowLabel = zh ? "模型报告窗口" : "Model-reported window";
  const unknown = zh ? "未知" : "Unknown";
  const exact = (value: number): string => value.toLocaleString(language);
  const number = (value: number | null | undefined): React.JSX.Element => <span title={value == null ? unknown : exact(value)}>{value == null ? unknown : formatTokenCount(value)}</span>;
  const fields: readonly [keyof TokenUsageBreakdown, string][] = [
    ["totalTokens", "total"], ["inputTokens", "input"], ["cachedInputTokens", "cached input"],
    ["cacheWriteInputTokens", "cache write"], ["outputTokens", "output"], ["reasoningOutputTokens", "reasoning output"],
  ];
  const breakdown = (value: TokenUsageBreakdown): React.JSX.Element => <dl className="usage-breakdown">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{exact(value[key])}</dd></div>)}</dl>;
  const status = (value: string): string => zh ? ({ started: "进行中", completed: "已完成", unknown: "状态未知" }[value] ?? unknown) : value;
  return <details className="usage-observatory" data-usage-thread-id={threadId}>
    <summary><strong>Token Usage</strong><span>{cumulative} {number(usage?.total.totalTokens)}</span><span>{windowLabel} {number(usage?.modelContextWindow)}</span><span>{zh ? "压缩（已观察）" : "Compactions (observed)"} {current === undefined ? unknown : compactions.length}</span>{usage?.stale ? <span>stale</span> : null}</summary>
    <div className="usage-details">
      <p>{zh ? "服务器报告的 Token Usage，不代表精确上下文占用。" : "Server-reported Token Usage; not exact context occupancy."}</p>
      {branch?.threadId === threadId && branch.sourceThreadId && branch.forkTurnId ? <p className="usage-fork-warning" role="note">{zh ? "累计用量可能包含从源会话继承的历史。" : "Cumulative usage may include history inherited from the source conversation."}</p> : null}
      {usage == null ? <p className="usage-empty">{zh ? "暂无服务器用量数据" : "No server usage data yet"}</p> : <>
        <h3>{cumulative}</h3>{breakdown(usage.total)}
        <h3>{zh ? "最近服务器快照" : "Latest server snapshot"}</h3>{breakdown(usage.last)}
        <dl className="usage-breakdown">
          <div><dt>{windowLabel}</dt><dd>{usage.modelContextWindow === null ? unknown : exact(usage.modelContextWindow)}</dd></div>
          <div><dt>{zh ? "更新时间" : "Updated"}</dt><dd><time dateTime={usage.receivedAt}>{new Date(usage.receivedAt).toLocaleString(language)}</time></dd></div>
          <div><dt>{zh ? "状态 / 来源" : "Status / source"}</dt><dd>{usage.stale ? "stale / " : ""}{usage.source}</dd></div>
          <div><dt>{zh ? "服务器关联回合" : "Reported turn"}</dt><dd>{usage.reportedTurnId}</dd></div>
        </dl>
      </>}
      {current?.usageError === undefined ? null : <p className="usage-invalid">{zh ? "服务器用量字段无效，等待有效快照。" : "Invalid server usage fields; waiting for a valid snapshot."}</p>}
      <h3>{zh ? "压缩（已观察）" : "Compactions (observed)"}: {compactions.length}</h3>
      <p>{zh ? "仅含当前读取的历史项与本次运行收到的事件；历史项无生命周期状态。" : "Only history items read and events received in this run; history items have no lifecycle status."}</p>
      <ul className="usage-compactions">{compactions.map((item) => <li key={`${item.turnId}:${item.itemId}`} data-compaction-id={item.itemId}><span>{status(item.status)}</span> · {item.source} · {item.turnId} · {item.itemId}</li>)}</ul>
    </div>
  </details>;
}
