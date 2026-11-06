// 临时诊断脚本：亮色主题对比度验证——覆盖 SmartTheme 变量为亮色组后截图面板。
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

const LIGHT = {
    '--SmartThemeBodyColor': '#f2f2f2',
    '--SmartThemeBlurTintColor': '#e8e8ea',
    '--SmartThemeBorderColor': '#c4c4c8',
    '--SmartThemeQuoteColor': '#3a62a8',
    '--SmartThemeCheckboxTickColor': '#2a2a2a',
    '--SmartThemeShadowColor': '#000000',
};

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3040', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.stgi-block', { timeout: 60000, state: 'attached' });
    await page.evaluate(vars => {
        for (const [k, v] of Object.entries(vars)) {
            document.documentElement.style.setProperty(k, v);
        }
        document.body.style.background = '#f2f2f2';
        document.body.style.color = '#1a1a1a';
    }, LIGHT);
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/iter14-light-overview.png' });
    await page.evaluate(() => document.querySelector('[data-zone="accounts"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/iter14-light-accounts.png' });
    console.log('亮色主题截图完成');
    await context.close();
} finally {
    await browser.close();
}
