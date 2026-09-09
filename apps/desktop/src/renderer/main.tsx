import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AppInfo, ConnectionStateSnapshot, ConversationItemView, ConversationThreadView, ConversationUpdate, ThreadListItem } from "../shared/api";
import { applyConversationUpdate, conversationUpdateKey } from "./conversation-state";
import { chooseActiveTurnId } from "./scroll-state";

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

function scrollToTurn(turnId: string): boolean {
  const target = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].find((element) => element.dataset.turnId === turnId);
  if (target === undefined) return false;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  return true;
}

function Conversation({ thread, activeTurnId, onNavigate, setOutlineButton }: { thread: ConversationThreadView; activeTurnId: string | undefined; onNavigate: (turnId: string) => void; setOutlineButton: (turnId: string, element: HTMLButtonElement | null) => void }): React.JSX.Element {
  if (thread.turns.length === 0) {
    return <div className="conversation-empty"><p className="empty-kicker">Conversation</p><h2>No readable turns</h2><p>This thread has no conversation content available.</p></div>;
  }
  return (
    <div className="conversation-layout">
      <nav className="outline-panel" aria-label="Turn outline">
        <div className="outline-heading"><p className="empty-kicker">Outline</p><span>{thread.outline.length} turns</span></div>
        <ol className="outline-list">
          {thread.outline.map((entry) => (
            <li key={entry.turnId}>
              <button ref={(element) => setOutlineButton(entry.turnId, element)} type="button" className={`outline-entry${entry.turnId === activeTurnId ? " active" : ""}`} onClick={() => onNavigate(entry.turnId)} aria-current={entry.turnId === activeTurnId ? "true" : undefined} aria-label={`Go to turn ${entry.index}: ${entry.label}`}>
                <span className="outline-index">{entry.index}</span><span className="outline-copy"><strong>{entry.label}</strong><small>{entry.status}</small></span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
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
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const [inputText, setInputText] = useState("");
  const [startingTurn, setStartingTurn] = useState(false);
  const [runningTurnId, setRunningTurnId] = useState<string | undefined>();
  const [sendError, setSendError] = useState<string | undefined>();
  const seenUpdateKeys = useRef(new Set<string>());
  const navigationTarget = useRef<string | undefined>(undefined);
  const outlineButtons = useRef(new Map<string, HTMLButtonElement>());

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
      navigationTarget.current = undefined;
      setActiveTurnId(undefined);
      setRunningTurnId(undefined);
      return;
    }
    let active = true;
    seenUpdateKeys.current.clear();
    navigationTarget.current = undefined;
    setActiveTurnId(undefined);
    setRunningTurnId(undefined);
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

  useEffect(() => {
    if (selectedThread === undefined) {
      setActiveTurnId(undefined);
      return;
    }
    let frame = 0;
    const updateActiveTurn = (): void => {
      frame = 0;
      const cards = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")];
      const snapshots = cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return { turnId: card.dataset.turnId ?? "", top: rect.top, bottom: rect.bottom };
      }).filter((item) => item.turnId !== "");
      const target = navigationTarget.current;
      if (target !== undefined && snapshots.some((item) => item.turnId === target)) {
        setActiveTurnId(target);
        return;
      }
      setActiveTurnId(chooseActiveTurnId(snapshots, 0, window.innerHeight));
    };
    const scheduleUpdate = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(updateActiveTurn);
    };
    const clearProgrammaticTarget = (): void => {
      navigationTarget.current = undefined;
      scheduleUpdate();
    };
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("wheel", clearProgrammaticTarget, { passive: true });
    window.addEventListener("touchstart", clearProgrammaticTarget, { passive: true });
    window.addEventListener("scrollend", scheduleUpdate);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleUpdate);
    for (const card of document.querySelectorAll<HTMLElement>("[data-turn-id]")) resizeObserver?.observe(card);
    scheduleUpdate();
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("wheel", clearProgrammaticTarget);
      window.removeEventListener("touchstart", clearProgrammaticTarget);
      window.removeEventListener("scrollend", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [selectedThread]);

  useEffect(() => {
    if (activeTurnId === undefined) return;
    const button = outlineButtons.current.get(activeTurnId);
    if (button === undefined) return;
    const panel = button.closest<HTMLElement>(".outline-panel");
    if (panel === null) return;
    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (buttonRect.top < panelRect.top || buttonRect.bottom > panelRect.bottom) {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      button.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    }
  }, [activeTurnId, selectedThread?.outline]);

  useEffect(() => window.threadPath.onConversationUpdate((update: ConversationUpdate) => {
    if (selectedThreadId === undefined || update.threadId !== selectedThreadId) return;
    if (seenUpdateKeys.current.has(conversationUpdateKey(update))) return;
    seenUpdateKeys.current.add(conversationUpdateKey(update));
    if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
      setRunningTurnId((current) => current === update.turnId ? undefined : current);
    }
    setSelectedThread((current) => current === undefined ? current : applyConversationUpdate(current, update));
  }), [selectedThreadId]);

  const handleStartTurn = async (): Promise<void> => {
    const text = inputText.trim();
    if (selectedThreadId === undefined || connectionState.state !== "ready" || text === "" || startingTurn || runningTurnId !== undefined) return;
    setSendError(undefined);
    setStartingTurn(true);
    try {
      const result = await window.threadPath.startTurn(selectedThreadId, text);
      setSelectedThread((current) => {
        if (current === undefined || current.id !== result.threadId) return current;
        const turnId = result.turnId;
        if (current.turns.some((turn) => turn.id === turnId)) return current;
        return { ...current, turns: [...current.turns, { id: turnId, index: current.turns.length + 1, status: "running", createdAt: new Date().toISOString(), items: [{ kind: "text", id: `${turnId}:user`, role: "user", text }] }] };
      });
      setRunningTurnId(result.turnId);
      setInputText("");
    } catch (error: unknown) {
      setSendError(errorMessage(error));
    } finally {
      setStartingTurn(false);
    }
  };

  const handleNavigate = useCallback((turnId: string): void => {
    if (!scrollToTurn(turnId)) return;
    navigationTarget.current = turnId;
    setActiveTurnId(turnId);
  }, []);

  const setOutlineButton = useCallback((turnId: string, element: HTMLButtonElement | null): void => {
    if (element === null) outlineButtons.current.delete(turnId);
    else outlineButtons.current.set(turnId, element);
  }, []);

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
          {selectedThreadState === "empty" && selectedThread !== undefined ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} onNavigate={handleNavigate} setOutlineButton={setOutlineButton} /> : null}
          {selectedThreadState === "ready" && selectedThread !== undefined ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} onNavigate={handleNavigate} setOutlineButton={setOutlineButton} /> : null}
          {selectedThread !== undefined && selectedThreadState !== "loading" && selectedThreadState !== "error" ? (
            <form className="turn-composer" onSubmit={(event) => { event.preventDefault(); void handleStartTurn(); }}>
              <label htmlFor="turn-input">Send a message</label>
              <textarea id="turn-input" value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder="Write a plain-text turn…" rows={3} disabled={connectionState.state !== "ready" || startingTurn || runningTurnId !== undefined} />
              <div className="composer-footer"><span className="composer-status">{startingTurn ? "Starting…" : runningTurnId === undefined ? "Ready" : "Turn running…"}</span><button type="submit" disabled={connectionState.state !== "ready" || inputText.trim() === "" || startingTurn || runningTurnId !== undefined}>{startingTurn ? "Starting…" : runningTurnId === undefined ? "Send" : "Running…"}</button></div>
              {sendError === undefined ? null : <p className="error-summary">{sendError}</p>}
            </form>
          ) : null}
        </section>
      </section>
      <footer className="footer"><span>{appInfo === undefined ? "ThreadPath" : `ThreadPath ${appInfo.version}`}</span>{connectionState.state === "error" || connectionState.state === "stopped" ? <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>{reconnecting ? "Reconnecting…" : "Reconnect"}</button> : null}{connectionState.error === undefined ? null : <span className="footer-error">{connectionState.error}</span>}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
