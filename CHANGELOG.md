# 更新日志

所有显著变更记录在本文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.9.0] - 2026-10-31

### 新增（治理台账查看器）

- 服务端治理页新增「查看台账」：新只读端点 `GET /governance/ledger`
  （`readLedger` 导出，按用户目录读取 `git-improve/governance.json`），
  弹窗表格展示最近 50 条停用/启用/清理记录（时间/动作/名称/释放大小，最新在前）。
- 路由级测试 +2（预置台账封顶与排序、空文件不报错）。

## [0.8.10] - 2026-10-31

### 修复（安全）

- 备份「恢复」操作补确认框：恢复会把工作区回滚到备份点、覆盖其后的本地改动——
  原先无确认直接执行（删除备份反而一直有确认）。至此全部危险操作
  （删账号/导入覆盖/更新重装/迁移全局/恢复/删除备份/彻底清理）均有确认。

## [0.8.9] - 2026-10-31

### 改进 / 测试

- 面板 tab 渲染加错误边界：某页签渲染抛错时显示可读错误行，不再卡死在「加载中…」。
- 账号「测试」按钮防双击（验证期间禁用，异常路径恢复）。
- 路由级测试补 `/health`（panelVersions/systemGit 契约）；抽出共享助手
  `test/helpers/route-app.mjs`（branches/health 测试共用最小上下文挂载）。

## [0.8.8] - 2026-10-31

### 新增 / 修复

- **服务端模式分支下拉**：安装页输入仓库地址约 0.7s 后自动经新端点 `GET /branches`
  （引擎 `listRemoteBranches`，ssh/file 由引擎内部路由系统 git；凭据按站点自动解析）
  拉取远端分支列表，填入分支输入框的 datalist——手填仍可用，列举失败静默不打扰。
- **修复**：`.stgi-row input` 的 flex 拉伸规则误伤复选/单选框（渲染成 ~120px 宽的怪异
  白框，账号页「设为默认」最明显）——排除 `[type=checkbox]/[type=radio]`。

## [0.8.7] - 2026-10-31

### 新增 / 改进

- 账号页新增「全部测试」：逐个验证所有已存账号（含浏览器 CORS 拦截的宽限判定），
  完成后 toast 汇总「有效 N，异常 M（清单）」并刷新状态列。
- 服务端诊断页「本体依赖修复」日志统一逐行着色（运行中/完成/失败/警告分级）。
- 日志行新增 warn（黄）级别样式。

## [0.8.6] - 2026-10-31

### 改进（UI 一致性打磨）

- 账号页：删除账号前加确认框（误触即丢凭据的风险点）；账号表上方显示统计行
  （N 个账号 · M 个站点）。
- 安装/更新完成后在日志区提供「刷新页面（立即生效）」按钮（原先只有 toast 提示）。
- 纯前端「全部更新」与单扩展更新对话框日志统一为逐行着色（成功绿 / 失败红），
  与安装页日志同款（`appendLogLine` 统一入口）。

## [0.8.5] - 2026-10-31

### 新增（面板自更新检查）

- 设置页新增「面板更新」区（双模式通用）：读自身 manifest 的 `homePage` 解析 origin 仓库，
  经 `api.github.com` contents API 拉取最新 `extension/manifest.json`（公开仓无需凭据，
  有 CORS），与当前版本对比显示「已是最新 / 有新版本 + 打开发布页」。
- 纯逻辑模块 `extension/src/core/selfupdate.js`（origin 解析 / base64→UTF-8 / 版本比较 /
  检查流程，fetch 可注入），测试 +10。
- 修正 manifest `homePage` 指向真实仓库 `jiozhaoyue/st-git-improve`（原为占位形态，
  会让自更新检查指向不存在的仓库）。
- 运维：`test-results/`（UI 截图产物，含实例聊天背景）入 `.gitignore`。

## [0.8.4] - 2026-10-31

### 新增（通道可视化与环境诊断）

- **安装页通道实时提示**：输入仓库地址即时显示将走的克隆通道（HTTP(S) 克隆 / 系统 git 桥）
  与凭据来源；纯前端模式输入 SSH/file 地址即时红字警示不可用（浏览器无法执行系统 git），
  安装按钮兜底拦截并给出替代指引。判定逻辑与引擎 `isSystemGitUrl` 同规则镜像到纯逻辑模块
  `extension/src/core/giturl.js`（三形态同构，可单测）。
- **诊断页「运行环境」卡**：服务端模式汇总面板版本对（当前 / 插件内置 / 数据目录）、
  系统 git 桥可用性与版本、git 代理模式；纯前端模式显示浏览器克隆能力 / SSH 桥不可用 /
  凭据存储通道 / 宿主扩展通道可达性；支持手动刷新。
- 插件 `/health` 新增 `systemGit {available, version}`（`systemGitVersion()` 新导出，
  spawnSync 探测结果一次性缓存）。
- **面板版本守卫升级**：设置页始终显示版本对（当前 / 插件内置 / 数据目录）并新增手动
  「重新检查」按钮（强制重探测运行模式）；内置副本落后时「设置」tab 标题加 ⚠️ 徽标。
- 安装/更新日志逐行着色（成功绿 / 失败红）。
- 测试 +13（giturl 通道分类与提示 12 + 引擎系统 git 探测一致性 1），`npm test` 125 项。

## [0.8.3] - 2026-10-28

### 新增（SSH/file 桥——README 二期承诺落地）

- 引擎新增系统 git 通道：`git@host:path`（scp 语法）、`ssh://`、`file://`、`git://` 地址在服务端插件的安装/更新/诊断中自动路由（clone / ls-remote / fetch 全覆盖；完整克隆避免浅克隆重 graft 问题；更新时 isomorphic-git 的本地对象读取与备份/前进语义不变）。
- `normalizeRepoUrl` 接受 scp 语法并规范化为 `ssh://`。
- 凭据：SSH 走用户自己的 ssh-agent/askpass（不经过凭据存储）；无系统 git 时明确报错。
- 密闭测试 +5（本地裸仓 + file:// 全流程：安装 / 重建式更新 / 已是最新），`npm test` 112 项。纯前端模式仍不支持 SSH（浏览器无此能力）。

## [0.8.2] - 2026-10-28

### 新增（治理一致性）

- 服务端治理只读合并宿主设置禁用状态：`listGovernance` 读取宿主
  `extension_settings.disabledExtensions`（兼容旧根级形态），local/global 条目带
  `settingsDisabled` 标记，响应含 `settingsDisabledNames`；面板服务端治理页为这类
  条目显示「宿主设置停用」徽标（与整目录停用区分）。**刻意只读不写宿主设置**
  （服务端直写 settings.json 会与宿主内存态竞态）。测试 +1，`npm test` 107 项。

## [0.8.1] - 2026-10-28

### 新增（面板回退守卫）

- 服务端插件 `/health` 新增 `panelVersions {bundled, installed}`
  （`bootstrapFrontendExtension` 返回版本对）；面板比较内置副本与当前版本，
  **内置副本落后时在设置页显著警告**「宿主重启会回退面板 + 指明需同步的目录」
  （第十二节实测隐患的产品化）。`compareVersions` 三段比较含单测，`npm test` 106 项。

## [0.8.0] - 2026-10-28

### 新增（纯前端能力补全）

- **纯前端「更新」**：实测宿主不支持覆盖安装（409 Directory already exists）后，
  实现「删除旧目录 → 重装最新版」的更新语义（`/api/extensions/delete` + install）。
  更新按钮带确认框（明示扩展目录内本地改动不备份）；「全部更新」按同一语义顺序执行。
- **纯前端「迁全局/迁本地」**：实测接入 `/api/extensions/move`
  （extensionName 不带 `third-party/` 前缀，source/destination 为 local|global，成功 204），
  治理页显示安装范围并支持双向迁移（迁全局需确认——对所有用户生效）。
- **安装来源登记**：纯前端安装成功后登记 `{url, branch, target, oid, installedAt}`；
  诊断页据此显示来源并提供「更新」；合并策略扩展到 installs。
- **验证成功自动回填用户名**；账号页显示最近验证时间。
- **设置页「重新探测运行模式」**：服务端插件中途安装/卸载后即时切换（模式变化自动重开面板）。
- 私有安装页纯前端模式提供「目录已存在时删除旧版重装」勾选。

### 实测覆盖（Dev ST 8001 · 纯前端模式，全部通过）

replace 重装（409→删旧→装新）、更新按钮全流程（预检→克隆降级→删旧→重装→完成）、
迁移按钮按范围渲染、停用→启用恢复、账号用户名回填与验证时间显示。`npm test` 105 项。

## [0.7.6] - 2026-10-28

### 修复（全部来自 Dev 实例活体实测，0.7.1–0.7.6 合并记录）

- **纯前端安装对 CORS 的正确降级**：GitHub 等 git 端点不发 CORS 头，浏览器内克隆必然失败。
  改为「API 预检（支持 CORS，能给出 401/404 的清晰错误）→ 宿主原生安装（服务端克隆，无 CORS 约束）
  为主路径」，浏览器内克隆降级为 zip 导出增强，失败不再阻断安装。
- **凭据持久化竞态**：`saveSettingsDebounced` 存在静默丢写；ST 通道改为双保险
  （上下文保存 + `/api/settings/get→save` 直写）。实测 ST 1.19 契约：GET 返回
  `{ settings: "<JSON 字符串>" }`，POST 请求体为**裸 settings 对象**。
- **多通道合并**：读取时按（类型+地址+用户名）对宿主设置/localStorage 两通道去重合并，
  任一通道的数据不再被另一通道覆盖丢失；defaults 只保留指向存在账号的映射。
- **扩展模块 HTTP 缓存**：宿主缓存扩展模块文件，更新后旧代码继续生效。全部跨模块 import
  带上 `?v=<manifest version>` 参数，发版时同步修改 `const V`（vendor 脚本同样处理）。
- **纯前端治理键位**：实测宿主读取 `extension_settings.disabledExtensions`（条目
  `third-party/<name>`）并在重载时拒载清单内扩展；按此实现停用/启用（此前写在根级字段
  被保存端点静默忽略）。
- **诊断列表端点**：`GET /api/extensions/discover`（无 body）返回
  `[{type:'local'|'global'|'system', name:'third-party/<名称>'}]`；修正调用方式与第三方过滤。

### 实测覆盖（Dev ST 8001 · 纯前端模式）

账号添加→自动验证(jiozhaoyue)→双通道落盘→重载恢复；私有仓 ST-Switcher 安装→宿主识别；
治理停用→宿主拒载（仅拉 manifest）→启用→恢复加载。全量 `npm test` 104 项。

## [0.7.0] - 2026-10-28

### 新增（纯前端模式 —— 本版核心）

面板现在**不再依赖服务端插件**：`/api/plugins/st-git-improve/health` 探测失败时自动进入
纯前端模式（L0-11 适配器 + 特性检测 + 静默降级），全部核心功能照常可用：

- **多账号管理（「账号」页）**：每个 git 站点逐个登录多个账号（PAT / userinfo 地址提取），
  浏览器侧持久化（宿主设置 `extension_settings.st_git_improve`，localStorage 兜底），
  站点内默认账号可切换；支持 JSON 导出/导入；服务端模式可将账号「推送服务端」同步给插件。
- **纯前端私有安装**：浏览器内克隆（isomorphic-git 1.27 UMD + 自研 fetch HTTP 客户端 +
  内存 fs），凭据经 `onAuth` 注入；私有仓库以 `user:token@host` 内嵌凭据交给宿主原生
  `/api/extensions/install` 通道安装；克隆结果可导出本地 zip 备份。
- **纯前端治理**：经宿主设置 `disabledExtensions` 开关扩展加载（目录与数据完全不动）。
- **纯前端诊断**：经宿主原生 discover 列出已装扩展（只读）。
- 面板标题栏显示运行模式徽标（服务端增强 / 纯前端）。

### 新增（工程）

- `extension/src/core/`：`sites`（站点适配）、`accounts`（多账号库）、`storage`（三通道持久化）、
  `memfs`（内存 fs）、`zip`（store-only ZIP 写入器，零依赖）、`gitbrowser`（浏览器 git 引擎）、
  `vendor-loader`、`backend`（模式探测与宿主原生通道）、`installflow`（安装编排）。
- `extension/vendor/`：isomorphic-git UMD（自带 LICENSE）；`scripts/build-vendor-buffer.mjs`
  从既有 node_modules 机械拼接 buffer/base64-js/ieee754 生成 `buffer.umd.min.js`（零新依赖）。
- 纯逻辑单测 31 项（`test/fe-*.test.js`）：zip 往返/CRC 篡改、memfs 语义、URL 解析、
  多账号库行为；全量 `npm test` 100 项。

### 兼容性说明

- 浏览器直连自建站点（Gitea/GitLab 自建）可能被 CORS 拦截：验证按钮会明确标注
  「浏览器直连被拦截」，凭据仍保存，实际以 git 操作结果为准。
- ssh 协议仓库地址明确拒绝（浏览器无 ssh），提示改用 https。

## [0.6.2] - 2026-10-26

### 修复（前端面板）

- **面板从未能加载的致命语法错误**：`tabInstall` 在非 async 函数中使用顶层 `await`，
  导致整个模块解析失败——面板在所有宿主上静默消失。由活体 E2E（真实宿主 + 浏览器）发现。
- 弹窗 `show()` 假定 tab 工厂返回 Promise，同步返回元素的 tab 打开即崩；现以
  `Promise.resolve()` 归一化。
- 菜单注册不再依赖模块执行时序：等待 + `MutationObserver` + 有界重挂
  （宿主异步建菜单、其他扩展可能重建菜单均不再丢入口）。

### 新增（工程）

- 前端 parse 门禁纳入 `npm test`（`test/panel-parse.test.js`）。
- 安装脚本自动检测宿主 `enableServerPlugins` 并提示（不代改实例配置）。
- GitHub Actions：node 20/22/24 矩阵跑 `npm test` + parse 门禁。

## [0.6.1] - 2026-10-26

### 修复

- 面板所有写请求携带 `X-CSRF-Token`（ST 1.19 对 POST/DELETE 强制校验，缺失即 403）。

## [0.6.0] - 2026-10-26

### 新增

- **全局扩展治理**页：总览本地/全局/停用区/插件四类资产与磁盘占用；
  停用（整目录搬入 `extensions-disabled/`，数据随目录各自保存）、启用、
  彻底清理（逐行确认）释放磁盘；治理台账（封顶 200 条）。
- 一键停用全部 / 全部启用（管理面板自动跳过）。
- 备份管理：备份 ref 可删除（仅允许 `refs/git-improve/backup/` 前缀）。
- 「全部更新」：批量更新所有 git 管理的扩展/插件，单个失败不中断。

### 修复

- 私有源扩展/插件的更新与批量更新现在会携带对应站点的凭据
  （此前更新私有源会 401，与安装能力不对称）。

## [0.5.0] - 2026-10-26

### 新增

- 扩展治理后端：`/governance` 路由族（总览/停用/启用/清理）与治理台账。

## [0.1.0] - 2026-10

### 首个可用版本（MVP）

- 私有源认证安装（PAT / 账密换 token / OAuth 设备码 / userinfo URL 提取）。
- TT 式重建更新（本地改动自动备份到 `refs/git-improve/backup/*`，原子重建）。
- npm 依赖自动安装与修复（可选 lock 重建），本体依赖修复。
- 安装去重（仓库名 / 仓库名+版本号颗粒度）+ 重复扫描清理 + 启动自动清理。
- 显式代理开关（直连 / 跟随环境变量 / 自定义代理）。
- 诊断页：依赖缺失 / manifest 损坏 / 本地改动 / 远端不可达 / 备份恢复。
