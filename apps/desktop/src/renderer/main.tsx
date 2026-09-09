import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AppInfo, ConnectionStateSnapshot } from "../shared/api";

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [connectionState, setConnectionState] = useState<ConnectionStateSnapshot>({ state: "idle" });
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      const [info, state] = await Promise.all([window.threadPath.getAppInfo(), window.threadPath.getConnectionState()]);
      if (!active) return;
      setAppInfo(info);
      setConnectionState(state);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const handleReconnect = async (): Promise<void> => {
    setReconnecting(true);
    try {
      setConnectionState(await window.threadPath.reconnect());
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ThreadPath</p>
          <h1>ThreadPath for Codex</h1>
        </div>
        <div className="status" aria-label="Connection status">
          <span className={`status-dot status-${connectionState.state}`} />
          {connectionState.state}
        </div>
      </header>
      <section className="empty-state" aria-label="Empty content area">
        <div className="empty-card">
          <p className="empty-kicker">Desktop shell</p>
          <h2>Codex connection {connectionState.state}</h2>
          <p>The application shell manages the local app-server lifecycle. Thread data and conversation views will be added in a later milestone.</p>
          {connectionState.error === undefined ? null : <p className="error-summary">{connectionState.error}</p>}
          {connectionState.serverVersion === undefined ? null : <small>Server {connectionState.serverVersion}</small>}
          {connectionState.state === "error" || connectionState.state === "stopped" ? (
            <button type="button" onClick={() => void handleReconnect()} disabled={reconnecting}>
              {reconnecting ? "Reconnecting…" : "Reconnect"}
            </button>
          ) : null}
          {appInfo === undefined ? null : <small>Version {appInfo.version}</small>}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
