import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AppInfo, ConnectionStateSnapshot, ConversationItemView, ConversationThreadView, ThreadListItem } from "../shared/api";

type LoadState = "idle" | "loading" | "ready" | "empty" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ConversationItem({ item }: { item: ConversationItemView }): React.JSX.Element {
  if (item.kind === "tool") {
    return (
      <div className="conversation-item tool-item">
        <div className="item-heading"><span className="item-label">Tool</span><strong>{item.name}</strong><span className={`tool-status tool-${item.status}`}>{item.status}</span></div>
        {item.summary === undefined ? null : <p>{item.summary}</p>}
      </div>
    );
  }
  if (item.kind === "status") {
    return <div className="conversation-item status-item"><span className="item-label">Status</span><p>{item.text}</p></div>;
  }
  return <div className={`conversation-item text-item role-${item.role}`}><span className="item-label">{item.role}</span><p>{item.text}</p></div>;
}

function Conversation({ thread }: { thread: ConversationThreadView }): React.JSX.Element {
  if (thread.turns.length === 0) {
    return <div className="conversation-empty"><p className="empty-kicker">Conversation</p><h2>No readable turns</h2><p>This thread has no conversation content available.</p></div>;
  }
  return (
    <div className="conversation" aria-label="Conversation">
      <div className="conversation-heading"><div><p className="empty-kicker">Conversation</p><h2>{thread.title}</h2></div><span className="thread-status">{thread.status}</span></div>
      {thread.turns.map((turn) => (
        <article className="turn-card" data-turn-id={turn.id} key={turn.id}>
          <header className="turn-heading">
            <div><span className="turn-index">Turn {turn.index}</span><span className="turn-status">{turn.status}</span></div>
            {turn.createdAt === undefined ? null : <time dateTime={turn.createdAt}>{turn.createdAt}</time>}
          </header>
          {turn.items.length === 0 ? <p className="partial-note">No readable items were provided for this turn.</p> : <div className="turn-items">{turn.items.map((item) => <ConversationItem item={item} key={item.id} />)}</div>}
        </article>
      ))}
    </div>
  );
}

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [connectionState, setConnectionState] = useState<ConnectionStateSnapshot>({ state: "idle" });
  const [reconnecting, setReconnecting] = useState(false);
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [threadLoadState, setThreadLoadState] = useState<LoadState>("idle");
  const [threadError, setThreadError] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [selectedThread, setSelectedThread] = useState<ConversationThreadView | undefined>();
  const [selectedThreadState, setSelectedThreadState] = useState<LoadState>("idle");
  const [selectedThreadError, setSelectedThreadError] = useState<string | undefined>();

  const loadThreads = useCallback(async (): Promise<void> => {
    setThreadLoadState("loading");
    setThreadError(undefined);
    try {
      const nextThreads = await window.threadPath.listThreads();
      setThreads(nextThreads);
      setThreadLoadState(nextThreads.length === 0 ? "empty" : "ready");
      setSelectedThreadId((current) => current !== undefined && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id);
    } catch (error: unknown) {
      setThreadLoadState("error");
      setThreadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [info, state] = await Promise.all([window.threadPath.getAppInfo(), window.threadPath.getConnectionState()]);
        if (!active) return;
        setAppInfo(info);
        setConnectionState(state);
      } catch (error: unknown) {
        if (active) setConnectionState({ state: "error", error: errorMessage(error) });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (connectionState.state === "ready") void loadThreads();
    else {
      setThreads([]);
      setSelectedThreadId(undefined);
      setSelectedThread(undefined);
      setThreadLoadState("idle");
    }
  }, [connectionState.state, loadThreads]);

  useEffect(() => {
    if (selectedThreadId === undefined) {
      setSelectedThread(undefined);
      setSelectedThreadState("idle");
      return;
    }
    let active = true;
    setSelectedThreadState("loading");
    setSelectedThreadError(undefined);
    void window.threadPath.readThread(selectedThreadId).then((thread) => {
      if (!active) return;
      setSelectedThread(thread);
      setSelectedThreadState(thread.turns.length === 0 ? "empty" : "ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setSelectedThreadState("error");
      setSelectedThreadError(errorMessage(error));
    });
    return () => { active = false; };
  }, [selectedThreadId]);

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true);
    try { setConnectionState(await window.threadPath.reconnect()); }
    catch (error: unknown) { setConnectionState({ state: "error", error: errorMessage(error) }); }
    finally { setReconnecting(false); }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">ThreadPath</p><h1>ThreadPath for Codex</h1></div>
        <div className="status" aria-label="Connection status"><span className={`status-dot status-${connectionState.state}`} />{connectionState.state}{connectionState.serverVersion === undefined ? null : <span className="status-meta">server {connectionState.serverVersion}</span>}</div>
      </header>
      <section className="workspace" aria-label="Thread workspace">
        <aside className="thread-panel">
          <div className="panel-heading"><div><p className="eyebrow">Workspace</p><h2>Threads</h2></div><button type="button" onClick={() => void loadThreads()} disabled={connectionState.state !== "ready" || threadLoadState === "loading"}>{threadLoadState === "loading" ? "Loading…" : "Refresh"}</button></div>
          {threadLoadState === "idle" ? <p className="panel-note">Waiting for the Codex connection.</p> : null}
          {threadLoadState === "error" ? <p className="error-summary">{threadError}</p> : null}
          {threadLoadState === "empty" ? <p className="panel-note">No threads are available.</p> : null}
          {threads.length === 0 && threadLoadState === "loading" ? <p className="panel-note">Loading threads…</p> : null}
          <div className="thread-list" role="listbox" aria-label="Threads">{threads.map((thread) => <button className={`thread-row${thread.id === selectedThreadId ? " selected" : ""}`} key={thread.id} type="button" role="option" aria-selected={thread.id === selectedThreadId} onClick={() => setSelectedThreadId(thread.id)}><span className="thread-title">{thread.title}</span><span className="thread-meta">{thread.status} · {thread.turnCount === null ? "—" : `${thread.turnCount} turns`}</span></button>)}</div>
        </aside>
        <section className="details-panel" aria-label="Selected thread conversation">
          {selectedThreadState === "idle" ? <div className="details-empty"><p className="empty-kicker">Conversation</p><h2>Select a thread</h2><p>Choose a thread to read its linear conversation.</p></div> : null}
          {selectedThreadState === "loading" ? <p className="panel-note">Loading conversation…</p> : null}
          {selectedThreadState === "error" ? <p className="error-summary">{selectedThreadError}</p> : null}
          {selectedThreadState === "empty" && selectedThread !== undefined ? <Conversation thread={selectedThread} /> : null}
          {selectedThreadState === "ready" && selectedThread !== undefined ? <Conversation thread={selectedThread} /> : null}
        </section>
      </section>
      <footer className="footer"><span>{appInfo === undefined ? "ThreadPath" : `ThreadPath ${appInfo.version}`}</span>{connectionState.state === "error" || connectionState.state === "stopped" ? <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>{reconnecting ? "Reconnecting…" : "Reconnect"}</button> : null}{connectionState.error === undefined ? null : <span className="footer-error">{connectionState.error}</span>}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
