// standalone 壳（3040）UI 截图工具（开发工具，非测试）：把扩展面板拍进 test-results/。
// 与 test/e2e-screenshot-ui.mjs（活体 Dev 实例专用、Dev 白名单门禁）不同，本脚本只打
// 本仓自己的静态壳 http://127.0.0.1:3040（无真实数据，hook 全 mock），供 UI 迭代快速验证。
// --multi：临时注入多扩展演示数据到 hook 的 discover 路由（同名 local/global 对），
//          拍完自动还原 hook（该文件被 git 跟踪——还原失败脚本会以非零码退出）。
// Run: node scripts/shot-standalone.mjs [名字前缀] [--multi]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3040';
const argv = process.argv.slice(2);
const MULTI = argv.includes('--multi');
const PREFIX = argv.find(a => !a.startsWith('--')) || 'ui';

// Playwright 用全局安装（与 test/e2e-*.mjs 同款解析，不另装依赖）
const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'test-results');
const REPO_ROOT = path.dirname(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT_DIR, `${PREFIX}-${stamp}-${name}.png`), ...opts });

const browser = await chromium.launch({ headless: true });
let hookBackup = null;
const HOOK_PATH = path.join(REPO_ROOT, 'standalone', 'standalone-hook.js');
try {
    if (MULTI) {
        // 多扩展演示注入（验证完在 finally 还原）
        hookBackup = path.join(os.tmpdir(), `stgi-hook-backup-${Date.now()}.js`);
        fs.copyFileSync(HOOK_PATH, hookBackup);
        const original = fs.readFileSync(HOOK_PATH, 'utf8');
        const anchor = 'router.set("GET /api/extensions/discover", () => json([{ name: EXTENSION_NAME, type: "local" }]));';
        if (!original.includes(anchor)) throw new Error('hook discover 路由锚点未找到（上游变更？）');
        const demo = `router.set("GET /api/extensions/discover", () => json([
            { name: EXTENSION_NAME, type: "local" },
            { name: "third-party/ST-Switcher", type: "local" },
            { name: "third-party/Demo-Ext", type: "local" },
            { name: "third-party/Demo-Ext", type: "global" },
            { name: "third-party/Old-Plugin", type: "global" },
        ]));`;
        fs.writeFileSync(HOOK_PATH, original.replace(anchor, demo));
        console.log('已注入多扩展演示数据（--multi）');
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.stgi-block', { timeout: 60000, state: 'attached' });

    // 打开扩展设置抽屉 + 展开本扩展面板
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForSelector('[data-zone="accounts"]', { timeout: 15000 });

    // 总览首屏（等环境卡异步填充）
    await page.waitForSelector('[data-role="envCard"]', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot(page, 'overview');

    const zoneShot = async (name, zoneKey) => {
        await page.evaluate(key => document.querySelector(`[data-zone="${key}"]`)?.scrollIntoView({ block: 'start' }), zoneKey);
        await page.waitForTimeout(400);
        await shot(page, name);
    };
    await zoneShot('extensions', 'extensions');
    await zoneShot('governance', 'governance');
    await zoneShot('accounts', 'accounts');

    // 整页长图（完整面板）
    await page.evaluate(() => document.querySelector('.stgi-panel')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await shot(page, 'fullpage', { fullPage: true });

    console.log(`截图完成 → ${OUT_DIR} (${PREFIX}-${stamp}-*.png)`);
    if (errors.length > 0) {
        console.log(`页面错误 ${errors.length} 条：`);
        for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 200)}`);
    } else {
        console.log('页面错误：0');
    }
    await context.close();
} finally {
    await browser.close();
    if (hookBackup) {
        // 还原 hook 并断言还原成功（git 跟踪文件——静默丢失注入前状态不可接受）
        fs.copyFileSync(hookBackup, HOOK_PATH);
        fs.rmSync(hookBackup, { force: true });
        const restored = fs.readFileSync(HOOK_PATH, 'utf8');
        if (!restored.includes('router.set("GET /api/extensions/discover", () => json([{ name: EXTENSION_NAME, type: "local" }]));')) {
            console.error('FATAL: hook 还原后未找到原始 discover 路由——请立即 git checkout standalone/standalone-hook.js');
            process.exit(3);
        }
        console.log('已还原 standalone-hook.js');
    }
}
