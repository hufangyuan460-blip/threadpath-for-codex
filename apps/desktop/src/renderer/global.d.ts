import type { DesktopApi } from "../shared/api";

declare global {
  interface Window {
    readonly threadPath: DesktopApi;
  }
}

export {};
