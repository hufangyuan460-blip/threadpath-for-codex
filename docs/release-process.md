# 版本识别与发布流程

适用范围：Windows x64 NSIS 安装包；2026-10-13 核对。正式发布由 GitHub Actions 的 `Release` 工作流执行，普通开发打包仍可用 `pnpm package:win`。

## 应用内识别

点击左上角「ThreadPath for Codex」，打开「关于」：显示应用版本、完整源码提交号、构建状态。版本与提交在构建时固定，通过主进程的 `app:get-info` IPC 返回；用户电脑无需安装 Git。未提交源码显示「开发构建 · 含未提交改动」，无法识别源码时明确显示未知。

## 发布一个新版本

1. 更新 `apps/desktop/package.json` 的 SemVer 版本，并新增 `docs/releases/v<version>.md` 中英文发布说明。一个版本只发布一次。
2. 安装依赖，执行 `pnpm typecheck`、`pnpm test`、`pnpm test:e2e`。这些是合成 app-server 测试，不需要用户认证，也不替代真实模型体验验证。
3. 按 `AGENTS.md` 的中英文 Conventional Commits 提交源码与文档，确认工作区干净，并推送提交。
4. 在实际发布提交创建同名标签，例如：

   ```powershell
   git tag -a v0.1.0-beta.2 -m "发布 Beta.2 / Release Beta.2"
   git push origin v0.1.0-beta.2
   ```

5. 标签触发 `Release`：重新检查类型、离线测试和桌面 E2E，执行 `package:release`，测试实际打包 EXE，然后发布独立安装包、构建清单与 SHA-256 校验文件。

发布检查要求版本标签指向当前源码提交，且没有已跟踪或未跟踪的未提交文件。打包前后重新比较源码信息；核对 ASAR 内全部构建文件、内置版本和运行时图标；解压读取安装器的 ASAR 内容并与被测试的应用逐字节对照。发布前再次核对远程标签的实际提交，上传后核对 GitHub 返回的大小与 SHA-256。

已存在的 release 不会被替换。上传先创建草稿，三个文件均核对成功后公开；若上传失败，保留草稿与 CI 证据，不移动标签、不覆盖公开文件。确认从未公开的失败草稿后，可由维护者清理草稿再重跑原标签工作流；已公开版本的问题必须发布下一版本。

## 本地核对同一标签

在该标签的干净源码目录中执行：

```powershell
pnpm --filter @threadpath/desktop package:release
$env:THREADPATH_PACKAGED_EXE = Join-Path (Get-Location) 'release/win-unpacked/ThreadPath for Codex.exe'
pnpm --filter @threadpath/desktop test:packaged
pnpm --filter @threadpath/desktop verify:release
```

构建清单 `release/ThreadPath-<version>-build.json` 记录版本、完整提交、标签、未提交状态，以及安装器文件名、字节数和 SHA-256。`ThreadPath-<version>-SHA256SUMS.txt` 使用 GitHub 下载文件名（空格被规范为点）。正式发布以 GitHub 工作流生成的安装器和校验值为准；不同环境的 NSIS 文件可能因构建时间等因素而字节不同。

## 固定验收路径

自动验收在临时用户目录和合成服务端运行，不读取真实会话：

- 版本：正常连接时能打开「关于」，显示源码版本和提交；键盘关闭后焦点返回入口；中文、浅色和最小窗口可用。
- 首页新建：输入提交后进入会话，首条输入立即可见；历史索引延迟不清除选择，重启恢复草稿。
- 分支：从已结束回合创建分支，继承到指定回合，独立回复不污染来源；切换和重启保留各自草稿与路线。
- 来源：从分支跳回稳定的源回合，包含分页、失败重试与取消迟到响应。
- 工作区和归档：目录标签与路径对应；活动操作拒绝归档；归档后默认隐藏、可读取、恢复后续聊；重启保留状态。

真实使用验收建议在专用测试项目创建一段方案讨论，分出替代方案、回到源问题、保存两份草稿并重启，再归档和恢复分支。记录期望与实际行为，同时在「关于」复制版本和提交号，以便定位反馈。

## 兼容与回退

Beta.2 不变更会话、草稿或工作区存储格式。Beta.1 的历史发布保留原样；不把其过去更新过的安装包误称为严格按标签构建。当前发布流程不提供自动更新或代码签名；回退时可手动使用旧版安装包。
