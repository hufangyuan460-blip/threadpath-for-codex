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

function isActiveWriterMessage(error: unknown): boolean {
  return /active writer|already responding|active_writer/i.test(errorMessage(error));
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
      <input id="turn-search" type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={onKeyDown} placeholder={m.searchPlaceholder} />
      {error === undefined && query.trim() !== "" ? <p className="search-count">{m.match(results.length)}</p> : null}
      {error === undefined ? null : <p className="error-summary">{error}</p>}
      {results.length === 0 ? null : <ol className="search-results">{results.map((result, index) => <li key={result.turnId}><button type="button" className={`search-result${index === selectedIndex ? " selected" : ""}`} onClick={() => onNavigate(result.turnId)}><strong>{result.label}</strong><small>{result.matchKind} · {result.snippet}</small></button></li>)}</ol>}
    </section>
  );
}

function ThreadDirectory({ thread, activeTurnId, query, results, selectedIndex, error, onQueryChange, onSearchKeyDown, onNavigate, onBack, onRename, editing, editingName, onEditingNameChange, onSaveName, setOutlineButton, m }: { thread: ConversationThreadView | undefined; activeTurnId: string | undefined; query: string; results: readonly SearchResult[]; selectedIndex: number; error: string | undefined; onQueryChange: (query: string) => void; onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; onNavigate: (turnId: string) => void; onBack: () => void; onRename: () => void; editing: boolean; editingName: string; onEditingNameChange: (name: string) => void; onSaveName: (name: string | null) => void; setOutlineButton: (turnId: string, element: HTMLButtonElement | null) => void; m: Messages }): React.JSX.Element {
  return (
    <div className="thread-directory">
      <button className="back-history" type="button" onClick={onBack}>← {m.backToHistory}</button>
      <div className="directory-title-row"><h2 className="directory-title" title={thread?.title}>{thread?.title ?? m.loadingConversation}</h2>{thread === undefined ? null : <button className="directory-rename" type="button" onClick={onRename} aria-label={`${m.rename}: ${thread.title}`}>{m.rename}</button>}</div>
      {editing && thread !== undefined ? <form className="thread-name-editor directory-name-editor" onSubmit={(event) => { event.preventDefault(); onSaveName(editingName); }}><input autoFocus value={editingName} onChange={(event) => onEditingNameChange(event.target.value)} placeholder={m.threadNamePlaceholder} /><button type="submit">{m.save}</button><button type="button" onClick={() => onSaveName(null)}>{m.resetName}</button></form> : null}
      <SearchPanel query={query} results={results} selectedIndex={selectedIndex} error={error} onQueryChange={onQueryChange} onKeyDown={onSearchKeyDown} onNavigate={onNavigate} m={m} />
      <div className="directory-heading"><p className="eyebrow">{m.questionOutline}</p><span>{m.turns(thread?.outline.length ?? 0)}</span></div>
      {thread?.outline.length === 0 ? <p className="panel-note">{m.noQuestions}</p> : <ol className="outline-list directory-list">
        {thread?.outline.map((entry) => <li key={entry.turnId}><button ref={(element) => setOutlineButton(entry.turnId, element)} type="button" className={`outline-entry${entry.turnId === activeTurnId ? " active" : ""}`} onClick={() => onNavigate(entry.turnId)} aria-current={entry.turnId === activeTurnId ? "true" : undefined} aria-label={m.goToTurn(entry.index, entry.label)}><span className="outline-index">{String(entry.index).padStart(2, "0")}</span><span className="outline-copy"><strong>{entry.label}</strong><small>{entry.status}</small></span></button></li>)}
      </ol>}
    </div>
  );
}

function Conversation({ thread, activeTurnId, loadingMore, loadMoreError, onLoadMore, onNavigate, onVisibleTurn, onUserScroll, m, onNavigateReady, onRefreshStatus }: { thread: ConversationThreadView; activeTurnId: string | undefined; loadingMore: boolean; loadMoreError: string | undefined; onLoadMore: () => void; onNavigate: (turnId: string) => void; onVisibleTurn: (turnId: string | undefined) => void; onUserScroll: () => void; m: Messages; onNavigateReady: (navigate: NavigateTurn | undefined) => void; onRefreshStatus: () => void }): React.JSX.Element {
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
  const statusLabel = thread.remoteActive ? m.remoteTurnRunning : thread.canAcceptDirectInput === false ? m.inputUnavailable : undefined;
  useEffect(() => {
    onNavigateReady(navigate);
    return () => onNavigateReady(undefined);
  }, [thread.id, thread.turns, onNavigateReady]);
  const onRangeChanged = (range: ListRange): void => onVisibleTurn(chooseActiveTurnIdFromRange(thread.turns.map((turn) => turn.id), range));
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
      <div className="conversation" aria-label={m.conversation}>
        <div className="conversation-heading"><div><h2>{thread.title}</h2></div><div className="conversation-heading-actions">{thread.remoteActive ? <button className="refresh-status" type="button" onClick={onRefreshStatus} aria-label={m.refreshStatus} title={m.refreshStatus}>↻</button> : null}{statusLabel === undefined ? null : <span className="thread-status">{statusLabel}</span>}</div></div>
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
  const [draftByThreadId, setDraftByThreadId] = useState<Record<string, string>>({});
  const [sendErrorByThreadId, setSendErrorByThreadId] = useState<Record<string, string | undefined>>({});
  const [startingTurn, setStartingTurn] = useState(false);
  const [runningTurnByThreadId, setRunningTurnByThreadId] = useState<Record<string, string | undefined>>({});
  const [remoteActiveByThreadId, setRemoteActiveByThreadId] = useState<Record<string, boolean>>({});
  const [editingThreadId, setEditingThreadId] = useState<string | undefined>();
  const [editingThreadName, setEditingThreadName] = useState("");
  const [navigateToTurn, setNavigateToTurn] = useState<NavigateTurn | undefined>();
  const seenUpdateKeys = useRef(new Set<string>());
  const navigationTarget = useRef<string | undefined>(undefined);
  const outlineButtons = useRef(new Map<string, HTMLButtonElement>());
  const threadListElement = useRef<HTMLDivElement | null>(null);
  const threadListScrollTop = useRef(0);
  const inputElement = useRef<HTMLTextAreaElement | null>(null);
  const m = messages[language];
  const inputText = selectedThreadId === undefined ? "" : draftByThreadId[selectedThreadId] ?? "";
  const sendError = selectedThreadId === undefined ? undefined : sendErrorByThreadId[selectedThreadId];
  const localRunningTurnId = selectedThreadId === undefined ? undefined : runningTurnByThreadId[selectedThreadId];
  const remoteActive = selectedThreadId !== undefined && (remoteActiveByThreadId[selectedThreadId] === true || selectedThread?.remoteActive === true);
  const inputUnavailable = selectedThread?.canAcceptDirectInput === false;
  const turnIsRunning = startingTurn || localRunningTurnId !== undefined || remoteActive;

  const setInputText = (text: string): void => {
    if (selectedThreadId === undefined) return;
    setDraftByThreadId((current) => ({ ...current, [selectedThreadId]: text }));
  };

  const loadThreads = useCallback(async (): Promise<void> => {
    setThreadLoadState("loading");
    setThreadError(undefined);
    try {
      const nextThreads = await window.threadPath.listThreads();
      setThreads(nextThreads);
      setThreadLoadState(nextThreads.length === 0 ? "empty" : "ready");
      setSelectedThreadId((current) => current !== undefined && nextThreads.some((thread) => thread.id === current) ? current : undefined);
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
    catch (error: unknown) {
      if (selectedThreadId !== undefined) setSendErrorByThreadId((current) => ({ ...current, [selectedThreadId]: errorMessage(error) }));
    }
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
      setSendErrorByThreadId({});
      setRunningTurnByThreadId({});
      setRemoteActiveByThreadId({});
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
      setLoadingMore(false);
      setLoadMoreError(undefined);
      setNavigateToTurn(() => undefined);
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
    setLoadingMore(false);
    setLoadMoreError(undefined);
    setSelectedThreadState("loading");
    setSelectedThreadError(undefined);
    void window.threadPath.readThread(selectedThreadId).then((thread) => {
      if (!active) return;
      setSelectedThread(thread);
      setRemoteActiveByThreadId((current) => ({ ...current, [thread.id]: thread.remoteActive === true }));
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
    if (selectedThreadId === undefined && threadListElement.current !== null) threadListElement.current.scrollTop = threadListScrollTop.current;
  }, [selectedThreadId, threads.length]);

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
    const element = inputElement.current;
    if (element === null) return;
    element.style.height = "auto";
    const nextHeight = Math.min(110, Math.max(46, element.scrollHeight));
    element.style.height = `${nextHeight}px`;
  }, [inputText]);

  useEffect(() => {
    if (activeTurnId === undefined) return;
    const button = outlineButtons.current.get(activeTurnId);
    if (button === undefined) return;
    const panel = button.closest<HTMLElement>(".thread-directory");
    if (panel === null) return;
    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (buttonRect.top < panelRect.top || buttonRect.bottom > panelRect.bottom) {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      button.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    }
  }, [activeTurnId, selectedThread?.outline]);

  useEffect(() => window.threadPath.onConversationUpdate((update: ConversationUpdate) => {
    if (update.type === "turn/started") setRemoteActiveByThreadId((current) => ({ ...current, [update.threadId]: true }));
    if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
      setRunningTurnByThreadId((current) => {
        if (current[update.threadId] !== update.turnId) return current;
        const next = { ...current };
        delete next[update.threadId];
        return next;
      });
      setRemoteActiveByThreadId((current) => ({ ...current, [update.threadId]: false }));
    }
    if (selectedThreadId === undefined || update.threadId !== selectedThreadId) return;
    if (seenUpdateKeys.current.has(conversationUpdateKey(update))) return;
    seenUpdateKeys.current.add(conversationUpdateKey(update));
    setSelectedThread((current) => current === undefined ? current : applyConversationUpdate(current, update));
  }), [selectedThreadId]);

  const handleStartTurn = async (): Promise<void> => {
    const text = inputText.trim();
    if (selectedThreadId === undefined || connectionState.state !== "ready" || text === "" || turnIsRunning) return;
    const threadId = selectedThreadId;
    if (inputUnavailable) return;
    setSendErrorByThreadId((current) => { const next = { ...current }; delete next[threadId]; return next; });
    setStartingTurn(true);
    try {
      const result = await window.threadPath.startTurn(threadId, text);
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
      setRunningTurnByThreadId((current) => ({ ...current, [result.threadId]: result.turnId }));
      setDraftByThreadId((current) => { const next = { ...current }; delete next[threadId]; return next; });
    } catch (error: unknown) {
      const currentThreadId = selectedThreadId;
      if (currentThreadId !== undefined && isActiveWriterMessage(error)) {
        setRemoteActiveByThreadId((current) => ({ ...current, [currentThreadId]: true }));
        setSelectedThread((current) => current?.id === currentThreadId ? { ...current, remoteActive: true } : current);
        setSendErrorByThreadId((current) => ({ ...current, [currentThreadId]: m.remoteTurnRunning }));
      } else if (currentThreadId !== undefined) {
        setSendErrorByThreadId((current) => ({ ...current, [currentThreadId]: errorMessage(error) }));
      }
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

  const handleNavigateReady = useCallback((navigate: NavigateTurn | undefined): void => {
    setNavigateToTurn(() => navigate);
  }, []);

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true);
    try { setConnectionState(await window.threadPath.reconnect()); }
    catch (error: unknown) { setConnectionState({ state: "error", error: errorMessage(error) }); }
    finally { setReconnecting(false); }
  };

  const handleRefreshStatus = async (): Promise<void> => {
    if (selectedThreadId === undefined) return;
    try {
      const refreshed = await window.threadPath.readThread(selectedThreadId);
      setSelectedThread(refreshed);
      setRemoteActiveByThreadId((current) => ({ ...current, [refreshed.id]: refreshed.remoteActive === true }));
      setSendErrorByThreadId((current) => { const next = { ...current }; delete next[selectedThreadId]; return next; });
    } catch (error: unknown) {
      setSendErrorByThreadId((current) => ({ ...current, [selectedThreadId]: errorMessage(error) }));
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div><h1>ThreadPath for Codex</h1></div>
        <div className="topbar-actions"><div className="status" aria-label={m.connectionStatus}><span className={`status-dot status-${connectionState.state}`} />{m.connectionState(connectionState.state)}{connectionState.serverVersion === undefined ? null : <span className="status-meta">{m.server} {connectionState.serverVersion}</span>}</div><button className="language-switch" type="button" onClick={() => void handleLanguageChange()} aria-label={m.language}>{language === "zh-CN" ? "EN" : "中文"}</button></div>
      </header>
      <Onboarding snapshot={onboardingState} onRediscover={() => void handleRediscover()} onChooseExecutable={() => void handleChooseExecutable()} onChooseDirectory={() => void handleChooseDirectory()} onConnect={() => void handleOnboardingConnect()} m={m} />
      <section className="workspace" aria-label={m.workspace}>
        <aside className="thread-panel">
          {selectedThreadId !== undefined ? <ThreadDirectory thread={selectedThread} activeTurnId={activeTurnId} query={searchQuery} results={searchResults} selectedIndex={selectedSearchIndex} error={searchError} onQueryChange={setSearchQuery} onSearchKeyDown={(event) => handleSearchKeyDown(event, (turnId) => navigateToTurn?.(turnId))} onNavigate={(turnId) => navigateToTurn?.(turnId)} onBack={() => setSelectedThreadId(undefined)} onRename={() => { const current = threads.find((thread) => thread.id === selectedThreadId); if (current !== undefined) beginRename(current); }} editing={editingThreadId === selectedThreadId} editingName={editingThreadName} onEditingNameChange={setEditingThreadName} onSaveName={(name) => void saveThreadName(selectedThreadId, name)} setOutlineButton={setOutlineButton} m={m} /> : <>
            <div className="panel-heading"><div><p className="eyebrow">{m.workspace}</p><h2>{m.threads}</h2></div><button type="button" onClick={() => void loadThreads()} disabled={connectionState.state !== "ready" || threadLoadState === "loading"}>{threadLoadState === "loading" ? m.loading : m.refresh}</button></div>
            {threadLoadState === "idle" ? <p className="panel-note">{m.waitingConnection}</p> : null}
            {threadLoadState === "error" ? <p className="error-summary">{threadError}</p> : null}
            {threadLoadState === "empty" ? <p className="panel-note">{m.noThreads}</p> : null}
            {threads.length === 0 && threadLoadState === "loading" ? <p className="panel-note">{m.loadingThreads}</p> : null}
            <div ref={threadListElement} className="thread-list" role="listbox" aria-label={m.threads} onScroll={(event) => { threadListScrollTop.current = event.currentTarget.scrollTop; }}>{threads.map((thread) => <div className="thread-row-wrap" key={thread.id}><button className={`thread-row${thread.id === selectedThreadId ? " selected" : ""}`} type="button" role="option" aria-selected={thread.id === selectedThreadId} onClick={() => setSelectedThreadId(thread.id)} onDoubleClick={() => beginRename(thread)}><span className="thread-title">{thread.title}</span></button><button className="thread-edit" type="button" onClick={() => beginRename(thread)} aria-label={`${m.rename}: ${thread.title}`}>{m.rename}</button>{editingThreadId === thread.id ? <form className="thread-name-editor" onSubmit={(event) => { event.preventDefault(); void saveThreadName(thread.id, editingThreadName); }}><input autoFocus value={editingThreadName} onChange={(event) => setEditingThreadName(event.target.value)} placeholder={m.threadNamePlaceholder} /><button type="submit">{m.save}</button><button type="button" onClick={() => void saveThreadName(thread.id, null)}>{m.resetName}</button></form> : null}</div>)}</div>
          </>}
        </aside>
        <section className="details-panel" aria-label={m.selectedConversation}>
          {selectedThreadState === "idle" ? <div className="details-empty"><p className="empty-kicker">{m.conversation}</p><h2>{m.selectThread}</h2><p>{m.chooseThread}</p></div> : null}
          {selectedThreadState === "loading" ? <p className="panel-note">{m.loadingConversation}</p> : null}
          {selectedThreadState === "error" ? <p className="error-summary">{selectedThreadError}</p> : null}
          {(selectedThreadState === "empty" || selectedThreadState === "ready") && selectedThread !== undefined ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={() => void handleLoadMore()} onNavigate={handleNavigate} onVisibleTurn={handleVisibleTurn} onUserScroll={handleUserScroll} m={m} onNavigateReady={handleNavigateReady} onRefreshStatus={() => void handleRefreshStatus()} /> : null}
          {selectedThread !== undefined && selectedThreadState !== "loading" && selectedThreadState !== "error" ? (
            <form className="turn-composer" onSubmit={(event) => { event.preventDefault(); void handleStartTurn(); }}>
              <div className="composer-input">
                <textarea ref={inputElement} id="turn-input" aria-label={m.sendMessage} value={inputText} onChange={(event) => setInputText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleStartTurn(); } }} placeholder={m.inputPlaceholder} rows={1} disabled={connectionState.state !== "ready" || turnIsRunning || inputUnavailable} />
                <span className="composer-status" aria-live="polite">{startingTurn ? m.starting : remoteActive ? m.remoteTurnRunning : inputUnavailable ? m.inputUnavailable : localRunningTurnId === undefined ? null : m.turnRunning}</span>
                <button className="composer-send" type="submit" aria-label={turnIsRunning ? m.pauseUnavailable : inputUnavailable ? m.inputUnavailable : m.send} title={turnIsRunning ? m.pauseUnavailable : inputUnavailable ? m.inputUnavailable : m.send} disabled={connectionState.state !== "ready" || inputText.trim() === "" || turnIsRunning || inputUnavailable}><span aria-hidden="true">{turnIsRunning ? "Ⅱ" : "➤"}</span><span className="sr-only">{turnIsRunning ? m.pauseUnavailable : inputUnavailable ? m.inputUnavailable : m.send}</span></button>
              </div>
              {sendError === undefined ? null : <p className="error-summary">{sendError}</p>}
            </form>
          ) : null}
        </section>
      </section>
      <footer className={`footer${connectionState.state === "error" || connectionState.state === "stopped" || connectionState.error !== undefined ? " visible" : ""}`}><span>{appInfo === undefined ? "ThreadPath" : `ThreadPath ${appInfo.version}`}</span>{connectionState.state === "error" || connectionState.state === "stopped" ? <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>{reconnecting ? m.reconnecting : m.reconnect}</button> : null}{connectionState.error === undefined ? null : <span className="footer-error">{connectionState.error}</span>}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
