// UI 截图验证（活体，仅 Dev 实例）：打开扩展设置抽屉里的面板区块截图，落 test-results/。
// 阶段一重构后唯一 UI 注入点 = #extensions_settings2 的 .stgi-block（inline-drawer）；
// 旧五页签 / #st-git-improve-menu 菜单项 / .stgi-dialog 自造浮层已全部废除（D6-5/D6-6）。
// SAFETY（tavern-browser-automation skill）：端口必须 ∈ {8001, 8003}；BASE 必须
// 显式传入（无默认兜底）；截图/痕迹只写本仓 test-results/，禁止写 Instance/**。
// Run: ST_GIT_IMPROVE_UI_BASE=http://127.0.0.1:8001 node test/e2e-screenshot-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const BASE = process.env.ST_GIT_IMPROVE_UI_BASE;
if (!BASE) {
    console.error('REFUSED: ST_GIT_IMPROVE_UI_BASE 未设置——拒绝静默兜底（skill L1-MF-6）');
    process.exit(2);
}
const port = new URL(BASE).port;
const DEV_PORTS = ['8001', '8003'];
if (!DEV_PORTS.includes(port)) {
    console.error(`REFUSED: UI 截图仅允许 Dev 实例（${DEV_PORTS.join('/')}），疑似误连 Real 实例（got ${port}）。`);
    process.exit(2);
}

// Playwright 用全局安装（1.62.1，skill 禁止另装）：CJS require 解析全局 node_modules。
const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'test-results');
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, `${stamp}-${name}.png`), fullPage: false });

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-ui-')),
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 宿主 SPA 启动重（多扩展时面板激活在 20s 后），等待窗放宽到 90s；再固定等 12s 让宿主完成首绘
    await page.waitForSelector('#extensionsMenu', { timeout: 90000, state: 'attached' });
    // Luker 宿主有引导竞态（交接文档八/十五节）：启动批次可能先于 settings 执行而空转。
    // 45s 仍未见 .stgi-block 时跑一次手动 prime+bootstrap（会报告是否需要 workaround）。
    let workaroundUsed = false;
    const blockAttached = await page.waitForSelector('.stgi-block', { timeout: 45000, state: 'attached' })
        .then(() => true).catch(() => false);
    if (!blockAttached) {
        workaroundUsed = true;
        await page.evaluate(async () => {
            const m = await import('/scripts/extensions.js');
            const token = (await (await fetch('/csrf-token')).json()).token;
            const g = await (await fetch('/api/settings/get', {
                method: 'POST', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}',
            })).json();
            const s = typeof g.settings === 'string' ? JSON.parse(g.settings) : g.settings;
            m.primeExtensionSettings(s, false, Boolean(g.enable_extensions_auto_update));
            await m.bootstrapExtensions();
        }).catch(error => console.log(`workaround 失败: ${error}`));
        await page.waitForSelector('.stgi-block', { timeout: 30000, state: 'attached' });
    }
    console.log(`引导竞态 workaround: ${workaroundUsed ? '需要（宿主竞态复现）' : '不需要（正常激活）'}`);
    await page.waitForTimeout(12000);
    await shot(page, '00-host');

    // 打开扩展设置抽屉（官方抽屉 #extensions-settings-button 的 toggle），再展开本扩展的
    // inline-drawer 区块；等待面板主体 .stgi-panel（总览三件套 + 三区）渲染完成。
    // JS 点击（浮层/动画不再影响）；面板挂载于 #extensions_settings2，展开后可见。
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 15000 });
    await page.waitForSelector('[data-zone="accounts"]', { timeout: 15000 });

    // 其他扩展的临时浮层（splash 弹窗 / acu 公告 dialog / acu-eol-overlay）会挡住面板——
    // 仅在本测试页处理：点掉可关闭按钮（dismiss 只落测试 profile 的 localStorage），
    // 再移除 dialog 节点（公告弹窗会被其扩展按事件重建，故每次截图前都跑一遍）。
    // 注意跳过本扩展自己的官方强确认弹窗（内容含 .stgi-popup-body）。
    const clearOverlays = () => page.evaluate(() => {
        document.querySelectorAll('.acu-eol-overlay').forEach(node => node.remove());
        document.querySelectorAll('dialog[open]').forEach(d => {
            if (d.querySelector('.stgi-popup-body')) return;
            const btn = [...d.querySelectorAll('button')].find(b => /我知道了|确定|关闭|知道了|OK|Got it/i.test(b.textContent || ''));
            if (btn) { try { btn.click(); } catch { /* 忽略 */ } }
            d.remove();
        });
    });
    const clearAndShot = async name => { await clearOverlays(); await shot(page, name); };
    const zoneShot = async (name, zoneKey) => {
        await clearOverlays();
        await page.evaluate(key => document.querySelector(`[data-zone="${key}"]`)?.scrollIntoView({ block: 'start' }), zoneKey);
        await page.waitForTimeout(400);
        await clearAndShot(name);
    };

    // 总览首屏（三件套：运行环境卡 + 分区摘要 + 快捷动作）
    await clearOverlays();
    await page.waitForSelector('[data-role="envCard"]', { timeout: 15000 });
    await page.waitForTimeout(1000); // 等环境卡异步填充
    await clearAndShot('01-overview');

    // 分区一「我的扩展」：安装入口 + 常驻列表
    await zoneShot('02-extensions', 'extensions');

    // 安装通道提示：https 地址 → ok 提示；git@ 地址 → 纯前端红字警示
    await page.fill('[data-zone="extensions"] [data-role="url"]', 'https://github.com/jiozhaoyue/ST-Switcher');
    await page.waitForTimeout(400);
    await clearAndShot('03-install-https-hint');
    await page.fill('[data-zone="extensions"] [data-role="url"]', 'git@github.com:jiozhaoyue/ST-Switcher.git');
    await page.waitForTimeout(400);
    await clearAndShot('04-install-ssh-hint');
    await page.fill('[data-zone="extensions"] [data-role="url"]', '');

    // 分区二「治理与清理」/ 分区三「账号与设置」
    await zoneShot('05-governance', 'governance');
    await zoneShot('06-accounts', 'accounts');

    console.log(`截图完成 → ${OUT_DIR} (${stamp}-*.png)`);
    if (errors.length > 0) {
        console.log(`页面错误 ${errors.length} 条：`);
        for (const e of errors.slice(0, 10)) console.log(`  - ${e.slice(0, 200)}`);
    } else {
        console.log('页面错误：0');
    }
    await context.close();
} finally {
    await browser.close();
}
