// 临时诊断脚本：迭代七验证——失效登记清理行 + 台账动作过滤 + 私有仓摘要提示。
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

    // ① 私有仓摘要提示（ST-Switcher 是私有仓 → 404 → actionable 提示）
    await page.fill('[data-zone="extensions"] [data-role="url"]', 'jiozhaoyue/ST-Switcher');
    await page.waitForTimeout(4500);
    console.log('私有仓摘要提示:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-role="repoSummary"]')?.textContent?.trim())));

    // ② 失效登记清理行
    const stale = await page.evaluate(() => ({
        visible: document.querySelector('[data-role="staleRow"]')?.style.display !== 'none',
        note: document.querySelector('[data-role="staleNote"]')?.textContent,
        button: document.querySelector('[data-role="staleClean"]')?.textContent,
    }));
    console.log('失效登记行:', JSON.stringify(stale));
    await page.evaluate(() => document.querySelector('[data-role="staleRow"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/iter7-stale-row.png' });
    await page.evaluate(() => document.querySelector('[data-role="staleClean"]')?.click());
    await page.waitForTimeout(1500);
    console.log('清理后行可见:', await page.evaluate(() => document.querySelector('[data-role="staleRow"]')?.style.display !== 'none'));
    console.log('toast:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-1)));

    // ③ 台账过滤：先造一条 disable 记录
    await page.evaluate(() => document.querySelector('[data-zone="governance"] [data-role="rows"] button')?.click());
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('[data-act="govLedgerToggle"]')?.click());
    await page.waitForTimeout(600);
    console.log('台账全部:', await page.evaluate(() => document.querySelectorAll('[data-role="ledgerRows"] tr').length), '条');
    await page.selectOption('[data-role="ledgerFilter"]', 'disable');
    await page.waitForTimeout(600);
    console.log('过滤=停用:', await page.evaluate(() => document.querySelectorAll('[data-role="ledgerRows"] tr').length), '条');
    await page.selectOption('[data-role="ledgerFilter"]', 'install');
    await page.waitForTimeout(600);
    console.log('过滤=安装:', await page.evaluate(() => document.querySelectorAll('[data-role="ledgerRows"] tr').length), '条',
        JSON.stringify(await page.evaluate(() => document.querySelector('[data-role="ledgerRows"]')?.textContent?.trim().slice(0, 40))));
    await page.selectOption('[data-role="ledgerFilter"]', 'disable');
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-act="govLedgerToggle"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/iter7-ledger-filter.png' });
    await context.close();
} finally {
    await browser.close();
}
