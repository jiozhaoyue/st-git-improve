// 临时诊断脚本：迭代十二完整备份导出/导入闭环验证。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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

    // ① 导出：拦截 download
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('[data-act="quickExportAll"]')?.click());
    const download = await downloadPromise;
    const tmpPath = path.join(os.tmpdir(), 'stgi-backup-test.json');
    await download.saveAs(tmpPath);
    const payload = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    console.log('导出包:', JSON.stringify({
        kind: payload.kind,
        accounts: payload.accounts?.accounts?.length,
        installs: Object.keys(payload.accounts?.installs || {}).length,
        governance: payload.governance?.length,
    }));
    console.log('toast:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-1)));

    // ② 导入：清掉壳设置再喂回备份（模拟迁移到新机器——但壳内存态 reload 即重置，
    //    这里直接在同一页面喂入，观察合并确认弹窗与完成 toast）
    await page.setInputFiles('[data-role="importAllFile"]', tmpPath);
    await page.waitForSelector('.stgi-popup-body', { timeout: 8000 });
    console.log('导入确认弹窗:', (await page.locator('.stgi-popup-body').textContent()).trim().slice(0, 120));
    await page.evaluate(() => document.querySelector('.popup .popup-button-ok')?.click());
    await page.waitForTimeout(1500);
    console.log('导入后 toast:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-1)));
    await page.evaluate(() => document.querySelector('[data-zone="accounts"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/iter12-after-import.png' });
    console.log('账号行数:', await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-zone="accounts"] .stgi-table tbody tr');
        return rows.length;
    }));
    await context.close();
} finally {
    await browser.close();
}
