// 临时诊断脚本：仓库摘要行验证（输入真实公开仓地址 → 700ms 防抖后站点 API 拉摘要）。
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    await page.waitForTimeout(500);

    await page.fill('[data-zone="extensions"] [data-role="url"]', 'jiozhaoyue/st-git-improve');
    // 等 700ms 防抖 + 站点 API 往返
    await page.waitForTimeout(4000);
    const summary = await page.evaluate(() => document.querySelector('[data-role="repoSummary"]')?.textContent?.trim());
    console.log('仓库摘要行:', JSON.stringify(summary));
    await page.evaluate(() => document.querySelector('[data-zone="extensions"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/iter6-repo-summary.png' });
    await context.close();
} finally {
    await browser.close();
}
