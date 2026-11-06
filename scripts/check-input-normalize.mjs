// 临时诊断脚本：验证名称列宽 + 安装入口 URL 归一化交互（输入预告/失焦回填）。
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

    // 1) 名称列宽度
    const tdInfo = await page.evaluate(() => {
        const td = document.querySelector('[data-zone="extensions"] .stgi-table tbody td');
        const rect = td?.getBoundingClientRect();
        return { width: rect?.width, height: rect?.height, text: td?.querySelector('.stgi-name')?.textContent };
    });
    console.log('名称列:', JSON.stringify(tdInfo));

    // 2) 输入短写 → 提示行预告（不改输入框）
    const urlInput = page.locator('[data-zone="extensions"] [data-role="url"]');
    await urlInput.click();
    await urlInput.fill('jiozhaoyue/ST-Switcher');
    await page.waitForTimeout(300);
    console.log('短写提示(输入中):', (await page.locator('[data-role="channelHint"]').textContent()).trim());
    console.log('输入框值(输入中,应未回填):', await urlInput.inputValue());

    // 3) blur → 回填完整克隆地址
    await urlInput.blur();
    await page.waitForTimeout(300);
    console.log('输入框值(失焦后,应回填):', await urlInput.inputValue());
    console.log('提示(失焦后):', (await page.locator('[data-role="channelHint"]').textContent()).trim());

    // 4) 页面 URL → 提取仓库根
    await urlInput.fill('https://github.com/jiozhaoyue/ST-Switcher/tree/main');
    await page.waitForTimeout(300);
    console.log('页面URL提示:', (await page.locator('[data-role="channelHint"]').textContent()).trim());
    await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="url"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/iter1-input-hint.png' });
    await context.close();
} finally {
    await browser.close();
}
