// 临时诊断脚本：迭代二交互验证——①全部更新强确认弹窗 ②台账徽标着色 ③↗ 主页链接。
// 前置：向壳内存设置注入一条假的安装登记（reload 后面板读到 installs 才有更新语义）。
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
    await page.goto('http://127.0.0.1:3040', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 注入假登记：读当前壳设置 → 合并 st_git_improve.installs → save
    await page.evaluate(async () => {
        const token = (await (await fetch('/csrf-token')).json()).token;
        const get = await (await fetch('/api/settings/get', {
            method: 'POST', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}',
        })).json();
        const settings = typeof get.settings === 'string' ? JSON.parse(get.settings) : get.settings;
        settings.extension_settings = settings.extension_settings || {};
        settings.extension_settings.st_git_improve = {
            version: 1,
            accounts: [],
            defaults: {},
            installs: {
                'st-git-improve': {
                    url: 'https://github.com/jiozhaoyue/st-git-improve.git',
                    branch: 'main',
                    target: 'extension',
                    installedAt: Math.floor(Date.now() / 1000),
                    oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
            },
        };
        await fetch('/api/settings/save', {
            method: 'POST', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
    });
    console.log('readback(注入后立即):', await page.evaluate(async () => {
        const get = await (await fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const settings = typeof get.settings === 'string' ? JSON.parse(get.settings) : get.settings;
        return JSON.stringify(settings?.extension_settings?.st_git_improve?.installs ?? null);
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    console.log('readback(reload+6s):', await page.evaluate(async () => {
        const get = await (await fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const settings = typeof get.settings === 'string' ? JSON.parse(get.settings) : get.settings;
        return JSON.stringify(settings?.extension_settings?.st_git_improve?.installs ?? null);
    }));
    console.log('ctx(reload后):', await page.evaluate(() => {
        try {
            return JSON.stringify(window.SillyTavern.getContext().extensionSettings?.st_git_improve ?? null);
        } catch (e) { return `ctx-err ${e.message}`; }
    }));
    await page.waitForSelector('.stgi-block', { timeout: 60000, state: 'attached' });
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForTimeout(800);

    // ① 已装列表：↗ 主页链接 + 可更新徽标
    const extRow = await page.evaluate(() => {
        const row = document.querySelector('[data-zone="extensions"] .stgi-table tbody tr');
        const link = row?.querySelector('.stgi-repo-link');
        return { text: row?.textContent?.trim().slice(0, 80), link: link?.href, badge: row?.querySelector('.stgi-badge')?.textContent };
    });
    console.log('已装行:', JSON.stringify(extRow));

    // ② 全部更新 → 官方强确认弹窗
    await page.evaluate(() => document.querySelector('[data-act="quickUpdateAll"]')?.click());
    await page.waitForSelector('.stgi-popup-body', { timeout: 8000 });
    console.log('全部更新弹窗:', (await page.locator('.stgi-popup-body').textContent()).trim().slice(0, 150));
    await page.evaluate(() => document.querySelector('.stgi-popup-body')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/iter2-confirm-popup.png' });
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, .menu_button')]
            .find(b => /取消|Cancel/i.test(b.textContent || '') && b.offsetParent !== null);
        btn?.click();
    });
    await page.waitForTimeout(500);

    // ③ 治理区：停用 → 台账 disable 徽标着色 → 展开台账截图
    await page.evaluate(() => document.querySelector('[data-zone="governance"] [data-role="rows"] button')?.click());
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('[data-act="govLedgerToggle"]')?.click());
    await page.waitForTimeout(800);
    const ledgerRow = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-role="ledgerRows"] tr');
        return {
            count: rows.length,
            firstText: rows[0]?.textContent?.trim().slice(0, 100),
            badgeClass: rows[0]?.querySelector('.stgi-badge')?.className,
        };
    });
    console.log('台账:', JSON.stringify(ledgerRow));
    await page.evaluate(() => document.querySelector('[data-act="govLedgerToggle"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/iter2-ledger-badge.png' });
    await context.close();
} finally {
    await browser.close();
}
