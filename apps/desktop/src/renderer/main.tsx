import { Fragment, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import "./styles.css";
import type { AppInfo, ComposerOptions, ConnectionStateSnapshot, ConversationItemView, ConversationThreadView, ConversationUpdate, ModelOption, OnboardingSnapshot, SearchResult, ThreadListItem, Language, Theme, WorkspaceState } from "../shared/api";
import { applyConversationUpdate, conversationUpdateKey } from "./conversation-state";
import { buildTurnOutline } from "../shared/outline";
import { chooseActiveTurnIdFromRange } from "./scroll-state";
import { moveSearchSelection, searchNavigationTarget } from "./search-navigation";
import { messages, type Messages } from "./i18n";
import { MarkdownMessage } from "./markdown.tsx";
import { filterWorkspaceHistory, replaceThreadTitle, type HistoryViewFilter } from "../shared/workspace-state";
import { formatElapsedTime, type TurnTiming } from "./turn-timing.ts";
import { searchHistory, type HistorySearchResult } from "../shared/history-search";
import type { ThreadBranch } from "../shared/api";
import { BranchMap } from "./branch-map";
import { About } from "./about";
import { inheritedTurnIds, locateBranchPoint, type BranchPointTarget } from "./branch-navigation";

type LoadState = "idle" | "loading" | "ready" | "empty" | "error";
type NavigateTurn = (turnId: string) => void;
type HistoryFilter = HistoryViewFilter;
type HistorySort = "updated" | "name";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preferredModel(models: readonly ModelOption[]): ModelOption | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

function preferredReasoningEffort(model: ModelOption | undefined): string {
  if (model === undefined) return "";
  return model.supportedReasoningEfforts.find((effort) => effort.id === model.defaultReasoningEffort)?.id
    ?? model.supportedReasoningEfforts[0]?.id
    ?? "";
}

function timestamp(value: string | undefined): number { const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : 0; }
function compareThreads(left: ThreadListItem, right: ThreadListItem, sort: HistorySort): number {
  if ((left.favorite === true) !== (right.favorite === true)) return left.favorite === true ? -1 : 1;
  if (sort === "name") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  return updated !== 0 ? updated : left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}
function compareDirectories(left: WorkspaceState["directories"][number], right: WorkspaceState["directories"][number], sort: HistorySort): number {
  if ((left.favorite === true) !== (right.favorite === true)) return left.favorite === true ? -1 : 1;
  if (sort === "updated") {
    const latestLeft = Math.max(0, ...left.threads.map((thread) => timestamp(thread.updatedAt)));
    const latestRight = Math.max(0, ...right.threads.map((thread) => timestamp(thread.updatedAt)));
    if (latestLeft !== latestRight) return latestRight - latestLeft;
  }
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}
function formatHistoryTime(value: string | undefined, language: Language): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function isConfirmedActiveTurnMessage(error: unknown): boolean {
  return /confirmed active turn/i.test(errorMessage(error));
}

function isWorkspaceLockMessage(error: unknown): boolean {
  return /workspace.*(already|another|unknown)|state is unknown/i.test(errorMessage(error));
}

function Onboarding({ snapshot, onRediscover, onChooseExecutable, onChooseDirectory, onConnect, m }: { snapshot: OnboardingSnapshot; onRediscover: () => void; onChooseExecutable: () => void; onChooseDirectory: () => void; onConnect: () => void; m: Messages }): React.JSX.Element | null {
  if (snapshot.state === "ready") return null;
  const hasExecutable = snapshot.executablePath !== undefined;
  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
        <header className="onboarding-heading">
          <div className={`onboarding-state onboarding-state-${snapshot.state}`} aria-hidden="true"><span /></div>
          <div><p className="empty-kicker">{m.firstLaunch}</p><h2 id="onboarding-title">{snapshot.state === "error" ? m.setupAttention : snapshot.state === "found" ? m.cliFound : snapshot.state === "connecting" ? m.connecting : m.detectingCli}</h2></div>
        </header>
        <div className="onboarding-body" id="onboarding-description">
          {snapshot.state === "detecting" ? <p>{m.detectingDetails}</p> : null}
          {snapshot.state === "found" ? <><p>{m.version}: <strong>{snapshot.version ?? "unknown"}</strong></p><p className="onboarding-path mono">{snapshot.executablePath}</p>{snapshot.cwd === undefined ? <p>{m.chooseProjectBeforeConnect}</p> : <p className="onboarding-path mono">{m.workingDirectory}: {snapshot.cwd}</p>}</> : null}
          {snapshot.state === "connecting" ? <p>{m.connectingDetails}</p> : null}
          {snapshot.state === "error" ? <p className="error-summary">{snapshot.error ?? m.setupAttention}</p> : null}
        </div>
        {snapshot.state === "found" ? <div className="onboarding-actions"><button className="onboarding-secondary" type="button" onClick={onChooseExecutable}>{m.chooseAnotherCli}</button><button className="onboarding-secondary" type="button" onClick={onRediscover}>{m.detectAgain}</button><button className="onboarding-primary" type="button" onClick={snapshot.cwd === undefined ? onChooseDirectory : onConnect}>{snapshot.cwd === undefined ? m.chooseWorkingDirectory : m.connectVerify}</button></div> : null}
        {snapshot.state === "error" ? <div className="onboarding-actions"><button className="onboarding-primary" type="button" onClick={onRediscover}>{m.retryDetection}</button><button className="onboarding-secondary" type="button" onClick={onChooseExecutable}>{m.chooseCli}</button>{hasExecutable ? <button className="onboarding-secondary" type="button" onClick={onChooseDirectory}>{m.chooseWorkingDirectory}</button> : null}</div> : null}
      </section>
    </div>
  );
}

function ConversationItem({ item, markdown, m }: { item: ConversationItemView; markdown: boolean; m: Messages }): React.JSX.Element {
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
  return <div className={`conversation-item text-item role-${item.role}`}><span className="item-label">{m.role(item.role)}</span>{markdown && (item.role === "assistant" || item.role === "system") ? <MarkdownMessage text={item.text} m={m} /> : <p>{item.text}</p>}</div>;
}

function TurnItems({ items, timingLabel, m }: { items: readonly ConversationItemView[]; timingLabel: string | undefined; m: Messages }): React.JSX.Element {
  const assistantIndex = items.findIndex((item) => item.kind === "text" && item.role === "assistant");
  return <div className="turn-items">
    {assistantIndex !== -1 || timingLabel === undefined ? null : <span className="turn-elapsed">{timingLabel}</span>}
    {items.map((item, index) => <Fragment key={item.id}>
      {timingLabel === undefined || index !== assistantIndex ? null : <span className="turn-elapsed">{timingLabel}</span>}
      <ConversationItem item={item} markdown={item.kind === "text" && item.role !== "user" && item.phase === "final"} m={m} />
    </Fragment>)}
  </div>;
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

function WorkspaceSidebar({ state, loading, listElement, onScroll, onChoose, onSync, onSelectThread, onSetCurrent, onToggle, onRename, onMove, onSetThreadHidden, onSetWorkspaceHidden, onSetThreadFavorite, onSetWorkspaceFavorite, onSetThreadsHidden, onSetArchived, archiveBusy, runningThreadIds, onRevealThread, onRevealWorkspace, language, m }: { state: WorkspaceState | undefined; loading: boolean; listElement: React.RefObject<HTMLDivElement | null>; onScroll: (top: number) => void; onChoose: () => void; onSync: () => void; onSelectThread: (threadId: string) => void; onSetCurrent: (path: string) => void; onToggle: (path: string) => void; onRename: (thread: ThreadListItem) => void; onMove: (threadId: string, path: string | null) => void; onSetThreadHidden: (threadId: string, hidden: boolean) => void; onSetWorkspaceHidden: (path: string, hidden: boolean) => void; onSetThreadFavorite: (threadId: string, favorite: boolean) => void; onSetWorkspaceFavorite: (path: string, favorite: boolean) => void; onSetThreadsHidden: (threadIds: readonly string[], hidden: boolean) => Promise<void>; onSetArchived: (threadId: string, archived: boolean) => void; archiveBusy: boolean; runningThreadIds: readonly string[]; onRevealThread: (threadId: string, workspacePath: string | undefined) => Promise<void>; onRevealWorkspace: (path: string) => Promise<void>; language: Language; m: Messages }): React.JSX.Element {
  const [openMenuThreadId, setOpenMenuThreadId] = useState<string | undefined>();
  const [movingThreadId, setMovingThreadId] = useState<string | undefined>();
  const [openWorkspaceMenuPath, setOpenWorkspaceMenuPath] = useState<string | undefined>();
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySort, setHistorySort] = useState<HistorySort>("updated");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState<readonly string[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [focusedWorkspacePath, setFocusedWorkspacePath] = useState<string | undefined>();
  const workspaceGroupElements = useRef(new Map<string, HTMLElement>());
  const closeMenus = (): void => { setOpenMenuThreadId(undefined); setMovingThreadId(undefined); setOpenWorkspaceMenuPath(undefined); };
  const searchResults = searchHistory(state, historyQuery);
  const showingSearch = historyQuery.trim() !== "";
  const showHidden = historyFilter === "hidden";
  useEffect(() => {
    if (focusedWorkspacePath === undefined || showingSearch || showHidden) return;
    const element = workspaceGroupElements.current.get(focusedWorkspacePath);
    element?.scrollIntoView({ block: "nearest" });
    const timeout = window.setTimeout(() => setFocusedWorkspacePath(undefined), 900);
    return () => window.clearTimeout(timeout);
  }, [focusedWorkspacePath, showHidden, showingSearch, state]);
  const activateSearchResult = async (result: HistorySearchResult): Promise<void> => {
    closeMenus();
    if (result.kind === "thread") await onRevealThread(result.id, result.workspacePath);
    else {
      await onRevealWorkspace(result.id);
      setFocusedWorkspacePath(result.id);
    }
    setHistoryFilter("all");
    setHistoryQuery("");
  };
  const toggleThreadSelection = (threadId: string): void => setSelectedThreadIds((current) => current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId]);
  const renderThread = (thread: ThreadListItem, workspaceName = m.unclassified): React.JSX.Element => <div className="thread-row-wrap" key={thread.id}>
    {selectionMode ? <label className="thread-selection"><input type="checkbox" checked={selectedThreadIds.includes(thread.id)} onChange={() => toggleThreadSelection(thread.id)} aria-label={m.selectConversation(thread.title)} /></label> : null}
    <button className={`thread-row${selectionMode ? " selecting" : ""}`} type="button" onClick={() => { if (selectionMode) toggleThreadSelection(thread.id); else { closeMenus(); onSelectThread(thread.id); } }} title={thread.title}><span className="thread-title">{thread.favorite ? "★ " : ""}{thread.title}</span><span className="thread-meta">{workspaceName}{formatHistoryTime(thread.updatedAt, language) === undefined ? "" : ` · ${m.updated} ${formatHistoryTime(thread.updatedAt, language)}`}{thread.archived ? " · ◫" : ""}{thread.hidden ? " · ◉" : ""}</span></button>
    {selectionMode ? null : <button className="thread-actions-button" type="button" onClick={(event) => { event.stopPropagation(); setMovingThreadId(undefined); setOpenMenuThreadId((current) => current === thread.id ? undefined : thread.id); }} onKeyDown={(event) => { if (event.key === "Escape") closeMenus(); }} aria-label={`${m.threadActions}: ${thread.title}`} aria-expanded={openMenuThreadId === thread.id} aria-haspopup="menu">···</button>}
    {openMenuThreadId === thread.id ? <div className="thread-actions-menu" role="menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeMenus(); }}>
      <button type="button" role="menuitem" onClick={() => { closeMenus(); onRename(thread); }}>{m.rename}</button>
      <button type="button" role="menuitem" onClick={() => { closeMenus(); onSetThreadFavorite(thread.id, !thread.favorite); }}>{thread.favorite ? m.unfavoriteConversation : m.favoriteConversation}</button>
      <button type="button" role="menuitem" onClick={() => { setOpenMenuThreadId(undefined); setMovingThreadId(thread.id); }}>{m.moveToWorkspace}</button>
      <button type="button" role="menuitem" disabled={archiveBusy || runningThreadIds.includes(thread.id)} onClick={() => { closeMenus(); onSetArchived(thread.id, !thread.archived); }}>{thread.archived ? m.restoreConversation : m.archiveConversation}</button>
      <button type="button" role="menuitem" onClick={() => { closeMenus(); onSetThreadHidden(thread.id, !thread.hidden); }}>{thread.hidden ? m.showConversation : m.hideConversation}</button>
    </div> : null}
    {movingThreadId === thread.id ? <div className="thread-actions-menu workspace-choice-menu" role="menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeMenus(); }}>
      {state?.directories.filter((directory) => !directory.hidden).map((directory) => <button key={directory.path} type="button" role="menuitem" className={thread.workspacePath === directory.path ? "selected" : ""} onClick={() => { closeMenus(); onMove(thread.id, directory.path); }} title={directory.path}>📁 {directory.name}{thread.workspacePath === directory.path ? " ✓" : ""}</button>)}
      <button type="button" role="menuitem" className={thread.workspacePath === undefined ? "selected" : ""} onClick={() => { closeMenus(); onMove(thread.id, null); }}>{m.noWorkspace}{thread.workspacePath === undefined ? " ✓" : ""}</button>
    </div> : null}
  </div>;
  const renderGroup = (path: string, name: string, expanded: boolean, groupThreads: readonly ThreadListItem[], showThreads = true): React.JSX.Element => {
    const isWorkspace = !path.startsWith("__");
    return <section className={`workspace-group${focusedWorkspacePath === path ? " located" : ""}`} key={path} ref={isWorkspace ? (element) => { if (element === null) workspaceGroupElements.current.delete(path); else workspaceGroupElements.current.set(path, element); } : undefined}>
      <div className="workspace-group-row">
        {!isWorkspace ? <div className="workspace-toggle"><span aria-hidden="true">•</span><span aria-hidden="true">📁</span><span className="workspace-name" title={name}>{name}</span></div> : <button className="workspace-toggle" type="button" onClick={() => onToggle(path)} aria-expanded={expanded} aria-label={expanded ? m.collapseWorkspace : m.expandWorkspace}><span aria-hidden="true">{expanded ? "⌄" : "›"}</span><span aria-hidden="true">📁</span><span className="workspace-name" title={path}>{state?.directories.find((directory) => directory.path === path)?.favorite ? "★ " : ""}{name}</span></button>}
        {!isWorkspace ? null : <button className={`workspace-select${state?.currentPath === path ? " selected" : ""}`} type="button" onClick={() => onSetCurrent(path)} aria-label={`${m.workingDirectory}: ${name}`}>•</button>}
        {!isWorkspace ? null : <div className="workspace-actions"><button className="workspace-actions-button" type="button" onClick={() => { setOpenMenuThreadId(undefined); setMovingThreadId(undefined); setOpenWorkspaceMenuPath((current) => current === path ? undefined : path); }} aria-label={`${m.workspaceActions}: ${name}`} aria-expanded={openWorkspaceMenuPath === path} aria-haspopup="menu">···</button>{openWorkspaceMenuPath === path ? <div className="thread-actions-menu workspace-actions-menu" role="menu"><button type="button" role="menuitem" onClick={() => { closeMenus(); onSetWorkspaceFavorite(path, !(state?.directories.find((directory) => directory.path === path)?.favorite)); }}>{state?.directories.find((directory) => directory.path === path)?.favorite ? m.unfavoriteWorkspace : m.favoriteWorkspace}</button><button type="button" role="menuitem" onClick={() => { const hidden = state?.directories.find((directory) => directory.path === path)?.hidden === true; closeMenus(); onSetWorkspaceHidden(path, !hidden); }}>{state?.directories.find((directory) => directory.path === path)?.hidden === true ? m.showWorkspace : m.hideWorkspace}</button></div> : null}</div>}
      </div>
      {showThreads && expanded ? <div className="workspace-thread-list">{[...groupThreads].sort((left, right) => compareThreads(left, right, historySort)).map((thread) => renderThread(thread, name))}</div> : null}
    </section>;
  };
  const sync = state?.sync;
  const syncLabel = sync?.state === "syncing" ? m.syncing : sync?.state === "partial" ? m.partialHistory : sync?.state === "failed" ? m.syncFailed : sync?.syncedAt === undefined ? undefined : m.syncedAt(new Date(sync.syncedAt).toLocaleTimeString());
  const historyView = state === undefined ? undefined : filterWorkspaceHistory(state, historyFilter);
  const visibleDirectories = historyView?.directories ?? [];
  const visibleUnclassified = historyView?.unclassifiedThreads ?? [];
  const hasItems = visibleDirectories.length + visibleUnclassified.length > 0;
  const changeFilter = (filter: HistoryFilter): void => { closeMenus(); setHistoryFilter(filter); setSelectionMode(false); setSelectedThreadIds([]); };
  const applySelection = async (): Promise<void> => {
    if (selectedThreadIds.length === 0) return;
    await onSetThreadsHidden(selectedThreadIds, !showHidden);
    setSelectedThreadIds([]);
    setSelectionMode(false);
  };
  return <div className="workspace-history">
    <div className="panel-heading workspace-history-heading"><h2>{m.workspaceHistory}</h2><div className="workspace-history-actions"><button className="workspace-history-action" type="button" onClick={() => { setSelectionMode((current) => !current); setSelectedThreadIds([]); }} aria-label={selectionMode ? m.cancelSelection : m.selectConversations} title={selectionMode ? m.cancelSelection : m.selectConversations}>✓</button><button className="workspace-history-action" type="button" onClick={onSync} aria-label={m.syncNow} title={m.syncNow}>↻</button><button className="workspace-history-action" type="button" onClick={onChoose} aria-label={m.addWorkspace} title={m.addWorkspace}>＋</button></div></div>
    <div className="history-search"><input id="history-search" type="search" value={historyQuery} onChange={(event) => { closeMenus(); setHistoryQuery(event.target.value); }} placeholder={m.searchHistoryPlaceholder} aria-label={m.searchHistory} /></div>
    <div className="history-controls"><select id="history-filter" className="history-filter" value={historyFilter} onChange={(event) => changeFilter(event.target.value as HistoryFilter)} aria-label={m.filterHistory}><option value="all">{m.filterAll}</option><option value="favorites">{m.filterFavorites}</option><option value="hidden">{m.filterHidden}</option><option value="archived">{m.filterArchived}</option><option value="unclassified">{m.filterUnclassified}</option><option value="updated">{m.filterRecentlyUpdated}</option></select><select id="history-sort" className="history-filter history-sort" value={historySort} onChange={(event) => setHistorySort(event.target.value as HistorySort)} aria-label={m.sortHistory}><option value="updated">{m.sortUpdated}</option><option value="name">{m.sortName}</option></select></div>
    {selectionMode ? <div className="history-selection-actions"><span>{selectedThreadIds.length}</span><button type="button" disabled={selectedThreadIds.length === 0} onClick={() => { void applySelection(); }}>{showHidden ? m.showSelected(selectedThreadIds.length) : m.hideSelected(selectedThreadIds.length)}</button></div> : null}
    {syncLabel === undefined ? null : <p className={`sync-note sync-${sync?.state ?? "idle"}`} role="status">{syncLabel}</p>}
    {loading ? <p className="panel-note">{m.loading}</p> : null}
    <div ref={listElement} className="thread-list workspace-history-list" role="listbox" aria-label={m.workspaceHistory} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
      {showingSearch ? <ol className="history-search-results">{searchResults.map((result) => <li key={`${result.kind}:${result.id}`}><button type="button" className="history-search-result" onClick={() => { void activateSearchResult(result); }}><span className="history-search-copy"><strong>{result.title}</strong><small>{result.detail}</small></span><span className="history-search-status">{result.hidden ? <em>{m.hidden}</em> : null}{result.archived ? <em>{m.officialArchived}</em> : null}<b>{result.kind === "thread" ? result.hidden ? m.showAndOpen : m.openConversation : result.hidden ? m.showWorkspace : m.locateWorkspace}</b></span></button></li>)}</ol> : <>
        {[...visibleDirectories].sort((left, right) => compareDirectories(left, right, historySort)).map((directory) => renderGroup(directory.path, directory.name, directory.expanded, directory.threads))}
        {visibleUnclassified.length > 0 ? renderGroup("__unclassified__", m.unclassified, true, [...visibleUnclassified].sort((left, right) => compareThreads(left, right, historySort))) : null}
        {state !== undefined && !hasItems && !loading ? <p className="panel-note">{showHidden ? m.noHiddenItems : m.noThreads}</p> : null}
      </>}
      {showingSearch && searchResults.length === 0 && !loading ? <p className="panel-note">{m.noHistorySearchResults}</p> : null}
    </div>
  </div>;
}

function ThreadDirectory({ thread, archived, archiveDisabled, onSetArchived, hidden, workspacePath, workspaceState, activeTurnId, query, results, selectedIndex, error, onQueryChange, onSearchKeyDown, onNavigate, onBack, onRename, onMove, onSetHidden, setOutlineButton, m }: { thread: ConversationThreadView | undefined; archived: boolean; archiveDisabled: boolean; onSetArchived: (threadId: string, archived: boolean) => void; hidden: boolean; workspacePath: string | undefined; workspaceState: WorkspaceState | undefined; activeTurnId: string | undefined; query: string; results: readonly SearchResult[]; selectedIndex: number; error: string | undefined; onQueryChange: (query: string) => void; onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; onNavigate: (turnId: string) => void; onBack: () => void; onRename: () => void; onMove: (threadId: string, path: string | null) => void; onSetHidden: (threadId: string, hidden: boolean) => void; setOutlineButton: (turnId: string, element: HTMLButtonElement | null) => void; m: Messages }): React.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const closeActions = (): void => { setActionsOpen(false); setMoving(false); };
  return (
    <div className="thread-directory">
      <button className="back-history" type="button" onClick={onBack}>← {m.backToHistory}</button>
      <div className="directory-title-row"><h2 className="directory-title" title={thread?.title}>{thread?.title ?? m.loadingConversation}</h2>{thread === undefined ? null : <div className="directory-actions"><button className="directory-rename" type="button" onClick={() => { setMoving(false); setActionsOpen((open) => !open); }} onKeyDown={(event) => { if (event.key === "Escape") closeActions(); }} aria-label={`${m.threadActions}: ${thread.title}`} aria-expanded={actionsOpen} aria-haspopup="menu">···</button>{actionsOpen ? <div className="thread-actions-menu directory-actions-menu" role="menu" onKeyDown={(event) => { if (event.key === "Escape") closeActions(); }}><button type="button" role="menuitem" onClick={() => { closeActions(); onRename(); }}>{m.rename}</button><button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setMoving(true); }}>{m.moveToWorkspace}</button><button type="button" role="menuitem" disabled={archiveDisabled} onClick={() => { closeActions(); onSetArchived(thread.id, !archived); }}>{archived ? m.restoreConversation : m.archiveConversation}</button><button type="button" role="menuitem" onClick={() => { closeActions(); onSetHidden(thread.id, !hidden); }}>{hidden ? m.showConversation : m.hideConversation}</button></div> : null}{moving ? <div className="thread-actions-menu directory-actions-menu workspace-choice-menu" role="menu" onKeyDown={(event) => { if (event.key === "Escape") closeActions(); }}>{workspaceState?.directories.filter((directory) => !directory.hidden).map((directory) => <button key={directory.path} type="button" role="menuitem" className={workspacePath === directory.path ? "selected" : ""} onClick={() => { closeActions(); onMove(thread.id, directory.path); }}>📁 {directory.name}{workspacePath === directory.path ? " ✓" : ""}</button>)}<button type="button" role="menuitem" className={workspacePath === undefined ? "selected" : ""} onClick={() => { closeActions(); onMove(thread.id, null); }}>{m.noWorkspace}{workspacePath === undefined ? " ✓" : ""}</button></div> : null}</div>}</div>
      <SearchPanel query={query} results={results} selectedIndex={selectedIndex} error={error} onQueryChange={onQueryChange} onKeyDown={onSearchKeyDown} onNavigate={onNavigate} m={m} />
      <div className="directory-heading"><p className="eyebrow">{m.questionOutline}</p><span>{m.turns(thread?.outline.length ?? 0)}</span></div>
      {thread?.outline.length === 0 ? <p className="panel-note">{m.noQuestions}</p> : <ol className="outline-list directory-list">
        {thread?.outline.map((entry) => <li key={entry.turnId}><button ref={(element) => setOutlineButton(entry.turnId, element)} type="button" className={`outline-entry${entry.turnId === activeTurnId ? " active" : ""}`} onClick={() => onNavigate(entry.turnId)} aria-current={entry.turnId === activeTurnId ? "true" : undefined} aria-label={m.goToTurn(entry.index, entry.label)}><span className="outline-index">{String(entry.index).padStart(2, "0")}</span><span className="outline-copy"><strong>{entry.label}</strong><small>{entry.status}</small></span></button></li>)}
      </ol>}
    </div>
  );
}

function Conversation({ thread, activeTurnId, loadingMore, loadMoreError, onLoadMore, onNavigate, onVisibleTurn, onUserScroll, m, onNavigateReady, onRefreshStatus, scrollToLatest, onScrollToLatestHandled, newContent, onNewContentHandled, turnTimings, now, onFork, forkDisabled, forkingTurnId, branch, onShowBoundary }: { thread: ConversationThreadView; activeTurnId: string | undefined; loadingMore: boolean; loadMoreError: string | undefined; onLoadMore: () => void; onNavigate: (turnId: string) => void; onVisibleTurn: (turnId: string | undefined) => void; onUserScroll: () => void; m: Messages; onNavigateReady: (navigate: NavigateTurn | undefined) => void; onRefreshStatus: () => void; scrollToLatest: boolean; onScrollToLatestHandled: () => void; newContent: boolean; onNewContentHandled: () => void; turnTimings: Readonly<Record<string, TurnTiming>>; now: number; onFork: (turnId: string) => void; forkDisabled: boolean; forkingTurnId: string | undefined; branch: ThreadBranch | undefined; onShowBoundary: () => void }): React.JSX.Element {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const lastTurnId = thread.turns[thread.turns.length - 1]?.id;
  const lastAutoScrolledTurnId = useRef<string | undefined>(undefined);
  const turnIndexById = new Map(thread.turns.map((turn, index) => [turn.id, index]));
  const initialItemIndex = useRef(turnIndexById.get(activeTurnId ?? ""));
  const inherited = branch === undefined ? undefined : inheritedTurnIds(thread, branch.forkTurnId);
  const firstIndependentId = inherited === undefined ? undefined : thread.turns.find((turn) => !inherited.has(turn.id))?.id;
  const navigate = (turnId: string): void => {
    const index = turnIndexById.get(turnId);
    if (index === undefined) return;
    virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "auto" });
    onNavigate(turnId);
  };
  const statusLabel = thread.remoteActive || thread.writeState === "externalThreadWriter" ? m.remoteTurnRunning : thread.writeState === "workspaceLocked" ? m.workspaceLocked : thread.writeState === "stateUnknown" ? m.stateUnknown : thread.writeState === "localTurnRunning" ? m.localTurnRunning : thread.canAcceptDirectInput === false ? m.inputUnavailable : undefined;
  useEffect(() => {
    onNavigateReady(navigate);
    return () => onNavigateReady(undefined);
  }, [thread.id, thread.turns, onNavigateReady]);
  useEffect(() => {
    const lastIndex = thread.turns.length - 1;
    if (!scrollToLatest) return;
    if (lastIndex < 0 || lastTurnId === undefined || lastAutoScrolledTurnId.current === lastTurnId) return;
    lastAutoScrolledTurnId.current = lastTurnId;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    onScrollToLatestHandled();
  }, [thread.id, lastTurnId, scrollToLatest, onScrollToLatestHandled]);
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
        <div className="conversation-heading"><div><h2>{thread.title}</h2></div><div className="conversation-heading-actions">{newContent ? <button className="new-content-button" type="button" onClick={() => { if (thread.turns.length > 0) virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" }); onNewContentHandled(); }}>{m.newContent}</button> : null}<button className="refresh-status" type="button" onClick={onRefreshStatus} aria-label={m.refreshStatus} title={m.refreshStatus}>↻</button>{statusLabel === undefined ? null : <span className="thread-status">{statusLabel}</span>}</div></div>
        <div className="pagination-controls">
          {thread.paging.hasMore ? <button type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? m.loadingEarlier : m.loadEarlier}</button> : <span className="panel-note">{m.noMore}</span>}
          {loadMoreError === undefined ? null : <p className="error-summary">{loadMoreError}</p>}
        </div>
        {branch !== undefined && inherited === undefined ? <div className="branch-boundary-notice"><span>{m.unloadedBranchBoundary}</span><button type="button" onClick={onShowBoundary}>{m.showBranchBoundary}</button></div> : null}
        {thread.turns.length === 0 ? <div className="conversation-empty"><p className="empty-kicker">{m.conversation}</p><h2>{m.noReadableTurns}</h2><p>{m.noConversationContent}</p></div> : null}
        {thread.turns.length === 0 ? null : <Virtuoso<ConversationThreadView["turns"][number]>
          ref={virtuosoRef}
          data={thread.turns}
          computeItemKey={(_, turn) => turn.id}
          firstItemIndex={thread.paging.firstItemIndex}
          initialTopMostItemIndex={initialItemIndex.current}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          rangeChanged={onRangeChanged}
          scrollerRef={setScroller}
          className="turn-virtual-list"
          itemContent={(_, turn) => {
            const timing = turnTimings[turn.id];
            const timingLabel = timing === undefined ? undefined : timing.finishedAt === undefined
              ? m.thinkingElapsed(formatElapsedTime(timing.startedAt, now))
              : m.responseElapsed(formatElapsedTime(timing.startedAt, timing.finishedAt));
            return <article className="turn-card" data-turn-id={turn.id} data-history-kind={inherited === undefined ? undefined : inherited.has(turn.id) ? "inherited" : "branch"} key={turn.id}>
              {turn.id === firstIndependentId ? <p className="branch-discussion-label">{m.independentDiscussion}</p> : null}
              <header className="turn-heading">
                <div><span className="turn-index">{m.turn(turn.index)}</span><span className="turn-status">{turn.status}</span></div>
                {["completed", "failed", "interrupted"].includes(turn.status) ? <button className="fork-turn" type="button" onClick={() => onFork(turn.id)} disabled={forkDisabled} aria-label={m.branchFromTurn(turn.index)}>{forkingTurnId === turn.id ? m.forking : m.forkHere}</button> : null}
                {turn.createdAt === undefined ? null : <time dateTime={turn.createdAt}>{turn.createdAt}</time>}
              </header>
              {turn.items.length === 0 ? <p className="partial-note">{m.noReadableItems}</p> : <TurnItems items={turn.items} timingLabel={timingLabel} m={m} />}
              {branch?.forkTurnId === turn.id ? <div className="branch-history-boundary" role="note" data-cutoff-turn-id={turn.id}><strong>{m.inheritedHistoryEnds}</strong>{firstIndependentId === undefined ? <span>{m.startIndependentDiscussion}</span> : null}</div> : null}
            </article>;
          }}
        />}
      </div>
    </div>
  );
}

function RenameModal({ name, onChange, onCancel, onSave, m }: { name: string; onChange: (name: string) => void; onCancel: () => void; onSave: () => void; m: Messages }): React.JSX.Element {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
      <button className="modal-close" type="button" onClick={onCancel} aria-label={m.close}>×</button>
      <h2 id="rename-dialog-title">{m.renameChat}</h2>
      <p>{m.renameHint}</p>
      <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <input autoFocus value={name} onChange={(event) => onChange(event.target.value)} placeholder={m.threadNamePlaceholder} aria-label={m.renameChat} />
        <div className="modal-actions"><button type="button" onClick={onCancel}>{m.cancel}</button><button type="submit">{m.save}</button></div>
      </form>
    </section>
  </div>;
}

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [language, setLanguage] = useState<Language>("en-US");
  const [theme, setTheme] = useState<Theme>("graphite");
  const [onboardingState, setOnboardingState] = useState<OnboardingSnapshot>({ state: "detecting" });
  const [connectionState, setConnectionState] = useState<ConnectionStateSnapshot>({ state: "idle" });
  const [reconnecting, setReconnecting] = useState(false);
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | undefined>();
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [threadLoadState, setThreadLoadState] = useState<LoadState>("idle");
  const [threadError, setThreadError] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [selectedThread, setSelectedThread] = useState<ConversationThreadView | undefined>();
  const [selectedThreadState, setSelectedThreadState] = useState<LoadState>("idle");
  const [selectedThreadError, setSelectedThreadError] = useState<string | undefined>();
  const [scrollToLatest, setScrollToLatest] = useState(false);
  const [newContentAvailable, setNewContentAvailable] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1);
  const [searchError, setSearchError] = useState<string | undefined>();
  const [draftByThreadId, setDraftByThreadId] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<readonly ThreadBranch[]>([]);
  const [forkingTurnId, setForkingTurnId] = useState<string | undefined>();
  const [branchError, setBranchError] = useState<string | undefined>();
  const [branchPointTarget, setBranchPointTarget] = useState<BranchPointTarget | undefined>();
  const [branchPointLoading, setBranchPointLoading] = useState(false);
  const [branchPointError, setBranchPointError] = useState<"missing" | "failed" | undefined>();
  const [draftSaveErrors, setDraftSaveErrors] = useState<Record<string, boolean>>({});
  const [sendErrorByThreadId, setSendErrorByThreadId] = useState<Record<string, string | undefined>>({});
  const [startingTurn, setStartingTurn] = useState(false);
  const [archivingThreadId, setArchivingThreadId] = useState<string | undefined>();
  const archiveBusyRef = useRef(false);
  const [archiveError, setArchiveError] = useState<string | undefined>();
  const [interruptingThreadId, setInterruptingThreadId] = useState<string | undefined>();
  const [runningTurnByThreadId, setRunningTurnByThreadId] = useState<Record<string, string | undefined>>({});
  const [turnTimings, setTurnTimings] = useState<Record<string, TurnTiming>>({});
  const [clock, setClock] = useState(() => Date.now());
  const [remoteActiveByThreadId, setRemoteActiveByThreadId] = useState<Record<string, boolean>>({});
  const [newDraft, setNewDraft] = useState("");
  const [newSendError, setNewSendError] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [modelSelection, setModelSelection] = useState("");
  const [reasoningSelection, setReasoningSelection] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string | undefined>();
  const [editingThreadName, setEditingThreadName] = useState("");
  const [navigateToTurn, setNavigateToTurn] = useState<NavigateTurn | undefined>();
  const seenUpdateKeys = useRef(new Set<string>());
  const settledTurnIds = useRef(new Set<string>());
  const navigationTarget = useRef<string | undefined>(undefined);
  const outlineButtons = useRef(new Map<string, HTMLButtonElement>());
  const threadListElement = useRef<HTMLDivElement | null>(null);
  const threadListScrollTop = useRef(0);
  const inputElement = useRef<HTMLTextAreaElement | null>(null);
  const selectedIdRef = useRef(selectedThreadId);
  const pendingBranchJump = useRef<BranchPointTarget | undefined>(undefined);
  const navigateReadyThreadId = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedThreadId;
  const selectedBranch = branches.find((branch) => branch.threadId === selectedThreadId);
  const m = messages[language];
  const selectedModel = modelOptions.find((model) => model.id === modelSelection);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts ?? [];
  const composerOptions: ComposerOptions = {
    ...(selectedModel === undefined ? {} : { model: selectedModel.id }),
    ...(reasoningSelection === "" ? {} : { effort: reasoningSelection }),
  };
  const selectedListThread = selectedThreadId === undefined ? undefined : threads.find((thread) => thread.id === selectedThreadId);
  const currentWorkspacePath = selectedThreadId === undefined ? workspaceState?.currentPath : selectedListThread?.workspacePath;
  const outsideWorkspace = currentWorkspacePath !== undefined && currentWorkspacePath === workspaceState?.standalonePath;
  const currentWorkspaceName = outsideWorkspace ? m.workOutsideWorkspace : workspaceState?.directories.find((directory) => directory.path === currentWorkspacePath)?.name ?? currentWorkspacePath?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? currentWorkspacePath;
  const selectedArchived = selectedListThread?.archived === true;
  const selectedThreadWorkspacePath = selectedThreadId === undefined ? undefined : selectedListThread?.workspacePath;
  const historyMode = connectionState.mode === "history";
  const showWorkspacePicker = historyMode || selectedThreadId === undefined || selectedThreadWorkspacePath === undefined;
  const newConversationWorkspaceRequired = selectedThreadId === undefined && currentWorkspacePath === undefined;
  const inputText = selectedThreadId === undefined ? newDraft : draftByThreadId[selectedThreadId] ?? "";
  const sendError = selectedThreadId === undefined ? newSendError : sendErrorByThreadId[selectedThreadId];
  const localRunningTurnId = selectedThreadId === undefined ? undefined : runningTurnByThreadId[selectedThreadId];
  const canInterruptLocalTurn = localRunningTurnId !== undefined && interruptingThreadId !== selectedThreadId;
  const writeState = selectedThread?.writeState;
  const remoteActive = selectedThreadId !== undefined && (remoteActiveByThreadId[selectedThreadId] === true || selectedThread?.remoteActive === true || writeState === "externalThreadWriter");
  const inputUnavailable = selectedArchived || historyMode || newConversationWorkspaceRequired || (selectedThreadId !== undefined && (selectedThread?.id !== selectedThreadId || selectedThreadState === "loading" || selectedThreadState === "error")) || selectedThread?.canAcceptDirectInput === false || writeState === "inputUnavailable" || writeState === "stateUnknown" || writeState === "workspaceLocked";
  const turnIsRunning = archivingThreadId !== undefined || startingTurn || forkingTurnId !== undefined || localRunningTurnId !== undefined || remoteActive || writeState === "localTurnRunning";
  const hasRunningTimer = Object.values(turnTimings).some((timing) => timing.finishedAt === undefined);

  const saveDraft = (threadId: string, text: string): void => {
    void window.threadPath.setThreadDraft(threadId, text).then(() => setDraftSaveErrors((current) => ({ ...current, [threadId]: false })))
      .catch(() => setDraftSaveErrors((current) => ({ ...current, [threadId]: true })));
  };
  const setInputText = (text: string): void => {
    if (selectedThreadId === undefined) setNewDraft(text);
    else { setDraftByThreadId((current) => ({ ...current, [selectedThreadId]: text })); saveDraft(selectedThreadId, text); }
  };

  const showBranchPoint = (threadId: string, turnId: string): void => {
    setBranchPointError(undefined);
    setBranchPointTarget({ threadId, turnId });
    setSelectedThreadId(threadId);
  };
  const selectRoute = (threadId: string): void => {
    pendingBranchJump.current = undefined;
    setBranchPointTarget(undefined);
    setBranchPointError(undefined);
    if (threadId === selectedThreadId) void handleRefreshStatus();
    else setSelectedThreadId(threadId);
  };

  const handleFork = async (turnId: string): Promise<void> => {
    const sourceId = selectedThreadId;
    if (sourceId === undefined || turnIsRunning || inputUnavailable) return;
    setForkingTurnId(turnId);
    setBranchError(undefined);
    try {
      const result = await window.threadPath.forkConversation(sourceId, turnId);
      setBranches((current) => [...current.filter((branch) => branch.threadId !== result.threadId), result.branch]);
      if (result.persistenceWarning !== undefined) setBranchError(m.branchSaveFailed);
      await refreshWorkspaceState();
      setSelectedThreadId((current) => current === sourceId ? result.threadId : current);
    } catch (error: unknown) { setBranchError(errorMessage(error)); }
    finally { setForkingTurnId(undefined); }
  };

  const loadThreads = useCallback(async (): Promise<void> => {
    setThreadLoadState("loading");
    setThreadError(undefined);
    try {
      const syncResult = await window.threadPath.syncHistory();
      const nextWorkspaceState = syncResult.workspace;
      const nextThreads = [...nextWorkspaceState.directories.flatMap((directory) => directory.threads), ...nextWorkspaceState.unclassifiedThreads];
      setThreads(nextThreads);
      setWorkspaceState(nextWorkspaceState);
      setThreadLoadState(nextThreads.length === 0 ? "empty" : "ready");
      // thread/list can lag a successful thread/start. Listing is not evidence
      // that the selected conversation disappeared; read it by its returned ID.
    } catch (error: unknown) {
      setThreadLoadState("error");
      setThreadError(errorMessage(error));
    }
  }, []);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const nextModels = await window.threadPath.listModels();
      setModelOptions(nextModels);
      setModelSelection((current) => {
        const nextModel = nextModels.find((model) => model.id === current) ?? preferredModel(nextModels);
        setReasoningSelection((currentEffort) => nextModel?.supportedReasoningEfforts.some((effort) => effort.id === currentEffort) === true
          ? currentEffort
          : preferredReasoningEffort(nextModel));
        return nextModel?.id ?? "";
      });
    } catch {
      // Model selection is optional. Keep the composer usable when this server
      // or account cannot expose a model catalog.
      setModelOptions([]);
      setModelSelection("");
      setReasoningSelection("");
    }
  }, []);

  const refreshWorkspaceState = useCallback(async (): Promise<void> => {
    setWorkspaceLoading(true);
    try {
      const state = await window.threadPath.getWorkspaceState();
      setWorkspaceState(state);
      setThreads([...state.directories.flatMap((directory) => directory.threads), ...state.unclassifiedThreads]);
    }
    catch (error: unknown) { setThreadError(errorMessage(error)); }
    finally { setWorkspaceLoading(false); }
  }, []);

  const syncHistory = useCallback(async (): Promise<void> => {
    setWorkspaceLoading(true);
    try {
      const syncResult = await window.threadPath.syncHistory();
      const state = syncResult.workspace;
      setWorkspaceState(state);
      setThreads([...state.directories.flatMap((directory) => directory.threads), ...state.unclassifiedThreads]);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
    finally { setWorkspaceLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [info, onboarding, state] = await Promise.all([window.threadPath.getAppInfo(), window.threadPath.getOnboardingState(), window.threadPath.getConnectionState()]);
        if (!active) return;
        setAppInfo(info);
        setLanguage(info.language); setTheme(info.theme); document.documentElement.dataset.theme = info.theme;
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
  const handleThemeChange = async (nextTheme: Theme): Promise<void> => {
    try { const saved = await window.threadPath.setTheme(nextTheme); setTheme(saved); document.documentElement.dataset.theme = saved; }
    catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const beginRename = (thread: ThreadListItem): void => {
    setEditingThreadId(thread.id);
    setEditingThreadName(thread.title);
  };

  const saveThreadName = async (threadId: string, name: string | null): Promise<void> => {
    try {
      const update = await window.threadPath.setThreadDisplayName(threadId, name);
      setThreads((current) => current.map((thread) => thread.id === update.threadId ? { ...thread, title: update.title } : thread));
      setWorkspaceState((current) => current === undefined ? current : replaceThreadTitle(current, update.threadId, update.title));
      setSelectedThread((current) => current?.id === update.threadId ? { ...current, title: update.title } : current);
      setEditingThreadId(undefined);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const moveThreadToWorkspace = async (threadId: string, path: string | null): Promise<void> => {
    try {
      const nextState = await window.threadPath.associateThreadWorkspace(threadId, path);
      setWorkspaceState(nextState);
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, workspacePath: path ?? undefined } : thread));
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

  const handleChooseWorkspaceDirectory = async (): Promise<void> => {
    try { setWorkspaceState(await window.threadPath.chooseWorkspaceDirectory()); }
    catch (error: unknown) { setNewSendError(errorMessage(error)); }
    finally { setWorkspaceMenuOpen(false); }
  };

  const handleSetCurrentWorkspace = async (path: string | null): Promise<void> => {
    try {
      if (selectedThreadId !== undefined && selectedThreadWorkspacePath === undefined) {
        const nextState = await window.threadPath.associateThreadWorkspace(selectedThreadId, path);
        setWorkspaceState(nextState);
        setThreads((current) => current.map((thread) => thread.id === selectedThreadId ? { ...thread, workspacePath: path ?? undefined } : thread));
      } else setWorkspaceState(await window.threadPath.setCurrentWorkspace(path));
    }
    catch (error: unknown) { setNewSendError(errorMessage(error)); }
    finally { setWorkspaceMenuOpen(false); }
  };

  const handleChooseWorkspaceForComposer = async (): Promise<void> => {
    try {
      const nextState = await window.threadPath.chooseWorkspaceDirectory();
      if (selectedThreadId !== undefined && selectedThreadWorkspacePath === undefined && nextState.currentPath !== undefined) {
        const boundState = await window.threadPath.associateThreadWorkspace(selectedThreadId, nextState.currentPath);
        setWorkspaceState(boundState);
        setThreads((current) => current.map((thread) => thread.id === selectedThreadId ? { ...thread, workspacePath: nextState.currentPath } : thread));
      } else setWorkspaceState(nextState);
    } catch (error: unknown) { setNewSendError(errorMessage(error)); }
    finally { setWorkspaceMenuOpen(false); }
  };

  const handleToggleWorkspace = async (path: string): Promise<void> => {
    try { setWorkspaceState(await window.threadPath.toggleWorkspace(path)); }
    catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleSetWorkspaceHidden = async (path: string, hidden: boolean): Promise<void> => {
    try {
      const nextState = await window.threadPath.setWorkspaceHidden(path, hidden);
      setWorkspaceState(nextState);
      setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleSetThreadArchived = async (threadId: string, archived: boolean): Promise<void> => {
    if (archiveBusyRef.current) return;
    archiveBusyRef.current = true;
    setArchivingThreadId(threadId);
    setArchiveError(undefined);
    try {
      const result = await window.threadPath.setThreadArchived(threadId, archived);
      applyWorkspaceState(result.workspace);
      if (result.persistenceWarning !== undefined) setArchiveError(m.archiveSaveFailed);
      if (archived) setSelectedThreadId((current) => current === threadId ? undefined : current);
    } catch (error: unknown) { setArchiveError(errorMessage(error)); }
    finally { archiveBusyRef.current = false; setArchivingThreadId(undefined); }
  };

  const handleSetThreadHidden = async (threadId: string, hidden: boolean): Promise<void> => {
    try {
      const nextState = await window.threadPath.setThreadHidden(threadId, hidden);
      setWorkspaceState(nextState);
      setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
      if (hidden && selectedThreadId === threadId) setSelectedThreadId(undefined);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleSetWorkspaceFavorite = async (path: string, favorite: boolean): Promise<void> => {
    try {
      const nextState = await window.threadPath.setWorkspaceFavorite(path, favorite);
      setWorkspaceState(nextState);
      setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleSetThreadFavorite = async (threadId: string, favorite: boolean): Promise<void> => {
    try {
      const nextState = await window.threadPath.setThreadFavorite(threadId, favorite);
      setWorkspaceState(nextState);
      setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleSetThreadsHidden = async (threadIds: readonly string[], hidden: boolean): Promise<void> => {
    try {
      const nextState = await window.threadPath.setThreadsHidden(threadIds, hidden);
      setWorkspaceState(nextState);
      setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
      if (hidden && selectedThreadId !== undefined && threadIds.includes(selectedThreadId)) setSelectedThreadId(undefined);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const applyWorkspaceState = (nextState: WorkspaceState): void => {
    setWorkspaceState(nextState);
    setThreads([...nextState.directories.flatMap((directory) => directory.threads), ...nextState.unclassifiedThreads]);
  };

  const handleRevealWorkspace = async (path: string): Promise<void> => {
    try { applyWorkspaceState(await window.threadPath.setWorkspaceHidden(path, false)); }
    catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  const handleRevealThread = async (threadId: string, workspacePath: string | undefined): Promise<void> => {
    try {
      if (workspacePath !== undefined) applyWorkspaceState(await window.threadPath.setWorkspaceHidden(workspacePath, false));
      applyWorkspaceState(await window.threadPath.setThreadHidden(threadId, false));
      setSelectedThreadId(threadId);
    } catch (error: unknown) { setThreadError(errorMessage(error)); }
  };

  useEffect(() => {
    if (connectionState.state === "ready") void loadThreads();
    else {
      setThreads([]);
      setWorkspaceState(undefined);
      setSelectedThreadId(undefined);
      setSelectedThread(undefined);
      setThreadLoadState("idle");
      setSendErrorByThreadId({});
      setRunningTurnByThreadId({});
      setTurnTimings({});
      setRemoteActiveByThreadId({});
      setNewSendError(undefined);
    }
  }, [connectionState.state, loadThreads]);

  useEffect(() => {
    if (!hasRunningTimer) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTimer]);

  useEffect(() => {
    if (connectionState.state === "ready") void loadModels();
    else {
      setModelOptions([]);
      setModelSelection("");
      setReasoningSelection("");
    }
  }, [connectionState.state, loadModels]);

  useEffect(() => {
    if (connectionState.state !== "ready") return;
    let active = true;
    void window.threadPath.listBranches().then((saved) => {
      if (active) setBranches((current) => [...new Map([...saved, ...current].map((branch) => [branch.threadId, branch])).values()]);
    }).catch((error: unknown) => { if (active) setBranchError(errorMessage(error)); });
    return () => { active = false; };
  }, [connectionState.state]);

  useEffect(() => window.threadPath.onWorkspaceStateChanged((state) => {
    setWorkspaceState(state);
    setThreads([...state.directories.flatMap((directory) => directory.threads), ...state.unclassifiedThreads]);
  }), []);

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
      setBranchPointTarget(undefined);
      setBranchPointLoading(false);
      setBranchPointError(undefined);
      pendingBranchJump.current = undefined;
      return;
    }
    if (branchPointTarget !== undefined && branchPointTarget.threadId !== selectedThreadId) {
      setBranchPointTarget(undefined);
      setBranchPointError(undefined);
    }
    const target = branchPointTarget?.threadId === selectedThreadId ? branchPointTarget : undefined;
    let active = true;
    pendingBranchJump.current = undefined;
    setBranchPointLoading(target !== undefined);
    seenUpdateKeys.current.clear();
    void window.threadPath.getThreadDraft(selectedThreadId).then((text) => {
      if (active) setDraftByThreadId((current) => Object.prototype.hasOwnProperty.call(current, selectedThreadId) ? current : { ...current, [selectedThreadId]: text });
    }).catch(() => { if (active) setDraftSaveErrors((current) => ({ ...current, [selectedThreadId]: true })); });
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
    setScrollToLatest(target === undefined);
    setNewContentAvailable(false);
    let loaded: ConversationThreadView | undefined;
    const load = async (): Promise<ConversationThreadView> => {
      loaded = await window.threadPath.readThread(selectedThreadId);
      if (loaded.id !== selectedThreadId) throw new Error("Conversation response belongs to another thread");
      if (target === undefined || !active) return loaded;
      const result = await locateBranchPoint(loaded, target.turnId, async () => {
        loaded = await window.threadPath.loadMoreTurns(selectedThreadId);
        return loaded;
      }, () => active);
      if (active) {
        if (result.outcome === "found") { pendingBranchJump.current = target; setActiveTurnId(target.turnId); }
        else { setBranchPointError("missing"); setBranchPointLoading(false); }
      }
      return result.thread;
    };
    void load().then((thread) => {
      if (!active) return;
      setSelectedThread(thread);
      setRemoteActiveByThreadId((current) => ({ ...current, [thread.id]: thread.remoteActive === true }));
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, title: thread.title, turnCount: thread.turns.length } : item));
      setSelectedThreadState(thread.turns.length === 0 ? "empty" : "ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setBranchPointLoading(false);
      if (target !== undefined) setBranchPointError("failed");
      if (target !== undefined && loaded !== undefined && loaded.id === selectedThreadId) {
        setSelectedThread(loaded);
        setSelectedThreadState(loaded.turns.length === 0 ? "empty" : "ready");
      } else {
        setSelectedThreadState("error");
        setSelectedThreadError(errorMessage(error));
      }
    });
    return () => { active = false; };
  }, [selectedThreadId, branchPointTarget]);

  useEffect(() => {
    const target = pendingBranchJump.current;
    if (target === undefined || selectedThread?.id !== target.threadId || navigateReadyThreadId.current !== target.threadId || navigateToTurn === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      if (selectedIdRef.current !== target.threadId || pendingBranchJump.current !== target) return;
      navigateToTurn(target.turnId);
      pendingBranchJump.current = undefined;
      setBranchPointLoading(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedThread, navigateToTurn, selectedThreadId]);

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
      settledTurnIds.current.add(update.turnId);
      while (settledTurnIds.current.size > 512) {
        const oldestTurnId = settledTurnIds.current.values().next().value;
        if (oldestTurnId === undefined) break;
        settledTurnIds.current.delete(oldestTurnId);
      }
      setTurnTimings((current) => {
        const timing = current[update.turnId];
        return timing === undefined || timing.finishedAt !== undefined ? current : { ...current, [update.turnId]: { ...timing, finishedAt: Date.now() } };
      });
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
    if (connectionState.state !== "ready" || text === "" || turnIsRunning) return;
    if (historyMode) {
      if (selectedThreadId === undefined) setNewSendError(m.confirmWorkspaceToSend);
      else setSendErrorByThreadId((current) => ({ ...current, [selectedThreadId]: m.confirmWorkspaceToSend }));
      return;
    }
    if (selectedThreadId === undefined) {
      if (currentWorkspacePath === undefined) { setNewSendError(m.chooseWorkspace); return; }
      setNewSendError(undefined);
      setStartingTurn(true);
      try {
        const result = await window.threadPath.startNewConversation(outsideWorkspace ? null : currentWorkspacePath, text, composerOptions);
        setNewDraft("");
        setNewSendError(undefined);
        setSelectedThreadId(result.threadId);
        if (!settledTurnIds.current.has(result.turnId)) {
          setRunningTurnByThreadId((current) => ({ ...current, [result.threadId]: result.turnId }));
          setTurnTimings((current) => ({ ...current, [result.turnId]: { threadId: result.threadId, startedAt: Date.now() } }));
        }
        void loadThreads();
      } catch (error: unknown) {
        setNewSendError(errorMessage(error));
      } finally { setStartingTurn(false); }
      return;
    }
    const threadId = selectedThreadId;
    if (inputUnavailable) return;
    setSendErrorByThreadId((current) => { const next = { ...current }; delete next[threadId]; return next; });
    setStartingTurn(true);
    try {
      const result = await window.threadPath.startTurn(threadId, text, composerOptions);
      if (result.displayName !== undefined) {
        setThreads((current) => current.map((thread) => thread.id === result.threadId ? { ...thread, title: result.displayName ?? thread.title } : thread));
        setSelectedThread((current) => current?.id === result.threadId ? { ...current, title: result.displayName ?? current.title } : current);
      }
      setSelectedThread((current) => {
        if (current === undefined || current.id !== result.threadId) return current;
        const turnId = result.turnId;
        if (current.turns.some((turn) => turn.id === turnId)) return current;
        const newTurn: ConversationThreadView["turns"][number] = { id: turnId, index: current.turns.length + 1, status: "running", createdAt: new Date().toISOString(), items: [{ kind: "text", id: `${turnId}:user`, role: "user", text, phase: "historical" }] };
        const turns = [...current.turns, newTurn];
        return { ...current, turns, outline: buildTurnOutline(turns), paging: { ...current.paging, orderedTurnIds: turns.map((item) => item.id) } };
      });
      setScrollToLatest(true);
      if (!settledTurnIds.current.has(result.turnId)) {
        setRunningTurnByThreadId((current) => ({ ...current, [result.threadId]: result.turnId }));
        setTurnTimings((current) => ({ ...current, [result.turnId]: { threadId: result.threadId, startedAt: Date.now() } }));
      }
      setDraftByThreadId((current) => ({ ...current, [threadId]: "" }));
      saveDraft(threadId, "");
    } catch (error: unknown) {
      const currentThreadId = selectedThreadId;
      if (currentThreadId !== undefined && isConfirmedActiveTurnMessage(error)) {
        setRemoteActiveByThreadId((current) => ({ ...current, [currentThreadId]: true }));
        setSelectedThread((current) => current?.id === currentThreadId ? { ...current, remoteActive: true } : current);
        setSendErrorByThreadId((current) => ({ ...current, [currentThreadId]: m.remoteTurnRunning }));
      } else if (currentThreadId !== undefined) {
        const workspaceBlocked = isWorkspaceLockMessage(error);
        if (workspaceBlocked) setSelectedThread((current) => current?.id === currentThreadId ? { ...current, writeState: /unknown/i.test(errorMessage(error)) ? "stateUnknown" : "workspaceLocked" } : current);
        setSendErrorByThreadId((current) => ({ ...current, [currentThreadId]: workspaceBlocked ? (/unknown/i.test(errorMessage(error)) ? m.stateUnknown : m.workspaceLocked) : errorMessage(error) }));
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
    navigateReadyThreadId.current = navigate === undefined ? undefined : selectedThreadId;
    setNavigateToTurn(() => navigate);
  }, [selectedThreadId]);

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true);
    try { setConnectionState(await window.threadPath.reconnect()); }
    catch (error: unknown) { setConnectionState({ state: "error", error: errorMessage(error) }); }
    finally { setReconnecting(false); }
  };

  const handleInterruptTurn = async (): Promise<void> => {
    if (selectedThreadId === undefined || localRunningTurnId === undefined || interruptingThreadId !== undefined) return;
    const threadId = selectedThreadId;
    setInterruptingThreadId(threadId);
    try {
      await window.threadPath.interruptTurn(threadId);
    } catch (error: unknown) {
      setSendErrorByThreadId((current) => ({ ...current, [threadId]: errorMessage(error) }));
    } finally {
      setInterruptingThreadId((current) => current === threadId ? undefined : current);
    }
  };

  const handleRefreshStatus = async (): Promise<void> => {
    if (selectedThreadId === undefined) return;
    try {
      const previousLatestTurnId = selectedThread?.turns.at(-1)?.id;
      const refreshed = await window.threadPath.refreshThread(selectedThreadId);
      if (selectedIdRef.current !== selectedThreadId) return;
      setSelectedThread(refreshed);
      setSelectedThreadState(refreshed.turns.length === 0 ? "empty" : "ready");
      setSelectedThreadError(undefined);
      setScrollToLatest(false);
      setNewContentAvailable(previousLatestTurnId !== undefined && refreshed.turns.at(-1)?.id !== previousLatestTurnId);
      setRemoteActiveByThreadId((current) => ({ ...current, [refreshed.id]: refreshed.remoteActive === true }));
      if (refreshed.remoteActive !== true && refreshed.writeState !== "localTurnRunning") {
        setRunningTurnByThreadId((current) => {
          if (current[refreshed.id] === undefined) return current;
          const next = { ...current };
          delete next[refreshed.id];
          return next;
        });
        setTurnTimings((current) => {
          const finishedAt = Date.now();
          let changed = false;
          const next = Object.fromEntries(Object.entries(current).map(([turnId, timing]) => {
            if (timing.threadId !== refreshed.id || timing.finishedAt !== undefined) return [turnId, timing];
            changed = true;
            return [turnId, { ...timing, finishedAt }];
          })) as Record<string, TurnTiming>;
          return changed ? next : current;
        });
      }
      setSendErrorByThreadId((current) => { const next = { ...current }; delete next[selectedThreadId]; return next; });
    } catch (error: unknown) {
      setSendErrorByThreadId((current) => ({ ...current, [selectedThreadId]: errorMessage(error) }));
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div><h1><button className="about-button" type="button" onClick={() => setAboutOpen(true)} disabled={appInfo === undefined} aria-label={m.about} title={m.about}>ThreadPath for Codex</button></h1></div>
        <div className="topbar-actions"><div className="status" aria-label={m.connectionStatus}><span className={`status-dot status-${connectionState.state}`} />{m.connectionState(connectionState.state)}{connectionState.serverVersion === undefined ? null : <span className="status-meta">{m.server} {connectionState.serverVersion}</span>}</div><select className="theme-switch" value={theme} onChange={(event) => void handleThemeChange(event.target.value as Theme)} aria-label={m.theme}><option value="graphite">{m.themeGraphite}</option><option value="black">{m.themeBlack}</option><option value="light">{m.themeLight}</option></select><button className="language-switch" type="button" onClick={() => void handleLanguageChange()} aria-label={m.language}>{language === "zh-CN" ? "EN" : "中文"}</button></div>
      </header>
      <section className="workspace" aria-label={m.workspace}>
        <aside className="thread-panel">
          {selectedThreadId !== undefined ? <ThreadDirectory thread={selectedThread} archived={selectedArchived} archiveDisabled={turnIsRunning} onSetArchived={(threadId, archived) => void handleSetThreadArchived(threadId, archived)} hidden={selectedListThread?.hidden === true} workspacePath={selectedThreadWorkspacePath} workspaceState={workspaceState} activeTurnId={activeTurnId} query={searchQuery} results={searchResults} selectedIndex={selectedSearchIndex} error={searchError} onQueryChange={setSearchQuery} onSearchKeyDown={(event) => handleSearchKeyDown(event, (turnId) => navigateToTurn?.(turnId))} onNavigate={(turnId) => navigateToTurn?.(turnId)} onBack={() => setSelectedThreadId(undefined)} onRename={() => { const current = threads.find((thread) => thread.id === selectedThreadId); if (current !== undefined) beginRename(current); }} onMove={(threadId, path) => void moveThreadToWorkspace(threadId, path)} onSetHidden={(threadId, hidden) => void handleSetThreadHidden(threadId, hidden)} setOutlineButton={setOutlineButton} m={m} /> : <WorkspaceSidebar state={workspaceState} loading={workspaceLoading || threadLoadState === "loading"} listElement={threadListElement} onScroll={(top) => { threadListScrollTop.current = top; }} onChoose={() => void handleChooseWorkspaceDirectory()} onSync={() => void syncHistory()} onSelectThread={setSelectedThreadId} onSetCurrent={(path) => void handleSetCurrentWorkspace(path)} onToggle={(path) => void handleToggleWorkspace(path)} onRename={beginRename} onMove={(threadId, path) => void moveThreadToWorkspace(threadId, path)} onSetThreadHidden={(threadId, hidden) => void handleSetThreadHidden(threadId, hidden)} onSetWorkspaceHidden={(path, hidden) => void handleSetWorkspaceHidden(path, hidden)} onSetThreadFavorite={(threadId, favorite) => void handleSetThreadFavorite(threadId, favorite)} onSetWorkspaceFavorite={(path, favorite) => void handleSetWorkspaceFavorite(path, favorite)} onSetThreadsHidden={handleSetThreadsHidden} onSetArchived={(threadId, archived) => void handleSetThreadArchived(threadId, archived)} archiveBusy={archivingThreadId !== undefined || startingTurn || forkingTurnId !== undefined} runningThreadIds={[...Object.keys(runningTurnByThreadId).filter((id) => runningTurnByThreadId[id] !== undefined), ...Object.keys(remoteActiveByThreadId).filter((id) => remoteActiveByThreadId[id])]} onRevealThread={handleRevealThread} onRevealWorkspace={handleRevealWorkspace} language={language} m={m} />}
        </aside>
        <section className="details-panel" aria-label={m.selectedConversation}>
          {selectedThreadId === undefined ? null : <BranchMap branches={branches} threads={threads} selectedId={selectedThreadId} selectedThread={selectedThread} disabled={forkingTurnId !== undefined} onSelect={selectRoute} onSource={(branch) => showBranchPoint(branch.sourceThreadId, branch.forkTurnId)} m={m} />}
          {archiveError === undefined ? null : <div className="error-summary archive-error" role="alert"><span>{archiveError}</span><button type="button" onClick={() => setArchiveError(undefined)} aria-label={m.close}>×</button></div>}
          {branchError === undefined ? null : <p className="error-summary branch-error" role="alert">{branchError}</p>}
          {branchPointLoading ? <p className="panel-note branch-point-loading" role="status">{m.locatingBranchPoint}</p> : null}
          {branchPointError === undefined ? null : <div className="branch-point-error" role="alert"><span>{branchPointError === "missing" ? m.branchPointMissing : m.branchPointLoadFailed}</span>{branchPointTarget === undefined ? null : <button type="button" onClick={() => showBranchPoint(branchPointTarget.threadId, branchPointTarget.turnId)}>{m.retryBranchPoint}</button>}</div>}
          <div className="details-content">
            {selectedThreadState === "idle" && selectedThreadId !== undefined ? <div className="details-empty"><p className="empty-kicker">{m.conversation}</p><h2>{m.selectThread}</h2><p>{m.chooseThread}</p></div> : null}
            {selectedThreadState === "loading" ? <p className="panel-note">{m.loadingConversation}</p> : null}
            {selectedThreadState === "error" ? <p className="error-summary">{selectedThreadError}</p> : null}
            {(selectedThreadState === "empty" || selectedThreadState === "ready") && selectedThread !== undefined && selectedThread.id === selectedThreadId ? <Conversation thread={selectedThread} activeTurnId={activeTurnId} loadingMore={loadingMore} loadMoreError={loadMoreError} onLoadMore={() => void handleLoadMore()} onNavigate={handleNavigate} onVisibleTurn={handleVisibleTurn} onUserScroll={handleUserScroll} m={m} onNavigateReady={handleNavigateReady} onRefreshStatus={() => void handleRefreshStatus()} scrollToLatest={scrollToLatest} onScrollToLatestHandled={() => setScrollToLatest(false)} newContent={newContentAvailable} onNewContentHandled={() => setNewContentAvailable(false)} turnTimings={turnTimings} now={clock} onFork={(turnId) => void handleFork(turnId)} forkDisabled={selectedArchived || turnIsRunning || inputUnavailable || writeState !== "available"} forkingTurnId={forkingTurnId} branch={selectedBranch} onShowBoundary={() => { if (selectedBranch !== undefined) showBranchPoint(selectedBranch.threadId, selectedBranch.forkTurnId); }} /> : null}
            {selectedThreadId === undefined ? <div className="new-conversation-space"><p>{m.welcome}</p></div> : null}
          </div>
          <form className="turn-composer" onSubmit={(event) => { event.preventDefault(); void handleStartTurn(); }}>
              {selectedThreadId === undefined ? null : <div className="composer-route" aria-live="polite">{selectedArchived ? <><small>{m.archivedReadOnly}</small><button type="button" disabled={turnIsRunning} onClick={() => void handleSetThreadArchived(selectedThreadId, false)}>{m.restoreConversation}</button></> : null}<span>{m.continuingIn(selectedListThread?.title ?? (selectedThread?.id === selectedThreadId ? selectedThread.title : m.loadingConversation))}</span>{branches.some((branch) => branch.threadId === selectedThreadId) ? <small>{m.readOnlyDiscussion} · {m.sharedDirectory}</small> : null}</div>}
              <div className="composer-input">
                {workspaceMenuOpen ? <div className="workspace-menu" role="menu"><strong>{m.workspace}</strong>{selectedThreadId === undefined ? <button type="button" role="menuitem" className={outsideWorkspace ? "selected" : ""} onClick={() => void handleSetCurrentWorkspace(null)}>{m.workOutsideWorkspace}</button> : null}{workspaceState?.directories.map((directory) => <button key={directory.path} type="button" role="menuitem" className={directory.path === currentWorkspacePath ? "selected" : ""} onClick={() => void handleSetCurrentWorkspace(directory.path)} title={directory.path}>📁 {directory.name}</button>)}<button type="button" role="menuitem" onClick={() => void handleChooseWorkspaceForComposer()}>＋ {m.addWorkspace}</button></div> : null}
                <div className="composer-toolbar">
                  <div className="composer-options">
                    <label title={selectedModel?.displayName ?? (modelOptions.length === 0 ? m.modelUnavailable : m.model)}><span className="sr-only">{m.model}</span><select id="composer-model" value={modelSelection} onChange={(event) => { const nextModel = modelOptions.find((model) => model.id === event.target.value); setModelSelection(event.target.value); setReasoningSelection(preferredReasoningEffort(nextModel)); }} disabled={modelOptions.length === 0 || turnIsRunning} aria-label={m.model}>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
                    <label title={selectedModel === undefined || reasoningOptions.length === 0 ? m.reasoningUnavailable : m.reasoning}><span className="sr-only">{m.reasoning}</span><select id="composer-reasoning" value={reasoningSelection} onChange={(event) => setReasoningSelection(event.target.value)} disabled={selectedModel === undefined || reasoningOptions.length === 0 || turnIsRunning} aria-label={m.reasoning}>{reasoningOptions.map((effort) => <option key={effort.id} value={effort.id} title={effort.description}>{effort.id}</option>)}</select></label>
                  </div>
                  <span className="composer-status" aria-live="polite">{interruptingThreadId !== undefined && interruptingThreadId === selectedThreadId ? m.stopping : startingTurn ? m.starting : selectedArchived ? m.archivedReadOnly : historyMode ? m.confirmWorkspaceToSend : newConversationWorkspaceRequired ? m.chooseWorkspace : remoteActive ? m.remoteTurnRunning : inputUnavailable ? m.inputUnavailable : localRunningTurnId === undefined ? null : m.turnRunning}</span>
                  <button className="composer-send" type={canInterruptLocalTurn ? "button" : "submit"} onClick={canInterruptLocalTurn ? () => void handleInterruptTurn() : undefined} aria-label={canInterruptLocalTurn ? m.stopTurn : turnIsRunning ? m.pauseUnavailable : selectedArchived ? m.archivedReadOnly : historyMode ? m.confirmWorkspaceToSend : newConversationWorkspaceRequired ? m.chooseWorkspace : inputUnavailable ? m.inputUnavailable : m.send} title={canInterruptLocalTurn ? m.stopTurn : turnIsRunning ? m.pauseUnavailable : selectedArchived ? m.archivedReadOnly : historyMode ? m.confirmWorkspaceToSend : newConversationWorkspaceRequired ? m.chooseWorkspace : inputUnavailable ? m.inputUnavailable : m.send} disabled={canInterruptLocalTurn ? interruptingThreadId !== undefined : connectionState.state !== "ready" || inputText.trim() === "" || turnIsRunning || inputUnavailable}><span aria-hidden="true">{turnIsRunning ? "Ⅱ" : "➤"}</span><span className="sr-only">{canInterruptLocalTurn ? m.stopTurn : turnIsRunning ? m.pauseUnavailable : selectedArchived ? m.archivedReadOnly : historyMode ? m.confirmWorkspaceToSend : inputUnavailable ? m.inputUnavailable : m.send}</span></button>
                </div>
                <div className="composer-textarea-row">
                  {showWorkspacePicker ? <button className="composer-workspace-picker" type="button" onClick={() => setWorkspaceMenuOpen((open) => !open)} aria-label={outsideWorkspace ? m.workOutsideWorkspace : currentWorkspacePath === undefined ? m.addWorkspace : `${m.workingDirectory}: ${currentWorkspacePath}`} aria-expanded={workspaceMenuOpen} aria-haspopup="menu" title={outsideWorkspace ? m.workOutsideWorkspace : currentWorkspacePath ?? m.chooseWorkspace}><span aria-hidden="true">{outsideWorkspace ? "○" : currentWorkspacePath === undefined ? "＋" : "📁"}</span>{currentWorkspacePath === undefined ? null : <span className="composer-workspace-name">{currentWorkspaceName}</span>}</button> : null}
                  <textarea ref={inputElement} id="turn-input" aria-label={m.sendMessage} value={inputText} onChange={(event) => setInputText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleStartTurn(); } }} placeholder={m.inputPlaceholder} rows={1} disabled={connectionState.state !== "ready" || turnIsRunning || inputUnavailable} />
                </div>
              </div>
              {sendError === undefined ? null : <p className="error-summary">{sendError}</p>}
              {selectedThreadId !== undefined && draftSaveErrors[selectedThreadId] ? <p className="error-summary" role="alert">{m.draftSaveFailed}</p> : null}
          </form>
        </section>
      </section>
      <Onboarding snapshot={onboardingState} onRediscover={() => void handleRediscover()} onChooseExecutable={() => void handleChooseExecutable()} onChooseDirectory={() => void handleChooseDirectory()} onConnect={() => void handleOnboardingConnect()} m={m} />
      {aboutOpen && appInfo !== undefined ? <About info={appInfo} m={m} onClose={() => setAboutOpen(false)} /> : null}
      {editingThreadId === undefined ? null : <RenameModal name={editingThreadName} onChange={setEditingThreadName} onCancel={() => setEditingThreadId(undefined)} onSave={() => void saveThreadName(editingThreadId, editingThreadName)} m={m} />}
      <footer className={`footer${connectionState.state === "error" || connectionState.state === "stopped" || connectionState.error !== undefined ? " visible" : ""}`}><span>{appInfo === undefined ? "ThreadPath" : `ThreadPath ${appInfo.version}`}</span>{connectionState.state === "error" || connectionState.state === "stopped" ? <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>{reconnecting ? m.reconnecting : m.reconnect}</button> : null}{connectionState.error === undefined ? null : <span className="footer-error">{connectionState.error}</span>}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
