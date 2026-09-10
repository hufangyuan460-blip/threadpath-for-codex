import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import "./styles.css";
import type { AppInfo, ConnectionStateSnapshot, ConversationItemView, ConversationThreadView, ConversationUpdate, OnboardingSnapshot, SearchResult, ThreadListItem, Language } from "../shared/api";
import { applyConversationUpdate, conversationUpdateKey } from "./conversation-state";
import { buildTurnOutline } from "../shared/outline";
import { chooseActiveTurnIdFromRange } from "./scroll-state";
import { moveSearchSelection, searchNavigationTarget } from "./search-navigation";
import { messages, type Messages } from "./i18n";

type LoadState = "idle" | "loading" | "ready" | "empty" | "error";
type NavigateTurn = (turnId: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Onboarding({ snapshot, onRediscover, onChooseExecutable, onChooseDirectory, onConnect, m }: { snapshot: OnboardingSnapshot; onRediscover: () => void; onChooseExecutable: () => void; onChooseDirectory: () => void; onConnect: () => void; m: Messages }): React.JSX.Element | null {
  if (snapshot.state === "ready") return null;
  const hasExecutable = snapshot.executablePath !== undefined;
  return (
    <section className="onboarding-card" aria-label={m.setup}>
      <p className="empty-kicker">{m.firstLaunch}</p>
      {snapshot.state === "detecting" ? <><h2>{m.detectingCli}</h2><p>{m.detectingDetails}</p></> : null}
      {snapshot.state === "found" ? <><h2>{m.cliFound}</h2><p>{m.version}: <strong>{snapshot.version ?? "unknown"}</strong></p><p className="mono">{snapshot.executablePath}</p>{snapshot.cwd === undefined ? <><p>{m.chooseProjectBeforeConnect}</p><button type="button" onClick={onChooseDirectory}>{m.chooseWorkingDirectory}</button></> : <><p className="mono">{m.workingDirectory}: {snapshot.cwd}</p><button type="button" onClick={onConnect}>{m.connectVerify}</button></>}</> : null}
      {snapshot.state === "connecting" ? <><h2>{m.connecting}</h2><p>{m.connectingDetails}</p></> : null}
      {snapshot.state === "error" ? <><h2>{m.setupAttention}</h2><p className="error-summary">{snapshot.error ?? m.setupAttention}</p><div className="onboarding-actions"><button type="button" onClick={onRediscover}>{m.retryDetection}</button><button type="button" onClick={onChooseExecutable}>{m.chooseCli}</button>{hasExecutable ? <button type="button" onClick={onChooseDirectory}>{m.chooseWorkingDirectory}</button> : null}</div></> : null}
      {snapshot.state === "found" && hasExecutable ? <div className="onboarding-actions"><button type="button" onClick={onChooseExecutable}>{m.chooseAnotherCli}</button><button type="button" onClick={onRediscover}>{m.detectAgain}</button></div> : null}
    </section>
  );
}

function ConversationItem({ item, m }: { item: ConversationItemView; m: Messages }): React.JSX.Element {
  if (item.kind === "tool") {
    return (
      <div className="conversation-item tool-item">
        <div className="item-heading"><span className="item-label">{m.tool}</span><strong>{item.name}</strong><span className={`tool-status tool-${item.status}`}>{item.status}</span></div>
        {item.summary === undefined ? null : <p>{item.summary}</p>}
      </div>
    );
  }
  if (item.kind === "status") {
    return <div className="conversation-item status-item"><span className="item-label">{m.status}</span><p>{item.text}</p></div>;
  }
  return <div className={`conversation-item text-item role-${item.role}`}><span className="item-label">{m.role(item.role)}</span><p>{item.text}</p></div>;
}

function SearchPanel({ query, results, selectedIndex, error, onQueryChange, onKeyDown, onNavigate, m }: { query: string; results: readonly SearchResult[]; selectedIndex: number; error: string | undefined; onQueryChange: (query: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; onNavigate: (turnId: string) => void; m: Messages }): React.JSX.Element {
  return (
    <section className="search-panel" aria-label={m.searchLoadedTurns}>
      <label htmlFor="turn-search">{m.searchLoadedTurns}</label>
      <input id="turn-search" type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={onKeyDown} placeholder={m.searchPlaceholder} />
      <p className="search-note">{m.onlyLoaded}</p>
      {error === undefined && query.trim() !== "" ? <p className="search-count">{m.match(results.length)}</p> : null}
      {error === undefined ? null : <p className="error-summary">{error}</p>}
      {results.length === 0 ? null : <ol className="search-results">{results.map((result, index) => <li key={result.turnId}><button type="button" className={`search-result${index === selectedIndex ? " selected" : ""}`} onClick={() => onNavigate(result.turnId)}><strong>{result.label}</strong><small>{result.matchKind} · {result.snippet}</small></button></li>)}</ol>}
    </section>
  );
}

function Conversation({ thread, activeTurnId, searchQuery, searchResults, selectedSearchIndex, searchError, loadingMore, loadMoreError, onLoadMore, onSearchQueryChange, onSearchKeyDown, onNavigate, onVisibleTurn, onUserScroll, setOutlineButton, m }: { thread: ConversationThreadView; activeTurnId: string | undefined; searchQuery: string; searchResults: readonly SearchResult[]; selectedSearchIndex: number; searchError: string | undefined; loadingMore: boolean; loadMoreError: string | undefined; onLoadMore: () => void; onSearchQueryChange: (query: string) => void; onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, navigate: NavigateTurn) => void; onNavigate: (turnId: string) => void; onVisibleTurn: (turnId: string | undefined) => void; onUserScroll: () => void; setOutlineButton: (turnId: string, element: HTMLButtonElement | null) => void; m: Messages }): React.JSX.Element {
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
      <nav className="outline-panel" aria-label={m.outline}>
        <SearchPanel query={searchQuery} results={searchResults} selectedIndex={selectedSearchIndex} error={searchError} onQueryChange={onSearchQueryChange} onKeyDown={handleSearchKeyDown} onNavigate={navigate} m={m} />
        <div className="outline-heading"><p className="empty-kicker">{m.outline}</p><span>{m.turns(thread.outline.length)}</span></div>
        <ol className="outline-list">
          {thread.outline.map((entry) => (
            <li key={entry.turnId}>
              <button ref={(element) => setOutlineButton(entry.turnId, element)} type="button" className={`outline-entry${entry.turnId === activeTurnId ? " active" : ""}`} onClick={() => navigate(entry.turnId)} aria-current={entry.turnId === activeTurnId ? "true" : undefined} aria-label={m.goToTurn(entry.index, entry.label)}>
                <span className="outline-index">{entry.index}</span><span className="outline-copy"><strong>{entry.label}</strong><small>{entry.status}</small></span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="conversation" aria-label={m.conversation}>
        <div className="conversation-heading"><div><p className="empty-kicker">{m.conversation}</p><h2>{thread.title}</h2></div><span className="thread-status">{thread.status}</span></div>
        <div className="pagination-controls">
          {thread.paging.hasMore ? <button type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? m.loadingEarlier : m.loadEarlier}</button> : <span className="panel-note">{m.noMore}</span>}
          {loadMoreError === undefined ? null : <p className="error-summary">{loadMoreError}</p>}
        </div>
        {thread.turns.length === 0 ? <div className="conversation-empty"><p className="empty-kicker">{m.conversation}</p><h2>{m.noReadableTurns}</h2><p>{m.noConversationContent}</p></div> : null}
        {thread.turns.length === 0 ? null : <Virtuoso<ConversationThreadView["turns"][number]>
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
                <div><span className="turn-index">{m.turn(turn.index)}</span><span className="turn-status">{turn.status}</span></div>
                {turn.createdAt === undefined ? null : <time dateTime={turn.createdAt}>{turn.createdAt}</time>}
              </header>
              {turn.items.length === 0 ? <p className="partial-note">{m.noReadableItems}</p> : <div className="turn-items">{turn.items.map((item) => <ConversationItem item={item} key={item.id} m={m} />)}</div>}
            </article>
          )}
        />}
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [language, setLanguage] = useState<Language>("en-US");
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
  const [editingThreadId, setEditingThreadId] = useState<string | undefined>();
  const [editingThreadName, setEditingThreadName] = useState("");
  const seenUpdateKeys = useRef(new Set<string>());
  const navigationTarget = useRef<string | undefined>(undefined);
  const outlineButtons = useRef(new Map<string, HTMLButtonElement>());
  const m = messages[language];

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
        setLanguage(info.language);
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

  const handleLanguageChange = async (): Promise<void> => {
    const nextLanguage: Language = language === "zh-CN" ? "en-US" : "zh-CN";
    try { setLanguage(await window.threadPath.setLanguage(nextLanguage)); }
    catch (error: unknown) { setSendError(errorMessage(error)); }
  };

  const beginRename = (thread: ThreadListItem): void => {
    setEditingThreadId(thread.id);
    setEditingThreadName(thread.title);
  };

  const saveThreadName = async (threadId: string, name: string | null): Promise<void> => {
    try {
      const update = await window.threadPath.setThreadDisplayName(threadId, name);
      setThreads((current) => current.map((thread) => thread.id === update.threadId ? { ...thread, title: update.title } : thread));
      setSelectedThread((current) => current?.id === update.threadId ? { ...current, title: update.title } : current);
      setEditingThreadId(undefined);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

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
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, title: thread.title, turnCount: thread.turns.length } : item));
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
      if (result.displayName !== undefined) {
        setThreads((current) => current.map((thread) => thread.id === result.threadId ? { ...thread, title: result.displayName ?? thread.title } : thread));
        setSelectedThread((current) => current?.id === result.threadId ? { ...current, title: result.displayName ?? current.title } : current);
      }
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
        <div className="topbar-actions"><div className="status" aria-label={m.connectionStatus}><span className={`status-dot status-${connectionState.state}`} />{connectionState.state}{connectionState.serverVersion === undefined ? null : <span className="status-meta">{m.server} {connectionState.serverVersion}</span>}</div><button className="language-switch" type="button" onClick={() => void handleLanguageChange()} aria-label={m.language}>{language === "zh-CN" ? "English" : "中文"}</button></div>
      </header>
      <Onboarding snapshot={onboardingState} onRediscover={() => void handleRediscover()} onChooseExecutable={() => void handleChooseExecutable()} onChooseDirectory={() => void handleChooseDirectory()} onConnect={() => void handleOnboardingConnect()} m={m} />
      <section className="workspace" aria-label={m.workspace}>
        <aside className="thread-panel">
          <div className="panel-heading"><div><p className="eyebrow">{m.workspace}</p><h2>{m.threads}</h2></div><button type="button" onClick={() => void loadThreads()} disabled={connectionState.state !== "ready" || threadLoadState === "loading"}>{threadLoadState === "loading" ? m.loading : m.refresh}</button></div>
          {threadLoadState === "idle" ? <p className="panel-note">{m.waitingConnection}</p> : null}
          {threadLoadState === "error" ? <p className="error-summary">{threadError}</p> : null}
          {threadLoadState === "empty" ? <p className="panel-note">{m.noThreads}</p> : null}
          {threads.length === 0 && threadLoadState === "loading" ? <p className="panel-note">{m.loadingThreads}</p> : null}
          <div className="thread-list" role="listbox" aria-label={m.threads}>{threads.map((thread) => <div className="thread-row-wrap" key={thread.id}><button className={`thread-row${thread.id === selectedThreadId ? " selected" : ""}`} type="button" role="option" aria-selected={thread.id === selectedThreadId} onClick={() => setSelectedThreadId(thread.id)} onDoubleClick={() => beginRename(thread)}><span className="thread-title">{thread.title}</span><span className="thread-meta">{thread.status} · {thread.turnCount === null ? "—" : `${thread.turnCount} ${m.turns(2).replace(/^\d+\s*/, "")}`}</span></button><button className="thread-edit" type="button" onClick={() => beginRename(thread)} aria-label={`${m.rename}: ${thread.title}`}>{m.rename}</button>{editingThreadId === thread.id ? <form className="thread-name-editor" onSubmit={(event) => { event.preventDefault(); void saveThreadName(thread.id, editingThreadName); }}><input autoFocus value={editingThreadName} onChange={(event) => setEditingThreadName(event.target.value)} placeholder={m.threadNamePlaceholder} /><button type="submit">{m.save}</button><button type="button" onClick={() => void saveThreadName(thread.id, null)}>{m.resetName}</button></form> : null}</div>)}</div>
        </aside>
        <section className="details-panel" aria-label={m.selectedConversation}>
          {selectedThreadState === "idle" ? <div className="details-empty"><p className="empty-kicker">{m.conversation}</p><h2>{m.selectThread}</h2><p>{m.chooseThread}</p></div> : null}
          {selectedThreadState === "loading" ? <p className="panel-note">{m.loadingConversation}</p> : null}
          {selectedThreadState === "error" ? <p className="error-summary">{selectedThreadError}</p> : null}
          {(selectedThreadState === "empty" || selectedThreadState === "ready") && selectedThread !== undefined ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} searchQuery={searchQuery} searchResults={searchResults} selectedSearchIndex={selectedSearchIndex} searchError={searchError} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={() => void handleLoadMore()} onSearchQueryChange={setSearchQuery} onSearchKeyDown={handleSearchKeyDown} onNavigate={handleNavigate} onVisibleTurn={handleVisibleTurn} onUserScroll={handleUserScroll} setOutlineButton={setOutlineButton} m={m} /> : null}
          {selectedThread !== undefined && selectedThreadState !== "loading" && selectedThreadState !== "error" ? (
            <form className="turn-composer" onSubmit={(event) => { event.preventDefault(); void handleStartTurn(); }}>
              <label htmlFor="turn-input">{m.sendMessage}</label>
              <textarea id="turn-input" value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder={m.inputPlaceholder} rows={3} disabled={connectionState.state !== "ready" || startingTurn || runningTurnId !== undefined} />
              <div className="composer-footer"><span className="composer-status">{startingTurn ? m.starting : runningTurnId === undefined ? m.ready : m.turnRunning}</span><button type="submit" disabled={connectionState.state !== "ready" || inputText.trim() === "" || startingTurn || runningTurnId !== undefined}>{startingTurn ? m.starting : runningTurnId === undefined ? m.send : m.running}</button></div>
              {sendError === undefined ? null : <p className="error-summary">{sendError}</p>}
            </form>
          ) : null}
        </section>
      </section>
      <footer className="footer"><span>{appInfo === undefined ? "ThreadPath" : `ThreadPath ${appInfo.version}`}</span>{connectionState.state === "error" || connectionState.state === "stopped" ? <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>{reconnecting ? m.reconnecting : m.reconnect}</button> : null}{connectionState.error === undefined ? null : <span className="footer-error">{connectionState.error}</span>}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
