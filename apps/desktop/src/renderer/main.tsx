import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import "./styles.css";
import type { AppInfo, ConnectionStateSnapshot, ConversationItemView, ConversationThreadView, ConversationUpdate, OnboardingSnapshot, SearchResult, ThreadListItem } from "../shared/api";
import { applyConversationUpdate, conversationUpdateKey } from "./conversation-state";
import { buildTurnOutline } from "../shared/outline";
import { chooseActiveTurnIdFromRange } from "./scroll-state";
import { moveSearchSelection, searchNavigationTarget } from "./search-navigation";

type LoadState = "idle" | "loading" | "ready" | "empty" | "error";
type NavigateTurn = (turnId: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Onboarding({ snapshot, onRediscover, onChooseExecutable, onChooseDirectory, onConnect }: { snapshot: OnboardingSnapshot; onRediscover: () => void; onChooseExecutable: () => void; onChooseDirectory: () => void; onConnect: () => void }): React.JSX.Element | null {
  if (snapshot.state === "ready") return null;
  const hasExecutable = snapshot.executablePath !== undefined;
  return (
    <section className="onboarding-card" aria-label="Codex setup">
      <p className="empty-kicker">First launch setup</p>
      {snapshot.state === "detecting" ? <><h2>Detecting Codex CLI…</h2><p>Checking the configured executable, saved choice, PATH, and known Windows install locations.</p></> : null}
      {snapshot.state === "found" ? <><h2>Codex CLI found</h2><p>Version: <strong>{snapshot.version ?? "unknown"}</strong></p><p className="mono">{snapshot.executablePath}</p>{snapshot.cwd === undefined ? <><p>Choose a project directory before connecting.</p><button type="button" onClick={onChooseDirectory}>Choose working directory</button></> : <><p className="mono">Working directory: {snapshot.cwd}</p><button type="button" onClick={onConnect}>Connect and verify</button></>}</> : null}
      {snapshot.state === "connecting" ? <><h2>Connecting to Codex…</h2><p>Starting the local app-server and validating the protocol.</p></> : null}
      {snapshot.state === "error" ? <><h2>Codex setup needs attention</h2><p className="error-summary">{snapshot.error ?? "Codex CLI could not be configured."}</p><div className="onboarding-actions"><button type="button" onClick={onRediscover}>Retry detection</button><button type="button" onClick={onChooseExecutable}>Choose Codex CLI</button>{hasExecutable ? <button type="button" onClick={onChooseDirectory}>Choose working directory</button> : null}</div></> : null}
      {snapshot.state === "found" && hasExecutable ? <div className="onboarding-actions"><button type="button" onClick={onChooseExecutable}>Choose another CLI</button><button type="button" onClick={onRediscover}>Detect again</button></div> : null}
    </section>
  );
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

function SearchPanel({ query, results, selectedIndex, error, onQueryChange, onKeyDown, onNavigate }: { query: string; results: readonly SearchResult[]; selectedIndex: number; error: string | undefined; onQueryChange: (query: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; onNavigate: (turnId: string) => void }): React.JSX.Element {
  return (
    <section className="search-panel" aria-label="Search loaded turns">
      <label htmlFor="turn-search">Search loaded turns</label>
      <input id="turn-search" type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Search this thread…" />
      <p className="search-note">Only loaded turns are searched.</p>
      {error === undefined && query.trim() !== "" ? <p className="search-count">{results.length} match{results.length === 1 ? "" : "es"}</p> : null}
      {error === undefined ? null : <p className="error-summary">{error}</p>}
      {results.length === 0 ? null : <ol className="search-results">{results.map((result, index) => <li key={result.turnId}><button type="button" className={`search-result${index === selectedIndex ? " selected" : ""}`} onClick={() => onNavigate(result.turnId)}><strong>{result.label}</strong><small>{result.matchKind} · {result.snippet}</small></button></li>)}</ol>}
    </section>
  );
}

function Conversation({ thread, activeTurnId, searchQuery, searchResults, selectedSearchIndex, searchError, loadingMore, loadMoreError, onLoadMore, onSearchQueryChange, onSearchKeyDown, onNavigate, onVisibleTurn, onUserScroll, setOutlineButton }: { thread: ConversationThreadView; activeTurnId: string | undefined; searchQuery: string; searchResults: readonly SearchResult[]; selectedSearchIndex: number; searchError: string | undefined; loadingMore: boolean; loadMoreError: string | undefined; onLoadMore: () => void; onSearchQueryChange: (query: string) => void; onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, navigate: NavigateTurn) => void; onNavigate: (turnId: string) => void; onVisibleTurn: (turnId: string | undefined) => void; onUserScroll: () => void; setOutlineButton: (turnId: string, element: HTMLButtonElement | null) => void }): React.JSX.Element {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const turnIndexById = new Map(thread.turns.map((turn, index) => [turn.id, index]));
  const navigate = (turnId: string): void => {
    const index = turnIndexById.get(turnId);
    if (index === undefined) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: reducedMotion ? "auto" : "smooth" });
    onNavigate(turnId);
  };
  const onRangeChanged = (range: ListRange): void => onVisibleTurn(chooseActiveTurnIdFromRange(thread.turns.map((turn) => turn.id), range));
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => onSearchKeyDown(event, navigate);
  const setScroller = (element: HTMLElement | Window | null): void => {
    if (scroller.current !== null) {
      scroller.current.removeEventListener("wheel", onUserScroll);
      scroller.current.removeEventListener("touchstart", onUserScroll);
    }
    if (element instanceof HTMLElement) {
      scroller.current = element;
      element.addEventListener("wheel", onUserScroll, { passive: true });
      element.addEventListener("touchstart", onUserScroll, { passive: true });
    } else scroller.current = null;
  };
  return (
    <div className="conversation-layout">
      <nav className="outline-panel" aria-label="Turn outline">
        <SearchPanel query={searchQuery} results={searchResults} selectedIndex={selectedSearchIndex} error={searchError} onQueryChange={onSearchQueryChange} onKeyDown={handleSearchKeyDown} onNavigate={navigate} />
        <div className="outline-heading"><p className="empty-kicker">Outline</p><span>{thread.outline.length} turns</span></div>
        <ol className="outline-list">
          {thread.outline.map((entry) => (
            <li key={entry.turnId}>
              <button ref={(element) => setOutlineButton(entry.turnId, element)} type="button" className={`outline-entry${entry.turnId === activeTurnId ? " active" : ""}`} onClick={() => navigate(entry.turnId)} aria-current={entry.turnId === activeTurnId ? "true" : undefined} aria-label={`Go to turn ${entry.index}: ${entry.label}`}>
                <span className="outline-index">{entry.index}</span><span className="outline-copy"><strong>{entry.label}</strong><small>{entry.status}</small></span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="conversation" aria-label="Conversation">
        <div className="conversation-heading"><div><p className="empty-kicker">Conversation</p><h2>{thread.title}</h2></div><span className="thread-status">{thread.status}</span></div>
        <div className="pagination-controls">
          {thread.paging.hasMore ? <button type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading earlier turns…" : "Load earlier turns"}</button> : <span className="panel-note">No more loaded turns.</span>}
          {loadMoreError === undefined ? null : <p className="error-summary">{loadMoreError}</p>}
        </div>
        {thread.turns.length === 0 ? <div className="conversation-empty"><p className="empty-kicker">Conversation</p><h2>No readable turns</h2><p>This thread has no conversation content available.</p></div> : null}
        {thread.turns.length === 0 ? <div className="conversation-empty"><p className="empty-kicker">Conversation</p><h2>No readable turns</h2><p>This thread has no conversation content available.</p></div> : <Virtuoso<ConversationThreadView["turns"][number]>
          ref={virtuosoRef}
          data={thread.turns}
          computeItemKey={(_, turn) => turn.id}
          firstItemIndex={thread.paging.firstItemIndex}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          rangeChanged={onRangeChanged}
          scrollerRef={setScroller}
          className="turn-virtual-list"
          itemContent={(_, turn) => (
            <article className="turn-card" data-turn-id={turn.id} key={turn.id}>
              <header className="turn-heading">
                <div><span className="turn-index">Turn {turn.index}</span><span className="turn-status">{turn.status}</span></div>
                {turn.createdAt === undefined ? null : <time dateTime={turn.createdAt}>{turn.createdAt}</time>}
              </header>
              {turn.items.length === 0 ? <p className="partial-note">No readable items were provided for this turn.</p> : <div className="turn-items">{turn.items.map((item) => <ConversationItem item={item} key={item.id} />)}</div>}
            </article>
          )}
        />}
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [onboardingState, setOnboardingState] = useState<OnboardingSnapshot>({ state: "detecting" });
  const [connectionState, setConnectionState] = useState<ConnectionStateSnapshot>({ state: "idle" });
  const [reconnecting, setReconnecting] = useState(false);
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [threadLoadState, setThreadLoadState] = useState<LoadState>("idle");
  const [threadError, setThreadError] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [selectedThread, setSelectedThread] = useState<ConversationThreadView | undefined>();
  const [selectedThreadState, setSelectedThreadState] = useState<LoadState>("idle");
  const [selectedThreadError, setSelectedThreadError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1);
  const [searchError, setSearchError] = useState<string | undefined>();
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
        const [info, onboarding, state] = await Promise.all([window.threadPath.getAppInfo(), window.threadPath.getOnboardingState(), window.threadPath.getConnectionState()]);
        if (!active) return;
        setAppInfo(info);
        setOnboardingState(onboarding);
        setConnectionState(state);
      } catch (error: unknown) {
        if (active) setConnectionState({ state: "error", error: errorMessage(error) });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const handleRediscover = async (): Promise<void> => {
    setOnboardingState({ state: "detecting" });
    try { setOnboardingState(await window.threadPath.rediscoverCodex()); }
    catch (error: unknown) { setOnboardingState({ state: "error", error: errorMessage(error) }); }
  };

  const handleChooseExecutable = async (): Promise<void> => {
    try { setOnboardingState(await window.threadPath.chooseCodexExecutable()); }
    catch (error: unknown) { setOnboardingState({ state: "error", error: errorMessage(error) }); }
  };

  const handleChooseDirectory = async (): Promise<void> => {
    try { setOnboardingState(await window.threadPath.chooseWorkingDirectory()); }
    catch (error: unknown) { setOnboardingState({ state: "error", error: errorMessage(error) }); }
  };

  const handleOnboardingConnect = async (): Promise<void> => {
    try { setConnectionState(await window.threadPath.connect()); }
    catch (error: unknown) { setOnboardingState((current) => ({ ...current, state: "error", error: errorMessage(error) })); }
  };

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
      setSearchQuery("");
      setSearchResults([]);
      setSelectedSearchIndex(-1);
      setSearchError(undefined);
      setRunningTurnId(undefined);
      setLoadingMore(false);
      setLoadMoreError(undefined);
      return;
    }
    let active = true;
    seenUpdateKeys.current.clear();
    setSearchQuery("");
    setSearchResults([]);
    setSelectedSearchIndex(-1);
    setSearchError(undefined);
    navigationTarget.current = undefined;
    setActiveTurnId(undefined);
    setRunningTurnId(undefined);
    setLoadingMore(false);
    setLoadMoreError(undefined);
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
    if (selectedThreadId === undefined || searchQuery.trim() === "") {
      setSearchResults([]);
      setSelectedSearchIndex(-1);
      setSearchError(undefined);
      return;
    }
    let active = true;
    setSearchError(undefined);
    const timer = window.setTimeout(() => {
      void window.threadPath.searchTurns(selectedThreadId, searchQuery).then((results) => {
        if (!active) return;
        setSearchResults(results);
        setSelectedSearchIndex(results.length === 0 ? -1 : 0);
      }).catch((error: unknown) => {
        if (!active) return;
        setSearchResults([]);
        setSelectedSearchIndex(-1);
        setSearchError(errorMessage(error));
      });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedThreadId, searchQuery, selectedThread]);

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
        const newTurn: ConversationThreadView["turns"][number] = { id: turnId, index: current.turns.length + 1, status: "running", createdAt: new Date().toISOString(), items: [{ kind: "text", id: `${turnId}:user`, role: "user", text }] };
        const turns = [...current.turns, newTurn];
        return { ...current, turns, outline: buildTurnOutline(turns), paging: { ...current.paging, orderedTurnIds: turns.map((item) => item.id) } };
      });
      setRunningTurnId(result.turnId);
      setInputText("");
    } catch (error: unknown) {
      setSendError(errorMessage(error));
    } finally {
      setStartingTurn(false);
    }
  };

  const handleLoadMore = async (): Promise<void> => {
    if (selectedThreadId === undefined || loadingMore || selectedThread?.paging.hasMore !== true) return;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const nextThread = await window.threadPath.loadMoreTurns(selectedThreadId);
      setSelectedThread((current) => current?.id === nextThread.id ? nextThread : current);
    } catch (error: unknown) {
      setLoadMoreError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleVisibleTurn = useCallback((turnId: string | undefined): void => {
    if (turnId === undefined) return;
    const target = navigationTarget.current;
    if (target !== undefined && target !== turnId) return;
    navigationTarget.current = undefined;
    setActiveTurnId(turnId);
  }, []);

  const handleUserScroll = useCallback((): void => {
    navigationTarget.current = undefined;
  }, []);

  const handleNavigate = useCallback((turnId: string): void => {
    if (selectedThread?.turns.some((turn) => turn.id === turnId) !== true) return;
    navigationTarget.current = turnId;
    setActiveTurnId(turnId);
  }, [selectedThread]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, navigate: NavigateTurn): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSearchIndex((current) => moveSearchSelection(current, searchResults.length, "next"));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSearchIndex((current) => moveSearchSelection(current, searchResults.length, "previous"));
    } else if (event.key === "Enter") {
      const turnId = searchNavigationTarget(searchResults, selectedSearchIndex);
      if (turnId !== undefined) {
        event.preventDefault();
        navigate(turnId);
      }
    }
  };

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
      <Onboarding snapshot={onboardingState} onRediscover={() => void handleRediscover()} onChooseExecutable={() => void handleChooseExecutable()} onChooseDirectory={() => void handleChooseDirectory()} onConnect={() => void handleOnboardingConnect()} />
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
          {(selectedThreadState === "empty" || selectedThreadState === "ready") && selectedThread !== undefined ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} searchQuery={searchQuery} searchResults={searchResults} selectedSearchIndex={selectedSearchIndex} searchError={searchError} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={() => void handleLoadMore()} onSearchQueryChange={setSearchQuery} onSearchKeyDown={handleSearchKeyDown} onNavigate={handleNavigate} onVisibleTurn={handleVisibleTurn} onUserScroll={handleUserScroll} setOutlineButton={setOutlineButton} /> : null}
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
