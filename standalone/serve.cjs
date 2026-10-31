#!/usr/bin/env node
/**
 * standalone/serve.cjs — standalone 开发预览壳的零依赖静态服务（决策 D7-1..D7-4）
 *
 * 职责：
 * 1. 静态服务 standalone/ 目录（上游 public/ 静态快照，勿手改）；
 * 2. 扩展代码直引（D7-4）：把 `/scripts/extensions/third-party/st-git-improve/*`
 *    映射到仓根 `extension/` 源码 —— 改代码刷新即见，无拷贝、无 junction、无同步步骤；
 * 3. hook 注入：响应 index.html 时在首个 <script> 前插入 standalone-hook.js，
 *    快照文件保持上游原样（UPSTREAM_SOURCE.md「勿手改」纪律）。
 *
 * 端口：显式 3040（决策 D7-3 / L0-16 段位纪律；被占用时直接失败，不静默换端口）。
 * 依赖：零依赖（仅 Node 内置模块，Node >= 18；package.json engines 已声明）。
 * 启动：npm run standalone（= node standalone/serve.cjs）。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3040; // D7-3 / L0-16：显式端口，禁止 8000/3000/8001-8004 等保留段
const HOST = '127.0.0.1'; // 开发预览壳仅绑本机回环，不暴露局域网
const STANDALONE_ROOT = __dirname;
const REPO_ROOT = path.dirname(__dirname);
const EXTENSION_SOURCE_ROOT = path.join(REPO_ROOT, 'extension');

// /scripts/extensions/third-party/<这里>/ 映射到仓根 extension/
const EXTENSION_URL_PREFIX = '/scripts/extensions/third-party/st-git-improve/';
const HOOK_TAG = '<script src="standalone-hook.js"></script>\n    ';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers));
  res.end(body);
}

function sendFile(res, filePath, status = 200) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    send(res, 404, 'Not Found (snapshot file missing)', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  send(res, status, data, { 'Content-Type': type });
}

/** 在 index.html 文本中把 hook 注入为首个脚本（chatfilesys 同位：lib/polyfill.js 之前）。 */
function injectHook(html) {
  if (html.includes('standalone-hook.js')) return html; // 防重复注入
  const firstScript = html.indexOf('<script');
  if (firstScript === -1) return html;
  return html.slice(0, firstScript) + HOOK_TAG + html.slice(firstScript);
}

/** 请求路径 → 磁盘文件。返回 { file } 或 { rewrite } 或 null（404）。 */
function resolveRequest(pathname) {
  // 1) 扩展直引映射（D7-4）：third-party/st-git-improve/* → 仓根 extension/*
  if (pathname.startsWith(EXTENSION_URL_PREFIX)) {
    const rel = pathname.slice(EXTENSION_URL_PREFIX.length);
    return { file: safeJoin(EXTENSION_SOURCE_ROOT, rel), root: EXTENSION_SOURCE_ROOT };
  }
  // 2) /lib.js 必须给 webpack 构建产物（lib.dist.js）：快照中的 lib.js 是上游未构建源码
  //    （裸 import 'lodash' 等浏览器无法解析），真实宿主由 webpack-serve 中间件在运行时
  //    提供产物；本壳以同版本实例的等价产物替代，快照源文件保持原样（勿手改）。
  if (pathname === '/lib.js') {
    return { file: path.join(STANDALONE_ROOT, 'lib.dist.js'), root: STANDALONE_ROOT };
  }
  // 3) 其余走快照根
  if (pathname === '/' || pathname === '/index.html') {
    return { file: path.join(STANDALONE_ROOT, 'index.html'), root: STANDALONE_ROOT, injectHook: true };
  }
  return { file: safeJoin(STANDALONE_ROOT, pathname.replace(/^\/+/, '')), root: STANDALONE_ROOT };
}

/** 拼接并防目录穿越；非法或越界返回 null。 */
function safeJoin(root, relative) {
  try {
    const decoded = decodeURIComponent(relative);
    if (decoded.includes('\0')) return null;
    const resolved = path.resolve(root, decoded);
    const normalizedRoot = path.resolve(root) + path.sep;
    if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) return null;
    return resolved;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const pathname = url.pathname;

  // 访问日志（调试设施）：静态快照请求太吵，只记 API 与扩展直引两类关键请求
  if (pathname.startsWith('/api/') || pathname.startsWith('/scripts/extensions/third-party/') || pathname === '/csrf-token' || pathname === '/version') {
    console.log(`[standalone] ${req.method} ${pathname}${url.search || ''}`);
  }

  const target = resolveRequest(pathname);
  if (!target || !target.file) {
    send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(target.file);
  } catch {
    send(res, 404, `Not Found: ${pathname}`, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (stat.isDirectory()) {
    send(res, 404, 'Not Found (directory)', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (target.injectHook) {
    try {
      const html = fs.readFileSync(target.file, 'utf8');
      send(res, 200, injectHook(html), {
        'Content-Type': 'text/html; charset=utf-8',
      });
    } catch (e) {
      send(res, 500, `index.html read failed: ${e.message}`, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    return;
  }

  sendFile(res, target.file);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[standalone] 端口 ${PORT} 已被占用（L0-16 显式端口纪律：不静默换端口）。`);
    console.error('[standalone] 请先结束占用该端口的进程，再重新运行 npm run standalone。');
    process.exit(1);
  }
  console.error('[standalone] 服务器错误:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.info('[standalone] ST-git-improve 开发预览壳已启动（纯前端脱机模式）');
  console.info(`[standalone] 地址:   http://${HOST}:${PORT}/`);
  console.info(`[standalone] 快照:   ${STANDALONE_ROOT}`);
  console.info(`[standalone] 扩展直引: ${EXTENSION_URL_PREFIX}*  →  ${EXTENSION_SOURCE_ROOT}`);
  console.info('[standalone] 写操作端点仅返回演示结果（standalonePreview: true），不执行任何真实变更。');
});
