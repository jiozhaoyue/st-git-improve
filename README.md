# ST Git Improve

SillyTavern / Luker 的**双模式扩展**：在酒馆内完成私有 git 源多账号登录、认证安装、
重建式更新（本地改动自动备份）、npm 依赖自动安装与修复、扩展诊断。
**纯补充面板**——不修改、不接管原生扩展管理的任何行为。

**两种运行模式**（面板自动探测，标题栏显示徽标）：

- **纯前端**（默认可用，零服务端依赖）：浏览器内克隆私有仓库（isomorphic-git +
  fetch），凭据逐个登录保存在浏览器侧；安装走宿主原生通道；治理走宿主设置开关；
  更新=删除旧目录+重装；支持迁全局/迁本地。
- **服务端增强**（`enableServerPlugins: true` 且插件在位）：额外解锁重建式更新（本地改动
  自动备份）、npm 依赖修复、去重清理、整目录治理（停用区）与代理开关。

| 能力 | 纯前端 | 服务端增强 |
|---|---|---|
| 多账号逐个登录（每站点多账号、默认切换、导入导出） | ✅ | ✅（另可推送服务端） |
| 私有仓库安装（凭据自动注入） | ✅ 宿主原生通道 | ✅ 插件通道（含判重/force） |
| 更新已装扩展 | ✅ 删旧+重装（本地改动不备份） | ✅ 重建式更新（git 备份） |
| 全部更新 | ✅ 顺序执行（已登记来源） | ✅ 批量 |
| 扩展治理（停用/启用） | ✅ 宿主设置开关（目录不动） | ✅ 整目录停用区（省磁盘） |
| 迁全局/迁本地 | ✅ 宿主迁移通道 | ✅ |
| 依赖修复 / 备份恢复 / 去重清理 / 代理 | ❌ | ✅ |

## 解决什么问题

| 原生痛点 | 本插件方案 |
|---|---|
| 私有 git 站点（Gitea/GitHub/GitLab/Gitee…）无法下载扩展 | 站点凭据：PAT / 账号密码自动换 token / OAuth 设备码 / userinfo URL 提取 |
| 扩展更新遇本地改动报 409 冲突，只能重装 | TT 式重建更新：depth-1 fetch → 候选树校验 → 本地改动自动 commit 到备份 ref → 原子重建 tracked 文件 |
| 服务端插件更新后依赖缺失，要手动 npm install | 安装/更新插件后自动 `npm install --omit=dev`；面板提供对本体/任意插件目录的依赖修复（可选 lock 重建） |
| 数据包导入/手动装产生的本地扩展与管理员全局版重复，浪费空间 | 安装判重（颗粒度可配：仓库名 / 仓库名+版本号）+ 重复扫描一键清理 + 可选启动自动清理（仅删无改动的副本） |
| 不用的自装扩展仍被宿主加载，占运行资源；删了怕丢数据 | **扩展治理**：一键停用（整目录搬入停用区，数据随目录各自保存、不丢失）、随时启用、确认后彻底清理释放磁盘 |
| 依赖系统 git 的环境配置（credential helper/insteadOf） | 全部 git 操作走 isomorphic-git（纯 JS），零系统 git 依赖 |
| 本机/网络代理无法被纯 JS 引擎利用（它不读环境代理） | 显式代理开关：直连（默认）/ 跟随环境变量 / 自定义代理地址 |

## 安装

```bash
git clone https://github.com/jiozhaoyue/st-git-improve
node scripts/install-to-tavern.mjs <你的酒馆目录>
# 或手动：拷贝 plugin/ 到 <酒馆>/plugins/st-git-improve，并在其中 npm install --omit=dev
```

重启酒馆。左侧扩展菜单（Extensions）出现 **「Git 源管理」**。
前端面板由插件在首次启动时自动装入 `data/<user>/extensions/st-git-improve/`。

**前提**：酒馆需开启服务端插件——`config.yaml` 中 `enableServerPlugins: true`
（安装脚本会自动检测并提示）。脚本会原样提示，不改动你的 config.yaml。

## 使用

1. **账号**（原「站点凭据」）：每个站点**逐个登录**多个账号——选类型 →（自建填地址）→
   填 PAT（或粘贴 `https://user:token@host/...` 自动提取）→ 添加，保存后自动验证；
   ☆/★ 切换站点默认账号；支持 JSON 导出/导入。凭据保存在浏览器侧
   （宿主设置，localStorage 兜底），不写进任何仓库地址。
2. **私有安装**：粘贴仓库地址（可带分支）→ 安装。纯前端模式下浏览器内完成克隆
   （私有仓库自动带上对应站点默认账号的凭据），再交给宿主原生安装通道；
   成功后可一键导出克隆结果的本地 zip 副本。装完即被原生扩展系统识别。
3. **诊断与修复**（服务端增强）：扫描全部扩展/插件，标出依赖缺失 / manifest 损坏 /
   本地改动 / 远端不可达；一键更新（自动备份）、**全部更新**（批量，单个失败不影响其余）、
   依赖修复、备份恢复与**备份删除**（防 .git 无限膨胀）。纯前端模式下此页为只读总览。
4. **本体依赖修复**（服务端增强）：诊断页勾选"显示本体依赖修复"，可对本体重跑 npm install
   （lock 重建选项用于 package-lock 损坏场景）。
5. **扩展治理**：总览全部扩展资产（用户本地 / 全局第三方 / 服务端插件 / 已停用）与磁盘占用。
   - **纯前端**：经宿主设置 `disabledExtensions` 开关加载（目录与数据完全不动，刷新生效）。
   - **服务端增强**：**停用**=整目录搬入 `data/<user>/extensions-disabled/`，宿主不再加载；
     扩展数据随目录一起进停用区、原样保存，不受其他扩展影响。
   - **启用**：从停用区整目录搬回，内容与停用前一致；刷新页面生效。
   - **彻底清理**：删除停用区副本释放磁盘，需逐行勾选确认，不可恢复；治理台账
     （`data/<user>/git-improve/governance.json`）记录每次停用/启用/清理的时间、版本与字节数（封顶 200 条）。
   - **一键停用全部 / 全部启用**：批量搬移全部自装扩展；管理面板与停用区同名冲突自动跳过并在结果中说明。
   - 本插件自身的管理面板不允许被停用（否则治理入口自灭）。

## 设备码登录的 client_id 配置

GitHub / GitLab 的设备码流程需要一个 OAuth App 的 `client_id`（公共客户端，无需 secret）。
自建一个应用并设置环境变量：

```bash
ST_GIT_IMPROVE_GITHUB_CLIENT_ID=...   # GitHub OAuth App (device flow)
ST_GIT_IMPROVE_GITLAB_CLIENT_ID=...   # GitLab 应用 (勾选 read_repository/read_api)
```

未配置时设备码按钮会提示错误；PAT / 账号密码 / userinfo 三种方式不受影响。

## 其他配置

- **安装去重**（设置页）：颗粒度「仓库名」（默认，同名即阻）或「仓库名+版本号」（仅同版本阻）；可选「启动时自动清理」——只删除无本地改动的重复副本，有改动的跳过并记日志。全局（管理员）安装不受判重影响；强制本地安装需要管理员身份（多用户模式经宿主会话识别；单用户/降级模式用显式勾选）。
- **代理开关**（设置页或 `data/<user>/git-improve/settings.json`）：
  - `direct`（默认）：直连，不依赖任何环境配置；
  - `env`：跟随 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 与 `NO_PROXY`（回环地址始终豁免）；
  - `http(s)://host:port`：自定义代理，对**所有** git 请求生效（含本机地址）。
  - 环境变量 `ST_GIT_IMPROVE_PROXY` 优先于 settings 文件。
  - 说明：isomorphic-git 不会读取系统代理环境变量，环境里有代理也不代表它被使用——需要代理时请显式设置。
- `data/git-improve.json`：`{ "user": "default-user", "registry": "https://registry.npmmirror.com" }`
  （`registry` 用于所有 npm 依赖安装；国内环境建议镜像源）
- `ST_GIT_IMPROVE_REGISTRY` 环境变量优先于配置文件。
- `ST_GIT_IMPROVE_USER` 指定降级/单用户模式的数据目录（默认 `default-user`；宿主多用户模式自动按会话识别）。

## 安全

- 凭据只写 `data/<user>/git-improve/credentials.json`（本机、原子写），不写入任何
  URL、`.git/config` 或日志；前端展示一律脱敏。
- `.git/config` 中保存的 remote URL 永远不含凭据——认证仅在请求时经内存注入。
- 仅支持 http(s) 克隆；不支持 SSH / LFS / submodule / hook 执行。
- API 挂载在 `/api/plugins/st-git-improve`，与宿主插件体系一致（本机使用场景）。

## 开发

```bash
npm install
npm test                 # 单元测试（无网络）
npm run test:integration # 无 git 二进制环境下的 clone 集成测试（需网络）
```

测试覆盖：URL 规范化/脱敏、路径安全校验、凭据存储与匹配、
备份/重建/恢复的本地 git 语义（含"本地 dirty 不阻塞更新"）、设备码轮询状态机、
扩展治理（停用/启用搬移、数据保全、清理确认、名称清洗、台账封顶）。

## 已知边界

- 多用户：宿主开启多用户时按登录会话识别身份与数据目录（治理/安装/更新均落在调用者自己的目录，
  已有宿主身份集成与按用户目录的 E2E 覆盖）；`ST_GIT_IMPROVE_USER` 指定降级/单用户模式的数据目录。
- SSH 桥（isomorphic-git 原生不支持 SSH）为二期；当前粘贴 SSH 地址时请改用 https+token。
- Gitee 无设备码流程；账号密码换 token 依赖应用注册，MVP 仅 PAT/userinfo。
- 本插件自身的更新走宿主原生插件更新（公开仓库），不依赖本插件。
- **纯前端模式的网络约束**：GitHub/GitLab 的 git 端点不发 CORS 头，浏览器内克隆会失败——
  面板自动降级：安装主路径走宿主原生通道（服务端克隆），站点 API 预检（api.github.com 等
  支持 CORS）负责提前给出 401/404 的清晰错误。克隆仅在可达时提供 zip 导出增强。
- **纯前端模式的服务端约束**（实测 ST 1.19）：宿主安装端点不支持覆盖（409）——更新语义为
  「删除旧目录+重装」，扩展目录内的本地改动不备份；停用清单写
  `extension_settings.disabledExtensions`（重载生效）；整目录停用区/依赖修复/备份恢复需要服务端插件。
- 设备码登录（GitHub/GitLab OAuth device flow）需要服务端插件（浏览器直连 OAuth 端点被 CORS 拦截）；
  PAT / userinfo 提取在纯前端模式完全可用。
