// 公开仓完整安装编排验证：预检 200 → 浏览器克隆尝试（GitHub git 端点无 CORS → 失败降级）
// → 宿主通道 demo 安装 → 成功日志 + zip 导出按钮 + 登记刷新。hook 全 mock 无真实数据。
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
    await page.waitForTimeout(800);

    await page.fill('[data-zone="extensions"] [data-role="url"]', 'jiozhaoyue/st-git-improve');
    await page.waitForTimeout(1000); // 摘要行出现
    console.log('摘要:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-role="repoSummary"]')?.textContent?.trim())));

    await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="go"]')?.click());
    // 预检 + 克隆尝试（git 端点 CORS 失败有超时）+ 宿主 demo 安装——等待足够长
    await page.waitForTimeout(25000);
    await page.evaluate(() => document.querySelector('[data-zone="extensions"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/journey-6-public-install.png' });
    const logLines = await page.evaluate(() => [...document.querySelectorAll('[data-role="log"] .stgi-log-line')].map(n => n.textContent || ''));
    console.log('安装日志逐行:');
    for (const line of logLines) console.log('  ', line.slice(0, 110));
    console.log('日志区按钮:', await page.evaluate(() => [...document.querySelectorAll('[data-zone="extensions"] [data-role="log"] button')].map(b => b.textContent.trim())));
    console.log('安装按钮:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="go"]')?.textContent?.trim())));
    await context.close();
} finally {
    await browser.close();
}
