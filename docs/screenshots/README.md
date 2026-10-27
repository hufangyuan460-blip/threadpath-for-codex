# Beta.4 产品截图 / Product screenshots

`beta4-*.png` 来自当前源码实际构建、运行的 Electron 应用，统一为 Graphite 主题、1600×1000 CSS 像素；未修改 DOM、注入样式或合成界面。截图仅使用合成演示数据。

These PNGs capture the running Electron app built from this source, using the Graphite theme at 1600×1000 CSS pixels. They use synthetic demonstration data, with no DOM/style alterations or composited UI.

在仓库根目录运行 / Run from the repository root:

```powershell
pnpm build
pnpm --filter @threadpath/desktop exec node --experimental-strip-types tests/e2e/capture-showcase.ts
```

脚本固定使用现有 `fake-fork-app-server.cmd`，不接受真实 CLI 覆盖；独立的应用用户目录、Codex 目录和环境变量白名单隔离个人配置，不读取私人会话、不产生模型调用。临时项目在忽略的 `artifacts/showcase/` 下创建，退出后核对目标路径并清理。脱敏捕获报告留在 `artifacts/showcase/capture-report.json`，不提交。

The script pins the existing fake server, isolates the app/Codex profiles, and allowlists runtime environment variables. It reads no private conversations and makes no model calls. Temporary projects and profiles are removed after closing the app; an ignored capture report remains under `artifacts/showcase/`.

- `beta4-workspaces.png`：三个合成项目，主动展开其中两个；首页真实布局，不同时显示会话正文。Three demo projects, two explicitly expanded, in the actual home layout.
- `beta4-navigation.png`：12 回合会话，24 个用户/模型目录入口，已跳转到模型回复。A 12-turn conversation with 24 role-aware entries, navigated to an assistant reply.
- `beta4-branches.png`：通过界面从第 6 回合创建两个分支，展示来源和选中路线。Two branches created through the UI from turn 6, with source relationships and the selected route.
- `beta4-observatory.png`：累计 70,000、最近快照 18,234、live 来源和一次已完成压缩；数值均由 fixture 的 JSONL 通知返回。Counters and compaction arrive through fixture JSONL notifications, not injected renderer state.

旧截图仍供历史文档使用，保留文件；根 README 仅引用上述 Beta.4 新截图。
Older images remain available to historical documentation; the root README references only the new Beta.4 captures.
