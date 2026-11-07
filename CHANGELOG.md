# 更新日志

所有显著变更记录在本文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.9.3] - 2026-11-07

### 新增

- **安装入口输入归一化**：支持 `owner/repo` 简写（自动补全 GitHub）、`gh:` / `gitee:` /
  `gitlab:` 前缀短写、无协议 host/path 补全（`github.com/a/b`）、GitHub/Gitee 仓库页面
  地址（`/tree/...`、`/blob/...` 等）自动提取仓库根。输入期间提示行预告识别结果（不打断
  输入），失焦回填完整克隆地址，提交前再归一化一次（`giturl.js` 纯逻辑
  `normalizeRepoInput`，单测 +13）。
- **安装前仓库摘要**：输入地址约 0.7s 后经站点 API 拉取仓库描述 / 默认分支 / 星标 /
  最近推送，摘要行展示——防装错仓库、防装死仓库；失败降级（404 时提示
  「仓库摘要不可见——登录该站点后可查看」，其余静默）。
- **来源登记补录**：手动安装/其它途径装的扩展（未登记来源）行内新增「登记来源」
  （官方 INPUT Popup 输入地址，支持短写归一化），登记后即可用行内更新与远端检查。
- **仓库主页链接**：「我的扩展」已装列表中登记过来源的扩展名旁显示 ↗ 链接
  （scp/https 克隆地址转网页地址，`repoWebUrlFromClone`）。
- **台账导出 / 过滤 / 清空 / install 动作**：台账支持导出 JSON（全部记录）、按动作过滤
  （安装/卸载/停用/启用/迁移/删副本）、清空（官方 Popup 强确认）；安装成功与补录来源
  以「安装」动作留痕（绿色徽标）。
- **失效来源登记清理**：检测指向已不存在扩展的登记残留（面板外卸载所致），一键清理
  （`AccountStore.removeInstall`）。
- **环境卡存储用量**：运行环境卡新增「浏览器存储用量」行（`navigator.storage.estimate`，
  不支持时静默省略）。
- **安装入口「粘贴」按钮**：一键粘贴剪贴板仓库地址并触发归一化识别（授权失败明确提示）；
  分支与目标选择挪到第二行，窄抽屉不再拥挤。
- **安装目标记忆**：用户扩展 / 全局扩展的选择记忆到 localStorage（UI 偏好，丢失无损失）。
- 地址框 / 分支框 **Enter 直接提交安装**；分区入口行 hover 显示跳转箭头；表格行悬停高亮。
- **浏览器内克隆进度日志**：`onProgress` 接入安装日志（receiving 阶段按 10% 步进——
  高频回调不逐条驱动 DOM，L1-MR-9）。
- 已装列表标题行加**排序**（默认 / 按名称 / 按安装时间）；面板 inline-drawer 标题行
  **常显三态徽标**（收起也能看到运行态）；日志完成态加「收起」按钮。
- **完整数据备份**：快捷动作新增「导出全部数据」（账号库快照 + 来源登记 + 台账合并单
  JSON）与「导入全部数据」（格式校验 → 合并确认 → 逐条恢复 → 三处即时刷新；
  `governance-log.importAll` 按 ts+action+name 去重合并）——迁移新机器一个文件带走。
- 面板尾部新增**「使用帮助」折叠区**（7 条 FAQ：私有仓 404 语义 / SSH 不可用原因 /
  更新是否丢本地改动 / 停用 vs 卸载 / 失效登记是什么 / 数据存在哪里 / Authority 功能在哪）。
- **分区入口 sticky 常驻**：长面板滚动时分区导航粘在抽屉可视区顶部，随时跳转
  （底色与宿主抽屉底色同源减透明）。
- **已装列表 scope 徽标**（用户扩展 / 全局扩展）——同名 local/global 两行靠它区分；
  治理表同名扩展的 scope 混淆同步修复（Map 按名取值被后写者覆盖）。
- **日志区「复制日志」常驻按钮**：日志显示时就绪（排障正发生在失败场景——原实现
  只在成功完成时出现，失败日志无任何操作按钮），安装 / 更新 / 批量更新三处接通。
- 环境卡**「复制环境信息」**按钮（版本对 / 能力态 / 账号统计进剪贴板，排障用）。
- **安装地址历史**：登记过的仓库地址进安装入口 datalist，重装/换分支免重输。
- **面板打开时静默自更新检查**：后台运行、失败完全静默，6h 频控（手动检查不受限）。

### 修复（数据正确性）

- **导出下载从未生效**：`template.content` 里的 `<a download>` 调 `click()` 不触发下载
  （实测 createElement 形态触发、template 形态静默无效）——面板 `el()` 全走 template
  路径，**账号导出（0.7.0 起）/ 台账导出 / 全部导出三处按钮从未真正下载过**。
  统一 `triggerDownload` helper（createElement + 插入 DOM + 回收 objectURL）。
- **模块缓存参数不一致**：`installflow` / `accounts` / `vendor-loader` / `gitbrowser`
  四模块的 `?v=` 仍停在 0.8.3（发版后旧模块可能继续生效），统一升至 0.9.3；
  `capability.js`（backend.js）与 `i18n/index.js`（strings.js）两处**静态 import**
  不带版本参数（相对引用不继承调用方 `?v=`），全部收口为动态 import。
- **backend.js 死代码清理**：服务端插件通道残留（`pluginApi` / `detectMode` / `getBackend`
  / API 常量——纯前端架构下无人调用且端点已不存在，-66 行）。
- 卸载成功后自动清理来源登记；删除本地重复副本时同步清理本地登记
  （失效登记的主来源就地消化，不再依赖手动清理）。
- **安装登记名错位**：来源登记曾用 manifest 的 `display_name`，而宿主安装目录名恒为
  仓库名——`display_name` 与目录名不同的扩展会登记到错误名字上，行内更新/远端检查
  按 discover 的扩展名查登记查不到（更新按钮不出现）。登记名固定为 `repo.repo`，
  `display_name` 仅作安装完成的展示名。
- **宿主通道有界等待**：`hostApi` 全部调用补默认 15s 超时（安装放宽 180s）；
  `getCsrfToken` 补 5s 超时且**失败不再缓存空 token**（此前一次失败会让后续
  所有写请求带空 CSRF token 403 到刷新页面为止）；自更新检查补 10s 超时。
- 清理死键 `acc.exportLink`。

### 修复（UI）

- 复选框渲染成竖条怪块：之前为防 flex 拉伸写的 `width: auto` 压掉了宿主设计的
  `--mainFontSize` 正方形尺寸；显式还原正方形，并用 `inline-grid` 恢复宿主
  `display: grid` 吞掉的行内布局（checkbox 曾在 label 里独占一行、与文字分行）。
- label 内 checkbox 与文字换行错位：改 flex 左右列对齐（换行文本对齐文字起点）。
- 表头文字竖排截断（「版本/远端」在窄抽屉里被 `word-break: break-all` 逐字断行）：
  表头 `nowrap`；扩展名折行：名称主名 `nowrap`（备注/来源行仍可断）。
- 分区标题增加左强调条（主题引用色），层级更清晰。
- 诊断列「需 Authority」由永久灰按钮改为轻量 note 文本（纯前端恒不可用，按钮形态误导）。

### 修复（自建站点 API 全链路）

- 自建站点 host 无法判型（`parseRepoUrl` 对自建一律返回空 type，gitea 的 `detect`
  显式 false）→ 分支列举 / 远端状态 / 仓库摘要全不可用。重构为**候选端点探测**：
  未知 host 依次试 gitea → gitlab API 形态，404 才换下一个，401/403/网络错误直接上报。

### 安全

- 快捷动作「全部更新」前置官方 Popup 强确认：批量更新 = 逐个删旧目录重装（不可恢复
  语义），此前点击即执行；现在明示条数、红字后果与单项更新指引。

### 更新冲突识别与修复（2026-11-07 深夜迭代）

- **原生无损更新优先**：行内「更新」与「全部更新」改走宿主原生更新通道
  （`POST /api/extensions/update`，ST 原生更新按钮同款；契约经随仓 ST 前端源核对、
  Dev 实测待复核）——能快进则直接更新并**保留本地改动**，写台账「更新」动作；
  更新被拒时 git 原地中止无副作用，故探测无需事前强确认。
- **冲突自动识别**：`conflict.js` 纯逻辑分类器解析 git 错误原文（宿主失败响应体与后端
  日志同源，前端可见）——「untracked/local changes working tree files would be
  overwritten」头行 + TAB 清单逐条抽取（2188 文件量级实测样本单测覆盖）、并列头行合并
  去重、diverged/network/other 分型。
- **修复卡**：识别结果以独立容器卡片呈现（日志区 max-height 180px 会裁剪高卡片——
  实测后移出）：冲突形态说明 + 挡道文件清单（前 50 条预览防 DOM 爆炸，完整清单走
  「复制日志」）+ 备份态如实标注（纯前端无文件读取通道不可用，`repairByRebuild`
  预留 `backupFn` 注入点供 Authority 备份通道接入）+「重建修复」官方 Popup 强确认。
- **重建修复**：删旧目录 + 宿主重装（等效「只删冲突文件 → ff 更新」的重建形态，
  冲突未跟踪文件随目录一并清除），完成后写台账「重建修复」动作（含挡道文件数明细）；
  宿主无原生更新通道（404）时回退同引擎。
- **面板自更新执行**：自检发现新版本后「无损更新面板」按钮显现——原生无损优先
  （能快进保留本地改动，台账留痕）；被拒不自动重建（面板自灭风险，引导到行内修复卡
  统一强确认）；无通道时强确认后删旧重装回退。`selfExtensionName` 从模块 URL 解析
  自身安装目录名（global/third-party/URL 编码形态，+4 单测）；顺修「打开发布页」
  链接随重复检查堆叠。
- **修复卡「复制清单」**：完整挡道文件路径逐行进剪贴板（卡内 pre 只预览前 50 条），
  供手动清理比对。
- **登记 oid 同步**：原生无损更新成功 / 重建修复完成后，把更新后的 HEAD（原生通道的
  shortCommitHash 前缀 / 重装后站点 API 取的远端 sha）回写来源登记——否则登记 oid 停留
  旧值，远端状态列会假阳性「有新版本」（点更新又显示已最新）；取不到时置空，远端列
  如实降级为「无法比较」。
- **批量全部更新同语义升级**：逐项原生优先；冲突项**不自动重建**（破坏性需逐项确认，
  D9-3），留痕「需修复」引导到行内修复卡。
- **亮色主题遗留项前置修正**：`check-light-theme` 的 LIGHT 映射此前把 `--SmartThemeBodyColor`
  （文字色）设成浅色，浅底白字整体洗白；改深色文字后复核，日志/修复卡底色由纯 alpha 黑
  改为主题自适应 `color-mix`（亮色浅灰、暗色近黑）。
- 壳 mock `POST /api/extensions/update` + `localStorage.__stgiDemoUpdateConflict`
  演示开关（`untracked` / `local`）与自检确定性演示（`__stgiDemoSelfUpdate`，api.github.com
  对壳环境间歇可达收编为 mock）；`check-conflict-repair` 九案（无损成功 / 冲突卡+复制清单 /
  重建全流程 / 台账留痕 / 本地改动冲突 / 自更新执行 / 批量冲突不自动重建 /
  无通道回退重建 / 分叉专文案）入 `npm run verify`。

### 工程与验证

- 新增 dev 工具族（standalone 壳零实例验证）：`shot-standalone`（UI 截图，`--multi`
  多扩展演示注入）、`inspect-styles`（计算样式抽查）、`check-input-normalize` /
  `check-iter2-interactions` / `check-register` / `check-repo-summary` / `check-iter7` /
  `check-backup` / `check-user-journey`（用户旅程）/ `check-public-install`（安装编排）/
  `check-conflict-repair`（更新冲突识别与修复九案）/ `check-light-theme` / `check-mobile`
  （响应式/主题验证）、`shot-readme.mjs`（README 配图实拍）；`npm run verify` 一键串跑 10 步。
- 活体 E2E 断言同步：快捷动作断言扩为五件套（+导出/导入全部数据）。
- 旧架构脚本标注废弃（`e2e-live-dev` / `e2e-live-session` / `install-to-tavern`——
  针对已移除的 plugin/ 架构，纯前端形态下必然失败；会话注入/安装编排方法论保留
  供 Authority 集成参考）。
- spec 沉淀：`.trellis/spec/guides/instance-deploy-verify.md` 新增「standalone 壳验证流程」
  与「宿主 UI 契约」两节（popup div 按钮 / checkbox 尺寸纪律 / 表格列宽 / 候选端点探测 /
  CI 文案口径 / SmartTheme 变量语义 / sticky 父元素边界）。
- 单测 147/147（+35：conflict 分类器 14 案 + repairflow 编排 17 案 + selfExtensionName 4 案）；CI 六项自查通过；
  全部改动经 standalone 壳截图/交互验证（`verify-all.mjs` 一键串跑 10 步全 PASS）；
  375px 窄视口实测无水平溢出；亮色主题映射修正后复核（修复卡/日志底色改主题自适应
  color-mix）。

## [0.9.2] - 2026-10-31

### 改进

- 纯前端诊断页来源行显示安装时间（`installedAt` 字段此前已在登记时记录、未展示；
  旧条目无该字段自动省略，无迁移）。

## [0.9.1] - 2026-10-31

### 新增（服务端治理）

- 治理页新增「清理无改动停用项」：一键批量清理**无本地改动**的停用副本（有改动的
  始终跳过，逐项走同一 `confirm:true` 端点），单次总确认列出全部受影响项与可释放
  空间，完成后 toast 汇总释放量与失败清单。

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
