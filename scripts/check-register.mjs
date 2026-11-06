// 临时诊断脚本：迭代四「登记来源」闭环验证——INPUT popup → 填地址 → 登记 → 行内更新按钮。
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
    page.on('dialog', async dialog => {
        console.log('[dialog]', dialog.type(), dialog.message().slice(0, 120));
        await dialog.dismiss();
    });
    page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.log('[console]', msg.type(), msg.text().slice(0, 200)); });
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

    // ① 点「登记来源」→ INPUT popup 出现
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('[data-zone="extensions"] button')]
            .find(b => b.textContent.includes('登记来源'));
        btn?.click();
    });
    await page.waitForSelector('.popup .popup-input', { timeout: 8000 });
    const popupText = await page.evaluate(() => document.querySelector('.popup .popup-content, .popup')?.textContent?.trim().slice(0, 80));
    console.log('弹窗文本:', popupText);

    // ② 填短写地址 → 点「登记」（ST popup 按钮是 div.menu_button[data-result]，AFFIRMATIVE=1）
    await page.fill('.popup .popup-input', 'jiozhaoyue/ST-Switcher');
    console.log('填入值:', await page.inputValue('.popup .popup-input'));
    console.log('确认按钮存在:', await page.evaluate(() => Boolean(document.querySelector('.popup .popup-button-ok'))));
    console.log('确认按钮内容:', await page.evaluate(() => document.querySelector('.popup .popup-button-ok')?.textContent?.trim()));
    await page.screenshot({ path: 'test-results/iter4-register-popup.png' });
    await page.evaluate(() => {
        document.querySelector('.popup .popup-button-ok')?.click();
    });
    await page.waitForTimeout(2000);
    console.log('弹窗已关闭:', await page.evaluate(() => !document.querySelector('.popup:not([closing])') || document.querySelectorAll('.popup').length === 0));
    console.log('popup 数量:', await page.evaluate(() => document.querySelectorAll('.popup').length));
    console.log('toast 区文本:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-3)));

    // ③ 行内应出现 ↗ 链接 + 可更新徽标 + 更新按钮；台账有 install 记录
    const rowInfo = await page.evaluate(() => {
        const row = document.querySelector('[data-zone="extensions"] .stgi-table tbody tr');
        return {
            text: row?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120),
            link: row?.querySelector('.stgi-repo-link')?.href || null,
            buttons: [...(row?.querySelectorAll('.stgi-actions-cell button') || [])].map(b => b.textContent.trim()),
        };
    });
    console.log('登记后行:', JSON.stringify(rowInfo, null, 2));
    await page.evaluate(() => document.querySelector('[data-act="govLedgerToggle"]')?.click());
    await page.waitForTimeout(600);
    const ledger = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-role="ledgerRows"] tr');
        return { count: rows.length, first: rows[0]?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) };
    });
    console.log('台账:', JSON.stringify(ledger));
    await page.evaluate(() => document.querySelector('[data-zone="extensions"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/iter4-after-register.png' });
    await context.close();
} finally {
    await browser.close();
}
