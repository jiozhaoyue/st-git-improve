// 更新冲突识别与修复——面板交互验证（2026-11-07 功能）。
// 前置：npm run standalone（另开终端，3040）。壳的 /api/extensions/update 演示端点
// 由 localStorage.__stgiDemoUpdateConflict 控制：'untracked' 未跟踪冲突 / 'local' 本地改动
// 冲突 / 其余 = 无损更新成功。覆盖六案：
// A 无损更新成功日志  B untracked 冲突 → 修复卡+挡道清单  C 重建修复全流程（强确认→执行→台账留痕）
// D 台账服务端状态含 repair  E local-changes 冲突识别。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETTINGS = path.join(REPO_ROOT, 'standalone', 'default-settings.json');

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const failures = [];
const must = (cond, label) => {
    if (cond) { console.log('✓', label); } else { failures.push(label); console.log('✗', label); }
};

// 文件级注入（壳的 settings/save 只写内存，reload 即失；登记必须进 default-settings.json
// 才能被 reload 后的面板读到——同 verify-all.mjs inject() 的机理，本脚本自带以便独立运行）。
function injectSettings() {
    const backup = path.join(os.tmpdir(), `stgi-conflict-check-${Date.now()}.json`);
    fs.copyFileSync(SETTINGS, backup);
    const data = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    data.extension_settings = data.extension_settings || {};
    data.extension_settings.st_git_improve = {
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
    fs.writeFileSync(SETTINGS, JSON.stringify(data, null, 4));
    return backup;
}

function restoreSettings(backup) {
    if (backup && fs.existsSync(backup)) {
        fs.copyFileSync(backup, SETTINGS);
        fs.rmSync(backup, { force: true });
        return true;
    }
    return false;
}

const browser = await chromium.launch({ headless: true });
let injectedBackup = null;
try {
    injectedBackup = injectSettings();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3040', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 清演示开关（前次运行可能残留）
    await page.evaluate(() => localStorage.removeItem('__stgiDemoUpdateConflict'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stgi-block', { timeout: 60000, state: 'attached' });
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForTimeout(800);

    const clickRowUpdate = () => page.evaluate(() => {
        const row = document.querySelector('[data-zone="extensions"] .stgi-table tbody tr');
        const btn = [...(row?.querySelectorAll('.stgi-actions-cell button') || [])].find(b => b.textContent.trim() === '更新');
        btn?.click();
    });
    const zoneLogText = () => page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="zoneLog"]')?.textContent || '');

    // ---- 案 A：无损更新成功（演示端点默认 isUpToDate:false → updated + hash） ----
    await clickRowUpdate();
    await page.waitForTimeout(1200);
    must(/已无损更新到/.test(await zoneLogText()), 'A1 无损更新成功日志（含 shortCommitHash）');
    await page.screenshot({ path: 'test-results/conflict-a-lossless.png' });

    // ---- 案 B：untracked 冲突 → 修复卡 + 挡道文件清单 ----
    await page.evaluate(() => localStorage.setItem('__stgiDemoUpdateConflict', 'untracked'));
    await clickRowUpdate();
    await page.waitForSelector('.stgi-repair-card', { timeout: 8000 });
    const cardState = await page.evaluate(() => {
        const card = document.querySelector('.stgi-repair-card');
        return {
            title: card?.querySelector('.stgi-repair-title')?.textContent || '',
            kind: card?.querySelector('.stgi-repair-kind')?.textContent || '',
            files: card?.querySelector('.stgi-repair-files pre')?.textContent || '',
            runLabel: card?.querySelector('.stgi-repair-run')?.textContent || '',
        };
    });
    must(cardState.title === '更新冲突修复', 'B1 修复卡标题');
    must(/未跟踪文件挡道更新/.test(cardState.kind), 'B2 未跟踪冲突形态识别');
    must(/src\/core\/conflict\.js/.test(cardState.files) && /repairflow\.js/.test(cardState.files), 'B3 挡道文件清单逐条可读');
    must(cardState.runLabel.includes('重建修复'), 'B4 重建修复入口');
    must(/挡道更新/.test(await zoneLogText()), 'B5 日志含冲突识别行');
    must(await page.evaluate(() => {
        const card = document.querySelector('.stgi-repair-card');
        return [...(card?.querySelectorAll('button') || [])].some(b => b.textContent.trim() === '复制清单');
    }), 'B6 复制清单按钮在位');
    await page.evaluate(() => document.querySelector('.stgi-repair-card')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/conflict-b-repair-card.png' });

    // ---- 案 C：重建修复全流程（官方 Popup 强确认 → 执行 → 卡片移除） ----
    await page.evaluate(() => document.querySelector('.stgi-repair-run')?.click());
    await page.waitForSelector('.stgi-popup-body', { timeout: 8000 });
    const popupText = (await page.locator('.stgi-popup-body').textContent()).trim();
    must(/重建修复 st-git-improve/.test(popupText) && /挡道文件/.test(popupText), 'C1 强确认弹窗含后果说明与文件数');
    await page.screenshot({ path: 'test-results/conflict-c-confirm.png' });
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, .menu_button')]
            .find(b => /重建修复/.test(b.textContent || '') && !b.closest('.stgi-repair-card') && b.offsetParent !== null);
        btn?.click();
    });
    await page.waitForFunction(
        () => {
            const log = document.querySelector('[data-zone="extensions"] [data-role="zoneLog"]');
            return log && /重建修复完成/.test(log.textContent || '');
        },
        null, { timeout: 15000 },
    );
    // 卡片移除发生在台账写回 + refresh（含远端状态检查）之后——用 detached 等待而非即时断言
    let cardRemoved = true;
    try {
        await page.waitForSelector('.stgi-repair-card', { state: 'detached', timeout: 30000 });
    } catch {
        cardRemoved = false;
    }
    must(cardRemoved, 'C2 修复成功后卡片移除');

    // ---- 案 D：台账服务端状态含 repair 留痕 ----
    const ledgerOk = await page.evaluate(async () => {
        const get = await (await fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const settings = typeof get.settings === 'string' ? JSON.parse(get.settings) : get.settings;
        const entries = settings?.extension_settings?.st_git_improve_governance?.entries || [];
        return entries.some(e => e.action === 'repair' && e.name === 'st-git-improve' && /挡道文件/.test(e.detail || ''));
    });
    must(ledgerOk, 'D1 台账留痕：action=repair + 挡道文件数明细');

    // ---- 案 E：local-changes 冲突识别 ----
    await page.evaluate(() => localStorage.setItem('__stgiDemoUpdateConflict', 'local'));
    await clickRowUpdate();
    await page.waitForSelector('.stgi-repair-card', { timeout: 8000 });
    const localKind = await page.evaluate(() => document.querySelector('.stgi-repair-card .stgi-repair-kind')?.textContent || '');
    must(/本地改动与上游冲突/.test(localKind), 'E1 本地改动冲突形态识别');
    await page.evaluate(() => localStorage.removeItem('__stgiDemoUpdateConflict'));

    // ---- 案 F：面板自更新执行（检查发现新版本 → 「无损更新面板」显现 → 无损更新成功留痕） ----
    await page.evaluate(() => localStorage.setItem('__stgiDemoSelfUpdate', 'newer'));
    await page.evaluate(() => document.querySelector('[data-act="quickSelfCheck"]')?.click());
    let selfButtonShown = true;
    try {
        await page.waitForFunction(
            () => {
                const btn = document.querySelector('[data-act="quickSelfUpdate"]');
                return btn && btn.style.display !== 'none';
            },
            null, { timeout: 20000 },
        );
    } catch {
        selfButtonShown = false;
    }
    must(selfButtonShown, 'F1 自检发现新版本后「无损更新面板」显现');
    await page.evaluate(() => document.querySelector('[data-act="quickSelfUpdate"]')?.click());
    let selfUpdated = true;
    try {
        await page.waitForFunction(
            () => {
                const log = document.querySelector('[data-role="quickLog"]');
                return log && /已无损更新到/.test(log.textContent || '');
            },
            null, { timeout: 15000 },
        );
    } catch {
        selfUpdated = false;
    }
    must(selfUpdated, 'F2 自更新走原生无损路径（含 shortCommitHash）');
    const selfLedgerOk = await page.evaluate(async () => {
        const get = await (await fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        const settings = typeof get.settings === 'string' ? JSON.parse(get.settings) : get.settings;
        const entries = settings?.extension_settings?.st_git_improve_governance?.entries || [];
        return entries.some(e => e.action === 'update' && e.name === 'st-git-improve' && /原生无损更新/.test(e.detail || ''));
    });
    must(selfLedgerOk, 'F3 自更新台账留痕（update + 原生无损更新明细）');
    await page.evaluate(() => localStorage.removeItem('__stgiDemoSelfUpdate'));

    await context.close();
} finally {
    await browser.close();
    if (restoreSettings(injectedBackup)) console.log('已还原 default-settings.json');
}

fs.mkdirSync('test-results', { recursive: true });
if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} 项未通过：${failures.join('；')}`);
    process.exit(1);
}
console.log('\n✓ 更新冲突识别与自更新执行：六案全部通过');
