// README 配图拍摄工具：对 standalone 壳面板区块做 element 截图（无宿主 chrome，干净画面），
// 落 docs/screenshots/。Run: node scripts/shot-readme.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3040', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.stgi-block', { timeout: 60000, state: 'attached' });
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForSelector('[data-role="envCard"]', { timeout: 15000 });
    await page.waitForTimeout(1500);

    // 总览三件套
    const block = page.locator('.stgi-block');
    await page.evaluate(() => {
        const el = document.querySelector('.stgi-panel');
        if (el) el.style.scrollBehavior = 'auto';
    });
    await page.evaluate(() => document.querySelector('.stgi-panel')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    // 块内滚动：viewport 视口内的面板可见部分即总览首屏
    await page.screenshot({ path: path.join(OUT_DIR, 'panel-overview.png') });
    console.log('已拍 panel-overview.png');
    await context.close();
} finally {
    await browser.close();
}
