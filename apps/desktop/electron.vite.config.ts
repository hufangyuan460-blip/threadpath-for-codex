import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "./scripts/build-info";

const buildInfo = readBuildInfo(fileURLToPath(new URL("../../", import.meta.url)));

export default defineConfig({
  main: {
    define: { __THREADPATH_BUILD_INFO__: JSON.stringify(buildInfo) },
    plugins: [externalizeDepsPlugin(), {
      name: "threadpath-build-info",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(buildInfo, null, 2) + "\n" });
      },
    }],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs" } } },
  },
  renderer: { plugins: [react()] },
});
