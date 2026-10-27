# M7-A Beta.4 发布准备与 Windows 打包记录

## 范围与版本

- 起始 main：`b82911a69747243a9a329b3cbdb8c4d81235a55d`，工作区及索引干净。
- 桌面版本由 `0.1.0-beta.3` 升为 `0.1.0-beta.4`；锁文件不含需同步的桌面版本字段，未升级依赖。
- Windows `10.0.19045` x64、Node `v24.19.0`、pnpm `11.7.0`、Electron `37.3.1`、electron-builder `26.0.12`。
- 本轮只改 package 版本和发布文档，不改产品功能、存储格式、测试矩阵或发布流水线。
- `v0.1.0-beta.3..b82911a` 共六个后续提交：独立工作区、用户/模型消息目录、Usage 观测、历史与未知终态修复，以及验收基础设施和记录。中英文 [Release Notes](releases/v0.1.0-beta.4.md) 分别说明用户变化与验收工具。

## 离线回归

| 实际命令 | 结果 |
| --- | --- |
| `git diff --check` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test` | PASS，含协议、桌面、发布 guard 与验收工具离线测试 |
| `pnpm.cmd test:e2e` | PASS，全部现有 fake-server 桌面 E2E |
| `pnpm.cmd build` | PASS |
| 协议包 `npx.cmd --no-install tsc --noEmit` | PASS |
| `pnpm.cmd package:win` | 首次因工具归档 macOS symlink 权限失败；仅调整会话缓存后重试 PASS |
| 设置实际 `THREADPATH_PACKAGED_EXE` 后 `pnpm.cmd --filter @threadpath/desktop test:packaged` | PASS，六组实际 EXE 测试 |

打包程序测试覆盖 About 版本/来源与焦点、新建及索引延迟、独立工作区、分支截断/同级/嵌套/草稿与重启、来源分页/失败/缺失/迟到响应、归档恢复/活动拒绝/失败与重启。临时用户目录及 fake server 避免读取个人会话；未运行真实 Codex CLI、模型、M6 验收或状态修改。

进程使用 `pnpm_config_verify_deps_before_run=false` 运行现有依赖；未安装或升级依赖。首次失败不属于客户端或协议错误：winCodeSign 归档含 macOS 符号链接，Windows 当前权限无法创建。将官方 `winCodeSign-2.6.0.7z` 的 SHA-512 与已安装 builder 内置摘要匹配，仅在会话缓存解压除 darwin 目录外的原始内容，再通过 `ELECTRON_BUILDER_CACHE` 重试；没有禁用 EXE 资源编辑、改系统权限或项目配置。最终产物图标独立检查通过。非阻塞警告包括既有 DEP0190、构建 chunk 大小及 package description/author 缺省。

## 本地 Windows 产物

| 项目 | 实际结果 |
| --- | --- |
| 安装器 | `release/ThreadPath for Codex Setup 0.1.0-beta.4.exe` |
| 字节数 | `88568332` |
| SHA-256 | `7ea8e3af604407f8b3b72b7241043df8ffd1df4595f798bff8ea6750f73752bb` |
| 清单 | `release/ThreadPath-0.1.0-beta.4-build.json` |
| 校验文件 | `release/ThreadPath-0.1.0-beta.4-SHA256SUMS.txt` |
| 打包时来源 | `commit=b82911a69747243a9a329b3cbdb8c4d81235a55d`, `dirty=true`, `tag=null` |
| 应用版本 | ASAR/package、About、Electron `app.getVersion()` 均为 `0.1.0-beta.4` |
| PE 资源 | 应用 Machine `8664`（x64）；NSIS bootstrap `14c`（x86 启动器，包含 x64 应用），两者有效 MZ/PE |
| 原生版本 | 应用 FileVersion 与安装器 FileVersion/ProductVersion 为 `0.1.0-beta.4`；应用数字 ProductVersion 为 `0.1.0.0`，不代替 About 的完整 SemVer |
| 签名 | 应用与安装器均为 NotSigned |
| 图标 | packaged runtime ICO 与源文件字节一致；应用和安装器 PE 中各 7 种源图标图像均匹配 |
| 内容 | 每份 out 文件与 ASAR 字节相同，ASAR 无多余旧 out 文件或项目 artifacts/tests/scripts；安装器内 ASAR 与被测 win-unpacked ASAR 字节相同 |
| 摘要与清单 | 独立重新计算、读回 manifest 和 SHA256SUMS，结果一致 |
| 实际 NSIS 安装/卸载 | NOT TESTED；没有隔离系统环境，未改用户系统安装状态 |

这是提交前的**开发态验证包**，不是最终准备提交或未来标签的干净构建；后续文档收尾不改变产品运行代码，dirty 状态仍为 true。不得把此摘要用于未来 Actions 正式安装包。正式 Release 必须从后续独立授权的干净标签重新构建测试。本轮未运行 `package:release` 或 `verify:release`，因为没有创建正式标签；复用 `inspectArtifacts` 独立完成开发产物检查，不放宽正式门禁。

Beta.3 旧安装器、构建清单、校验文件三份摘要保持不变；M6 的十份历史报告摘要保持不变。原始 artifacts、测试用户目录、构建输出及 release 仍被 Git 忽略，没有加入提交。

## 发布流水线与 GitHub 状态

静态检查现有 `release.yml`、`build-info.ts`、`release-artifacts.ts` 和 `publish-release.ts`，未发现本轮需修复的 P0/P1：

- 标签触发默认检出事件对应 ref/SHA，完整历史；要求 ref 名为 `v<package.version>`，正式打包检查干净源码及标签 commit 等于 HEAD。
- 冻结锁文件安装后执行类型、离线与桌面 E2E，再正式打包、实际 EXE 六组测试，最后才调用发布脚本。
- 发布前重新验证产物和远端标签 commit；已有 Release 拒绝覆盖；新建草稿后上传安装器/构建清单/SHA256SUMS，全部返回的大小和 digest 验证通过才公开。
- 动态版本与文件名规则支持 Beta.4；默认测试含 annotated/missing/mismatched tag、dirty/untracked 和移动 HEAD 负例。

远端 refs 未发现 `v0.1.0-beta.4`；GitHub 公开 API 返回 Beta.3 与 Beta.1，无公开 Beta.4 Release。未认证公开查询不保证能枚举维护者私有草稿；正式发布入口仍会拒绝任何已存在的同名 Release。未触发或宣称 Beta.4 CI 发布成功。本轮不创建/推送标签、不执行 publish、不修改任何既有 Release。

## 开源准备与后续决定

仓库没有项目 LICENSE、CONTRIBUTING 或 SECURITY 文档。README 的“许可证尚未确定”保持不变。维护者需选择许可与二进制分发授权，例如 MIT（宽松）、Apache-2.0（含明确专利条款）、GPL（copyleft）或非开源授权，并评估依赖义务；本轮不代作决定。没有明确许可会限制第三方代码复用、修改、再分发及要求 OSI 许可的开源项目申请。贡献指南和安全报告政策是后续建议，不是本轮本地打包阻塞。

## 保留限制与结论

Windows x64 Beta、未签名、不包含 CLI、需自行认证、无自动更新。无精确上下文占用率或费用估算；Usage 内存快照与压缩历史不证明完整实时生命周期。`M6_C4_FULL_LIFECYCLE: INCOMPLETE` 保持不变。无实际 NSIS 安装/卸载或跨版本安装迁移保证；存储格式未变，无新增迁移。

本地版本、离线回归、NSIS 内容和实际打包程序验收通过，满足 M7-A 源码准备门禁；最终提交及远端一致性以任务完成报告的实际 SHA 为准，不硬编码未来提交。正式标签及公开发布需要后续独立步骤。
