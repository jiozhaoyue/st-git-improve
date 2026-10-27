# vendor 说明（勿升级、勿手改）

本目录存放**本地封装副本**（L1-MR-11：装完即可用，用户不需要跑构建）：

| 文件 | 来源 | 说明 |
|---|---|---|
| `isomorphic-git.umd.min.js` | node_modules/isomorphic-git（package.json 既有依赖） | 浏览器 UMD 构建，暴露全局 `git`；自带内置 HTTP 客户端未导出，由 `src/core/gitbrowser.js` 提供 fetch 实现 |
| `isomorphic-git.LICENSE.md` | 同上 | 许可证（MIT） |
| `buffer.umd.min.js` | `node scripts/build-vendor-buffer.mjs` 生成 | 为 isomorphic-git 提供 `Buffer` 全局；从 node_modules 的 buffer + base64-js + ieee754 机械拼接（零新依赖），勿手改 |

升级方式：更新根目录 `node_modules` 后重跑 `node scripts/build-vendor-buffer.mjs`；
isomorphic-git UMD 直接重新拷贝 `node_modules/isomorphic-git/index.umd.min.js`。
