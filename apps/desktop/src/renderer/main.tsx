import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { AppInfo, ConnectionInfo } from "../shared/api";

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | undefined>();

  useEffect(() => {
    void Promise.all([window.threadPath.getAppInfo(), window.threadPath.getConnectionInfo()]).then(([info, connection]) => {
      setAppInfo(info);
      setConnectionInfo(connection);
    });
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ThreadPath</p>
          <h1>ThreadPath for Codex</h1>
        </div>
        <div className="status" aria-label="Connection status">
          <span className="status-dot" />
          {connectionInfo?.status ?? "checking"}
        </div>
      </header>
      <section className="empty-state" aria-label="Empty content area">
        <div className="empty-card">
          <p className="empty-kicker">Desktop shell</p>
          <h2>Ready for the protocol layer</h2>
          <p>The application shell is running. Codex connection features will be added in a later milestone.</p>
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
