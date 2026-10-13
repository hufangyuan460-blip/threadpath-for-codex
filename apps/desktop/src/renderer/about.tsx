import { useEffect, useRef } from "react";
import type { AppInfo } from "../shared/api";
import type { Messages } from "./i18n";

export function About({ info, m, onClose }: { info: AppInfo; m: Messages; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  const status = info.commit === null ? m.buildUnknown : info.dirty ? m.buildDirty : info.tag ?? m.buildDevelopment;
  return <dialog ref={dialog} className="about-dialog" aria-labelledby="about-title" onCancel={onClose}>
    <button className="modal-close" type="button" onClick={onClose} aria-label={m.close}>×</button>
    <h2 id="about-title">ThreadPath for Codex</h2>
    <dl>
      <div><dt>{m.appVersion}</dt><dd data-build-version>{info.version}</dd></div>
      <div><dt>{m.buildCommit}</dt><dd className="mono" data-build-commit>{info.commit ?? m.buildUnknown}</dd></div>
      <div><dt>{m.buildStatus}</dt><dd data-build-status>{status}</dd></div>
    </dl>
  </dialog>;
}
