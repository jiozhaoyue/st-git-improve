# 更新日志

所有显著变更记录在本文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
