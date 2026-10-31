# Upstream Source（上游来源追踪）

- Project: SillyTavern
- Version: **1.19.0**（来源实例 git tag `1.19.0-1-g06bde939f`，`package.json` version 同为 1.19.0）
- Repository: https://github.com/SillyTavern/SillyTavern
- Snapshot source: 本机开发实例（版本 1.19.0）的 `public/` 静态快照
- License: see `UPSTREAM_LICENSE`（GNU AGPL-3.0）

## 快照范围与纪律

- 本目录下除下列**本仓自有文件**外，其余全部为上游 SillyTavern `public/` 的静态快照：
  - `standalone-hook.js`（本仓：脱机网络拦截层）
  - `serve.cjs`（本仓：零依赖开发静态服务；`.cjs` 因仓根 package.json 声明 `"type": "module"`）
  - `UPSTREAM_SOURCE.md` / `UPSTREAM_LICENSE`（本仓：许可追踪）
  - `default-settings.json`（取自上游 1.19.0 的 `default/content/settings.json`，供 hook 作为初始设置）
  - `lib.dist.js` / `lib.dist.LICENSE.txt`（上游 `public/lib.js` 源码经 webpack 构建的**产物**，
    版本同为 1.19.0、由本机开发实例服务端运行时构建。快照中的 `lib.js` 是上游未构建源码
    （裸 import 'lodash' 等，浏览器无法解析）；真实宿主由 webpack-serve 中间件运行时提供产物，
    本壳由 `serve.cjs` 把 `/lib.js` 映射到 `lib.dist.js`，快照源文件保持原样）
- **勿手改快照文件**。换版本 = 整快照替换（删除后整体重新拷贝，禁止增量手改）。
- 快照**未包含**上游实例中本地安装的用户扩展（`scripts/extensions/third-party/`）；
  本扩展 `st-git-improve` 的代码**不经拷贝**，由 `serve.js` 在运行时把
  `/scripts/extensions/third-party/st-git-improve/*` 映射到仓根 `extension/` 源码（改代码刷新即见）。
- 前端启动所需的 `standalone-hook.js` 注入由 `serve.js` 在响应 `index.html` 时动态完成，
  快照中的 `index.html` 保持上游原样。
