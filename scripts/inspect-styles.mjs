// 临时诊断脚本：查 standalone 壳里面板关键元素的计算样式（checkbox / 名称列）。
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
    await page.waitForTimeout(1000);

    const info = await page.evaluate(() => {
        const pick = node => {
            if (!node) return null;
            const cs = getComputedStyle(node);
            return {
                width: cs.width, height: cs.height, appearance: cs.appearance,
                display: cs.display, border: cs.border, borderRadius: cs.borderRadius,
                boxSizing: cs.boxSizing, transform: cs.transform,
                fontSize: cs.fontSize, flex: cs.flex, overflow: cs.overflow,
            };
        };
        const checkbox = document.querySelector('[data-role="replace"]');
        const table = document.querySelector('[data-zone="extensions"] .stgi-table');
        const firstTd = table?.querySelector('tbody td');
        const nameSpanWidth = firstTd?.getBoundingClientRect();
        return {
            checkbox: pick(checkbox),
            checkboxRect: checkbox?.getBoundingClientRect().toJSON(),
            mainFontSize: getComputedStyle(document.documentElement).getPropertyValue('--mainFontSize'),
            firstTd: pick(firstTd),
            firstTdRect: nameSpanWidth,
            tableRect: table?.getBoundingClientRect().toJSON(),
        };
    });
    console.log(JSON.stringify(info, null, 2));
    await context.close();
} finally {
    await browser.close();
}
