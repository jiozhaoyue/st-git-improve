// 临时诊断脚本：375px 窄视口（移动端）下面板水平溢出检查。
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

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
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
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => {
        const drawer = document.querySelector('.drawer-content.openDrawer');
        const panel = document.querySelector('.stgi-panel');
        return {
            drawerScrollW: drawer?.scrollWidth,
            drawerClientW: drawer?.clientWidth,
            panelScrollW: panel?.scrollWidth,
            horizontalOverflow: (drawer?.scrollWidth || 0) > (drawer?.clientWidth || 0) + 2,
        };
    });
    console.log('375px 视口:', JSON.stringify(overflow));
    await page.screenshot({ path: 'test-results/iter24-mobile.png' });
    await browser.close();
} finally {
    await browser.close();
}
