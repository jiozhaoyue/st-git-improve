# ST Git Improve

SillyTavern / Luker 的**服务端插件**：在酒馆内完成私有 git 源登录、认证安装、
重建式更新（本地改动自动备份）、npm 依赖自动安装与修复、扩展诊断。
**纯补充面板**——不修改、不接管原生扩展管理的任何行为。

## 解决什么问题

| 原生痛点 | 本插件方案 |
|---|---|
| 私有 git 站点（Gitea/GitHub/GitLab/Gitee…）无法下载扩展 | 站点凭据：PAT / 账号密码自动换 token / OAuth 设备码 / userinfo URL 提取 |
| 扩展更新遇本地改动报 409 冲突，只能重装 | TT 式重建更新：depth-1 fetch → 候选树校验 → 本地改动自动 commit 到备份 ref → 原子重建 tracked 文件 |
| 服务端插件更新后依赖缺失，要手动 npm install | 安装/更新插件后自动 `npm install --omit=dev`；面板提供对本体/任意插件目录的依赖修复（可选 lock 重建） |
| 数据包导入/手动装产生的本地扩展与管理员全局版重复，浪费空间 | 安装判重（颗粒度可配：仓库名 / 仓库名+版本号）+ 重复扫描一键清理 + 可选启动自动清理（仅删无改动的副本） |
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

## 使用

1. **站点凭据**：添加站点 → 选类型 → 保存 PAT，或账密登录（Gitea/Forgejo 自动铸造 token），
   或设备码登录（GitHub/GitLab），或直接粘贴 `https://user:token@host/...` 自动提取。
2. **私有安装**：粘贴仓库地址（可带分支）→ 安装。装完即被原生扩展系统识别。
3. **诊断与修复**：扫描全部扩展/插件，标出依赖缺失 / manifest 损坏 / 本地改动 / 远端不可达；
   一键更新（自动备份）、依赖修复、备份恢复。
4. **本体依赖修复**：诊断页勾选"显示本体依赖修复"，可对本体重跑 npm install
   （lock 重建选项用于 package-lock 损坏场景）。

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
- `ST_GIT_IMPROVE_USER` 指定用户目录（默认 `default-user`；MVP 面向单用户模式）。

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
备份/重建/恢复的本地 git 语义（含"本地 dirty 不阻塞更新"）、设备码轮询状态机。

## 已知边界（MVP）

- 单用户（`default-user`）；多用户认证集成为二期。
- SSH 桥（isomorphic-git 原生不支持 SSH）为二期；当前粘贴 SSH 地址时请改用 https+token。
- Gitee 无设备码流程；账号密码换 token 依赖应用注册，MVP 仅 PAT/userinfo。
- 本插件自身的更新走宿主原生插件更新（公开仓库），不依赖本插件。
