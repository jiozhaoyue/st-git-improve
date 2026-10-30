// 活体 E2E 一键包装：Playwright 取会话 cookie → 注入 e2e-live-dev.mjs 跑套件。
// 用途：Luker 等宿主的会话只能由真实页面加载建立（交接文档廿七节）。
// Run: ST_GIT_IMPROVE_E2E_BASE=https://127.0.0.1:8003 node test/e2e-live-session.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ST_GIT_IMPROVE_E2E_BASE;
if (!BASE) {
    console.error('REFUSED: ST_GIT_IMPROVE_E2E_BASE 未设置——拒绝静默兜底');
    process.exit(2);
}
const port = new URL(BASE).port;
if (!['8001', '8003'].includes(port)) {
    console.error(`REFUSED: 仅允许 Dev 实例（8001/8003），疑似误连 Real（got ${port}）`);
    process.exit(2);
}

// 1) Playwright 取会话（独立临时 profile，不共享任何登录态）
const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const browser = await chromium.launch({ headless: true });
let cookieHeader = '';
try {
    const context = await browser.newContext({
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-e2e-ck-')),
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000); // 等宿主建立会话
    const cookies = await context.cookies(BASE);
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    await context.close();
} finally {
    await browser.close();
}
if (!cookieHeader) {
    console.error('LIVE E2E FAIL: 未能取得会话 cookie（页面加载失败？）');
    process.exit(1);
}
console.log(`  ↷ 会话已取得（${cookieHeader.split(';').length} 个 cookie）`);

// 2) 注入并运行套件（继承当前进程的全部环境变量；自签跳过在套件内/此处统一设置）
const suite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-live-dev.mjs');
const result = spawnSync(process.execPath, [suite], {
    stdio: 'inherit',
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', ST_GIT_IMPROVE_E2E_COOKIE: cookieHeader },
});
process.exit(result.status ?? 1);
