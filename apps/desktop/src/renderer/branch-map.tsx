import { useEffect, useRef, useState } from "react";
import type { ConversationThreadView, ThreadBranch, ThreadListItem } from "../shared/api";
import { branchGraph } from "../shared/branch-graph";
import type { Messages } from "./i18n";

export function BranchMap({ branches, threads, selectedId, selectedThread, disabled, onSelect, onSource, m }: { branches: readonly ThreadBranch[]; threads: readonly ThreadListItem[]; selectedId: string; selectedThread: ConversationThreadView | undefined; disabled: boolean; onSelect: (id: string) => void; onSource: (branch: ThreadBranch) => void; m: Messages }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const graph = branchGraph(branches, selectedId);
  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  useEffect(() => {
    const container = scroll.current;
    if (container === null || selectedNode === undefined || !expanded) return;
    const left = selectedNode.x < container.scrollLeft ? selectedNode.x : Math.max(container.scrollLeft, selectedNode.x + 212 - container.clientWidth);
    const top = selectedNode.y < container.scrollTop ? selectedNode.y : Math.max(container.scrollTop, selectedNode.y + 128 - container.clientHeight);
    container.scrollTo({ left, top });
  }, [selectedId, selectedNode?.x, selectedNode?.y, expanded]);
  if (graph.nodes.length < 2) return null;
  const positions = new Map(graph.nodes.map((node) => [node.id, node]));
  const records = new Map(branches.map((branch) => [branch.threadId, branch]));
  return <section className="branch-map" aria-label={m.branchMap}>
    <div className="branch-map-heading"><h3>{m.branchMap}</h3><button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? m.hideBranches : m.showBranches}</button></div>
    {expanded ? <div className="branch-map-scroll" ref={scroll}><div className="branch-map-canvas" style={{ width: graph.width, height: graph.height }}>
      <svg width={graph.width} height={graph.height} className="branch-lines" aria-hidden="true">{graph.edges.map((edge) => {
        const source = positions.get(edge.source)!;
        const target = positions.get(edge.target)!;
        const x = source.x + 200;
        const y = source.y + 58;
        return <path key={edge.target} className={edge.onPath ? "on-path" : undefined} d={`M ${x} ${y} C ${x + 20} ${y}, ${target.x - 20} ${target.y + 58}, ${target.x} ${target.y + 58}`} />;
      })}</svg>
      {graph.nodes.map((node) => {
        const thread = threads.find((item) => item.id === node.id);
        const branch = records.get(node.id);
        const selected = node.id === selectedId;
        const current = selectedThread?.id === node.id ? selectedThread : undefined;
        const lastUser = current?.turns.flatMap((turn) => turn.items).filter((item) => item.kind === "text" && item.role === "user").at(-1);
        const preview = lastUser?.kind === "text" ? lastUser.text : branch?.forkLabel ?? thread?.preview ?? branches.find((item) => item.sourceThreadId === node.id)?.forkLabel;
        const source = branch === undefined ? undefined : threads.find((item) => item.id === branch.sourceThreadId);
        const sourceTitle = selectedThread !== undefined && selectedThread.id === branch?.sourceThreadId ? selectedThread.title : source?.title ?? m.sourceRoute;
        return <div key={node.id} className={`branch-node${selected ? " selected" : graph.pathIds.has(node.id) ? " on-path" : ""}`} style={{ left: node.x, top: node.y }}>
          <button className="branch-node-open" type="button" aria-current={selected ? "true" : undefined} aria-label={`${m.openRoute}: ${current?.title ?? thread?.title ?? m.sourceRoute}`} data-branch-thread-id={node.id} onClick={() => onSelect(node.id)} disabled={disabled}>
          <strong>{current?.title ?? thread?.title ?? m.sourceRoute}</strong>
          <span className="branch-preview" title={preview}>{preview ?? m.sourceRoute}</span>
          <small>{branch === undefined ? m.sourceRoute : m.readOnlyDiscussion}{current?.remoteActive || current?.writeState === "localTurnRunning" ? ` · ${m.running}` : ""}</small>
          </button>
          {branch === undefined ? null : <button type="button" className="branch-origin" data-branch-source-id={node.id} aria-label={m.returnToBranchPoint(sourceTitle, branch.forkLabel)} title={m.returnToBranchPoint(sourceTitle, branch.forkLabel)} onClick={() => onSource(branch)} disabled={disabled}>
            <span>{m.branchSource(sourceTitle)}</span><span>{m.branchSourceTurn(branch.forkLabel)}</span>
          </button>}
        </div>;
      })}
    </div></div> : null}
  </section>;
}
