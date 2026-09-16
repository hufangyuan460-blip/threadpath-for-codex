import type { DesktopApi } from "../shared/api";

declare global {
  interface Window {
    readonly threadPath: DesktopApi;
  }
}

declare module "*.css" {
  const stylesheet: Record<string, string>;
  export default stylesheet;
}

export {};
