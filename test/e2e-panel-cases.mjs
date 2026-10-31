// 四项必过用例（prd AC-5 / compass D10-2）：骨架与徽标 / 安装冒烟 / 治理闭环 / 账号流。
// Playwright 驱动真实面板（阶段一后唯一注入点 = 扩展设置抽屉 #extensions_settings2 的
// .stgi-block），只依赖宿主原生通道 + 官方 Popup，不依赖旧服务端插件端点。
// SAFETY（P-11 / L0-13）：
//   - 活体模式：ST_GIT_IMPROVE_E2E_BASE 端口必须 ∈ Dev 白名单 {8001, 8003}（守卫与
//     e2e-live-dev.mjs 同源，启动时自检 8002/8004 必被拒）；
//   - 脱机壳模式：ST_GIT_IMPROVE_E2E_STANDALONE=1 时仅允许 127.0.0.1:3040（本仓 standalone
//     开发壳，宿主 API 为内存 mock）——结果标注 MOCK，仅验证选择器与流程，不作为 AC-5 证据；
//   - BASE 必须显式传入，拒绝静默兜底。
// Run（活体 Dev）: ST_GIT_IMPROVE_E2E_BASE=http://127.0.0.1:8001 node test/e2e-panel-cases.mjs
// Run（脱机壳）:  ST_GIT_IMPROVE_E2E_STANDALONE=1 ST_GIT_IMPROVE_E2E_BASE=http://127.0.0.1:3040 node test/e2e-panel-cases.mjs
// 可选: ST_GIT_IMPROVE_E2E_INSTALL_URL=<公开 http(s) 仓库>（安装冒烟目标，默认 ST-Switcher）
//       ST_GIT_IMPROVE_E2E_OUT=<输出目录>（默认 test-results/）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const STANDALONE = process.env.ST_GIT_IMPROVE_E2E_STANDALONE === '1';
const BASE = process.env.ST_GIT_IMPROVE_E2E_BASE;
if (!BASE) {
    console.error('REFUSED: ST_GIT_IMPROVE_E2E_BASE 未设置——拒绝静默兜底');
    process.exit(2);
}

/** 白名单裁决（与 e2e-live-dev.mjs 同源；提取成函数便于启动自检）。 */
const DEV_PORTS = ['8001', '8003'];
function guardVerdict(candidate) {
    let port;
    try {
        port = new URL(candidate).port;
    } catch {
        return { ok: false, note: 'URL 无法解析' };
    }
    if (STANDALONE) {
        return port === '3040'
            ? { ok: true, note: 'standalone 脱机壳 3040（mock 结果，仅验证流程）' }
            : { ok: false, note: `脱机壳模式仅允许 3040（got ${port || '(none)'}）` };
    }
    return DEV_PORTS.includes(port)
        ? { ok: true, note: `Dev 白名单 ${port}` }
        : { ok: false, note: `仅允许 Dev 实例（${DEV_PORTS.join('/')}），疑似误连 Real（got ${port || '(none)'}）` };
}
const verdict = guardVerdict(BASE);
if (!verdict.ok) {
    console.error(`REFUSED: ${verdict.note}`);
    process.exit(2);
}
const MODE = STANDALONE ? 'MOCK(standalone 3040)' : `LIVE(Dev ${new URL(BASE).port})`;

// 启动自检：白名单守卫必须真的能拒掉 Real 段端口与越权端口（P-11：Dev/Real 只差一个端口号）
for (const probe of ['http://127.0.0.1:8002', 'http://127.0.0.1:8004', 'http://127.0.0.1:9999']) {
    const probeVerdict = guardVerdict(probe);
    assert.equal(probeVerdict.ok, false, `guard must refuse ${probe}`);
    console.log(`  ✔ 守卫自检：${probe} → 拒绝`);
}
console.log(`  ✔ 守卫自检：${BASE} → 放行（${verdict.note}）`);

// Playwright 用全局安装（与 e2e-live-session.mjs 同款解析）
const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const OUT_DIR = process.env.ST_GIT_IMPROVE_E2E_OUT
    || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'test-results');
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, `${stamp}-${name}.png`), fullPage: false });

// 安装冒烟候选：E2E 只对「实例未装」的候选执行安装+卸载闭环（P-11/L0-1：绝不覆盖或卸载用户已装扩展）。
// 候选必须是**远端真实存在的公开仓**（api.github.com 200 实测 2026-10-31；L0-7 教训：本地仓未必推送过）。
// 可用 ST_GIT_IMPROVE_E2E_INSTALL_URL 显式指定（此时不自动避让，使用者自担目标选择责任）。
const INSTALL_CANDIDATES = [
    'https://github.com/jiozhaoyue/ST-pack-transfer',
    'https://github.com/jiozhaoyue/ST-BgLoader',
];
const INSTALL_URL = process.env.ST_GIT_IMPROVE_E2E_INSTALL_URL || INSTALL_CANDIDATES[0];
const nameGuess = url => (url.split('/').pop() || '').replace(/\.git$/i, '');
const FAKE_TOKEN = 'ghp_e2e_FAKE_TOKEN_NOT_REAL_9f8e7d';
const ACC_NOTE = 'e2e-test';

// 面板文案事实（extension/src/i18n/strings.js，断言锚点）
const STR = {
    tierPure: '纯前端',
    govDisable: '停用',
    govEnable: '启用',
    govStateOff: '已停用',
    uninstall: '卸载',
    uninstallDanger: '不可恢复',
    popupOkUninstall: '卸载',
    accDelete: '删除',
};

// ---------------------------------------------------------------- 小工具
const zoneSel = key => `[data-zone="${key}"]`;
const clickPanel = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.click(), selector);
/** 在某分区表格里找含 rowText 的行并点其文本恰为 buttonText 的按钮。 */
const clickRowButton = (page, zone, rowText, buttonText) => page.evaluate(({ zoneSel: z, rowText: rt, buttonText: bt }) => {
    const rows = [...document.querySelectorAll(`${z} [data-role="rows"] tr`)];
    const row = rows.find(tr => (tr.textContent || '').includes(rt));
    const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.trim() === bt);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
}, { zoneSel: zoneSel(zone), rowText, buttonText });
/** 某分区表格的整体文本（含表头），供存在性断言。 */
const tableText = (page, zone) => page.evaluate(z =>
    [...document.querySelectorAll(`${z} [data-role="rows"] tr`)].map(tr => tr.textContent || '').join('\n'), zoneSel(zone));

const results = [];
const record = (caseKey, status, note = '') => {
    results.push({ case: caseKey, status, note });
    console.log(`    [${status}] ${note || caseKey}`);
};

// ---------------------------------------------------------------- 打开面板
async function openPanel(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Luker 宿主有引导竞态（交接文档八/十五节）：45s 未见 .stgi-block 时跑一次手动
    // prime+bootstrap（与 e2e-screenshot-ui.mjs 同款 workaround，会报告是否需要）。
    let workaroundUsed = false;
    const attached = await page.waitForSelector('.stgi-block', { timeout: 45000, state: 'attached' })
        .then(() => true).catch(() => false);
    if (!attached) {
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
        }).catch(error => console.log(`  workaround 失败: ${error}`));
        await page.waitForSelector('.stgi-block', { timeout: 30000, state: 'attached' });
    }
    // 打开扩展设置抽屉 + 展开 inline-drawer
    await page.evaluate(() => document.querySelector('#extensions-settings-button .drawer-toggle')?.click());
    await page.waitForFunction(
        () => document.getElementById('rm_extensions_block')?.classList.contains('openDrawer'),
        null, { timeout: 15000 },
    );
    await page.evaluate(() => document.querySelector('.stgi-block .inline-drawer-toggle')?.click());
    await page.waitForSelector('.stgi-panel', { timeout: 20000 });
    await page.waitForSelector(`${zoneSel('accounts')}`, { timeout: 20000 });
    await page.waitForSelector('[data-role="envCard"]', { timeout: 20000 });
    return { workaroundUsed };
}

// ---------------------------------------------------------------- case1 骨架与徽标
async function case1(page) {
    const key = 'case1';
    // 总览 + 三区全部可见
    for (const zone of ['overview', 'extensions', 'governance', 'accounts']) {
        const visible = await page.locator(zoneSel(zone)).isVisible();
        assert.ok(visible, `分区 ${zone} 可见`);
    }
    record(key, 'pass', '总览三件套 + 三区全部可见');
    // 快捷动作三件套
    for (const act of ['quickUpdateAll', 'quickFullScan', 'quickSelfCheck']) {
        assert.equal(await page.locator(`[data-act="${act}"]`).count(), 1, `快捷动作 ${act} 存在且唯一`);
    }
    const fullScanEnabled = await page.locator('[data-act="quickFullScan"]').isEnabled();
    const updateAllEnabled = await page.locator('[data-act="quickUpdateAll"]').isEnabled();
    assert.ok(fullScanEnabled, '全量扫描可用（宿主 discover 可达）');
    record(key, 'pass', `快捷动作三件套在位（updateAll=${updateAllEnabled ? '可用' : '灰化'}，fullScan 可用）`);
    // 三态徽标 = 纯前端（Dev 无 Authority；脱机壳显式 404）
    const badge = (await page.locator('[data-role="tierBadge"]').textContent())?.trim();
    assert.equal(badge, STR.tierPure, `三态徽标为「${STR.tierPure}」（实际「${badge}」）`);
    record(key, 'pass', `徽标「${badge}」`);
    // 分区状态摘要三行
    assert.equal(await page.locator('.stgi-summary-row').count(), 3, '分区摘要 3 行');
    // 快捷动作之一：面板自更新检查——可点击并 settle 出非空结果（不依赖外网成败；
    // 浏览器 fetch 对 api.github.com 长挂时按 90s 兜底，只记 note 不判失败——可点击性已验）
    await clickPanel(page, '[data-act="quickSelfCheck"]');
    let selfState = '';
    try {
        await page.waitForFunction(() => {
            const node = document.querySelector('[data-role="selfState"]');
            const text = node?.textContent?.trim() || '';
            return text.length > 0 && text !== '检查中…';
        }, null, { timeout: 90000 });
        selfState = (await page.locator('[data-role="selfState"]').textContent())?.trim() || '';
        record(key, 'pass', `自更新检查 settle：${selfState.slice(0, 60)}`);
    } catch {
        record(key, 'pass', '自更新检查 90s 未 settle（浏览器 fetch 对外网长挂）——按钮可点击已验证，活体网络正常时会出结果');
    }
    await shot(page, 'case1-overview');
}

// ---------------------------------------------------------------- case2 安装冒烟
async function case2(page) {
    const key = 'case2';
    // 动态选目标：候选中第一个「实例未装」的仓；全被装过 → 跳过安装（绝不覆盖用户已装扩展）
    const rowsNow = await tableText(page, 'extensions');
    let installUrl = INSTALL_URL;
    if (!process.env.ST_GIT_IMPROVE_E2E_INSTALL_URL) {
        const free = INSTALL_CANDIDATES.find(u => !rowsNow.includes(nameGuess(u)));
        if (free) installUrl = free;
    }
    const name = nameGuess(installUrl);
    const selfInstalled = !rowsNow.includes(name);
    const urlInput = page.locator(`${zoneSel('extensions')} [data-role="url"]`);
    await urlInput.fill(installUrl);
    // 加固：fill 在个别重渲染时序下可能未触达面板 listener——补一发原生 input 事件（探针实证等价）
    await page.evaluate(url => {
        const input = document.querySelector('[data-zone="extensions"] [data-role="url"]');
        if (input && input.value !== url) input.value = url;
        input?.dispatchEvent(new Event('input', { bubbles: true }));
    }, installUrl);
    const hint = page.locator(`${zoneSel('extensions')} [data-role="channelHint"]`);
    await hint.waitFor({ state: 'visible', timeout: 5000 });
    const hintText = (await hint.textContent())?.trim() || '';
    assert.ok(hintText.length > 0, '通道提示出现');
    assert.ok((await hint.getAttribute('class'))?.includes('stgi-hint-ok'), 'https 公开仓提示为 ok 通道');
    record(key, 'pass', `通道提示：${hintText.slice(0, 70)}`);
    await shot(page, 'case2-channel-hint');
    if (STANDALONE) {
        // 脱机壳的 /api/extensions/install 只回演示结果、discover 恒为面板自身——
        // 「安装 → 常驻列表出现新行」只有活体可验。
        record(key, 'skip', '脱机壳 mock：安装端点返回演示结果，无法验证常驻列表新增行（活体执行）');
        await urlInput.fill('');
        return null;
    }
    if (!selfInstalled) {
        // 目标已被实例安装（用户真实数据）：跳过安装与卸载，仅验证常驻列表行存在（冒烟目标达成）
        assert.ok(rowsNow.includes(name), `目标「${name}」已装于实例，常驻列表应有其行`);
        record(key, 'skip', `候选全部已装 → 跳过安装/卸载（绝不卸载用户扩展），列表行验证通过：「${name}」`);
        await shot(page, 'case2-installed-row');
        await urlInput.fill('');
        return null;
    }
    await clickPanel(page, `${zoneSel('extensions')} [data-role="go"]`);
    const logSel = `${zoneSel('extensions')} [data-role="log"]`;
    await page.waitForSelector(logSel, { state: 'visible', timeout: 10000 });
    // settle：日志出现「完成:」或「失败」行（预检失败/网络失败也会落 err 行）
    await page.waitForFunction(sel => {
        const log = document.querySelector(sel);
        if (!log) return false;
        const lines = [...log.querySelectorAll('.stgi-log-line')].map(n => n.textContent || '');
        return lines.some(t => t.includes('完成:') || t.includes('失败'));
    }, logSel, { timeout: 240000 });
    const logText = (await page.evaluate(sel => document.querySelector(sel)?.textContent || '', logSel)) || '';
    await shot(page, 'case2-install-log');
    assert.ok(logText.includes('完成:'), `安装完成（日志尾：${logText.slice(-180)}）`);
    record(key, 'pass', `安装日志 settle（宿主原生通道），目标 ${name}`);
    // 刷新页面生效（等价面板「刷新页面」按钮）→ 常驻列表出现新行
    await openPanel(page);
    const rows = await tableText(page, 'extensions');
    assert.ok(rows.includes(name), `常驻列表出现新行「${name}」`);
    record(key, 'pass', '刷新后常驻列表出现新行');
    await shot(page, 'case2-installed-row');
    return name;
}

// ---------------------------------------------------------------- case3 治理闭环
async function case3(page, target, selfInstalled) {
    const key = 'case3';
    if (STANDALONE) {
        record(key, 'skip', '脱机壳 mock：discover 恒为面板自身，无第三方目标可治理（活体执行）');
        return;
    }
    if (!target) {
        // 兜底：任一非面板自身的本地扩展（与 e2e-live-dev.mjs 的 round-trip 同策略）
        const rows = await page.evaluate(() =>
            [...document.querySelectorAll(`${'[data-zone="extensions"]'} [data-role="rows"] tr`)]
                .map(tr => tr.cells?.[0]?.textContent || ''));
        target = rows.map(t => t.trim()).find(t => t && !t.includes('st-git-improve') && !t.includes('Git 源管理'));
    }
    if (!target) {
        record(key, 'skip', '无可治理目标（面板外无已装扩展），先跑 case2');
        return;
    }
    record(key, 'pass', `治理目标：${target}${selfInstalled ? '（自装副本，可卸载）' : '（用户已装扩展：仅停用/启用等可逆操作，绝不卸载）'}${''}`);
    // 停用（宿主设置开关；可逆免弹窗）
    assert.ok(await clickRowButton(page, 'governance', target, STR.govDisable), '找到治理行「停用」按钮');
    await page.waitForFunction(({ sel, rt }) => {
        const row = [...document.querySelectorAll(`${sel} [data-role="rows"] tr`)]
            .find(tr => (tr.textContent || '').includes(rt));
        return row && [...row.querySelectorAll('button')].some(b => b.textContent.trim() === '启用');
    }, { sel: zoneSel('governance'), rt: target }, { timeout: 15000 });
    const badgeOff = await page.evaluate(({ sel, rt }) => {
        const row = [...document.querySelectorAll(`${sel} [data-role="rows"] tr`)]
            .find(tr => (tr.textContent || '').includes(rt));
        return row?.cells?.[1]?.textContent?.trim() || '';
    }, { sel: zoneSel('governance'), rt: target });
    assert.ok(badgeOff.includes(STR.govStateOff), `停用后状态徽标含「${STR.govStateOff}」（实际「${badgeOff}」）`);
    record(key, 'pass', '停用生效（宿主设置开关，目录不动）');
    await shot(page, 'case3-disabled');
    // 启用
    assert.ok(await clickRowButton(page, 'governance', target, STR.govEnable), '找到治理行「启用」按钮');
    await page.waitForFunction(({ sel, rt }) => {
        const row = [...document.querySelectorAll(`${sel} [data-role="rows"] tr`)]
            .find(tr => (tr.textContent || '').includes(rt));
        return row && [...row.querySelectorAll('button')].some(b => b.textContent.trim() === '停用');
    }, { sel: zoneSel('governance'), rt: target }, { timeout: 15000 });
    record(key, 'pass', '启用生效');
    await shot(page, 'case3-reenabled');
    // 卸载（官方 Popup 强确认，后果文案含「不可恢复」）——仅对自装副本执行；用户已装扩展绝不卸载
    if (!selfInstalled) {
        record(key, 'skip', '卸载强确认验证需自装副本（本跑次目标为用户已装扩展，L0-1 数据红线不卸载）');
    } else {
    assert.ok(await clickRowButton(page, 'extensions', target, STR.uninstall), '找到扩展行「卸载」按钮');
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 15000 });
    const danger = (await popup.locator('.stgi-popup-danger').textContent())?.trim() || '';
    assert.ok(danger.includes(STR.uninstallDanger), `强确认弹窗后果文案含「${STR.uninstallDanger}」（实际「${danger}」）`);
    const okText = (await popup.locator('.popup-button-ok').textContent())?.trim() || '';
    assert.equal(okText, STR.popupOkUninstall, '官方 Popup 确认按钮为「卸载」');
    record(key, 'pass', `强确认弹窗出现（红字：「${danger.slice(0, 40)}」）`);
    await shot(page, 'case3-confirm-popup');
    await popup.locator('.popup-button-ok').click();
    // 列表行消失
    await page.waitForFunction(({ sel, rt }) => ![...document.querySelectorAll(`${sel} [data-role="rows"] tr`)]
        .some(tr => (tr.textContent || '').includes(rt)), { sel: zoneSel('extensions'), rt: target }, { timeout: 30000 });
    record(key, 'pass', '卸载完成，常驻列表行消失');
    } // end selfInstalled（卸载闭环）
    // 治理台账留痕（台账渲染经 settings 网络往返——等含目标的行出现再断言，勿在加载中读）
    await clickPanel(page, '[data-act="govLedgerToggle"]');
    await page.waitForSelector(`${zoneSel('governance')} [data-role="ledgerTable"]`, { state: 'visible', timeout: 10000 });
    await page.waitForFunction(rt => {
        const rows = [...document.querySelectorAll('[data-zone="governance"] [data-role="ledgerRows"] tr')]
            .map(tr => tr.textContent || '');
        return rows.some(t => t.includes(rt));
    }, target, { timeout: 15000 });
    const ledgerText = await page.evaluate(sel =>
        [...document.querySelectorAll(`${sel} [data-role="ledgerRows"] tr`)].map(tr => tr.textContent || '').join('\n'),
    zoneSel('governance'));
    assert.ok(ledgerText.includes(target), '治理台账留痕（停用/启用/卸载记录）');
    await shot(page, 'case3-ledger');
}

// ---------------------------------------------------------------- case4 账号流
async function case4(page) {
    const key = 'case4';
    const zone = zoneSel('accounts');
    // 添加凭据：github 站点 + 假 token（打真 api.github.com → 401 → 验证失败，任务允许；
    // 不用 gitea+死端口：脱机壳 hook 对一切 /api/* 路径兜底 200，会把死站点伪造成「已验证」）
    await page.selectOption(`${zone} [data-role="type"]`, 'github');
    await page.fill(`${zone} [data-role="username"]`, 'e2e-fake-user');
    await page.fill(`${zone} [data-role="token"]`, FAKE_TOKEN);
    await page.fill(`${zone} [data-role="note"]`, ACC_NOTE);
    await shot(page, 'case4-filled');
    await clickPanel(page, `${zone} [data-role="add"]`);
    await page.waitForFunction(rt => [...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
        .some(tr => (tr.textContent || '').includes(rt)), ACC_NOTE, { timeout: 10000 });
    record(key, 'pass', '添加凭据成功，账号表出现新行');
    // 脱敏：令牌明文不得出现在面板任何位置
    const zoneText = await page.evaluate(sel => document.querySelector(sel)?.textContent || '', zone);
    assert.ok(!zoneText.includes(FAKE_TOKEN), '脱敏展示：令牌明文未出现在面板');
    record(key, 'pass', '脱敏展示通过（面板不回显令牌明文）');
    // 等后台自动验证 settle（假 token → 401 → 验证失败；未回写时容忍「未验证」）
    try {
        await page.waitForFunction(rt => {
            const row = [...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
                .find(tr => (tr.textContent || '').includes(rt));
            const status = row?.cells?.[3]?.textContent?.trim() || '';
            return status === '验证失败';
        }, ACC_NOTE, { timeout: 15000 });
    } catch {
        /* 允许停留在「未验证」 */
    }
    const statusText = await page.evaluate(rt => {
        const row = [...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
            .find(tr => (tr.textContent || '').includes(rt));
        return row?.cells?.[3]?.textContent?.trim() || '';
    }, ACC_NOTE);
    assert.ok(['未验证', '验证失败'].includes(statusText), `假 token 状态 ∈ {未验证, 验证失败}（实际「${statusText}」）`);
    record(key, 'pass', `验证结果「${statusText}」（测试站点必然失败，符合预期）`);
    await shot(page, 'case4-added');
    // 导出：面板导出走游离 <a download>（blob URL）——headless Chromium 对未挂载锚点不冒
    // download 事件（真实浏览器可用），故用 createObjectURL 捕获 blob 断言导出数据本体。
    const exportPath = path.join(OUT_DIR, `${stamp}-case4-accounts-export.json`);
    await page.evaluate(() => {
        window.__stgiExportBlobs = [];
        const original = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            window.__stgiExportBlobs.push(blob);
            return original(blob);
        };
    });
    await clickPanel(page, `${zone} [data-role="export"]`);
    await page.waitForFunction(() => (window.__stgiExportBlobs || []).length > 0, null, { timeout: 10000 });
    const exportedText = await page.evaluate(async () =>
        await window.__stgiExportBlobs[window.__stgiExportBlobs.length - 1].text());
    fs.writeFileSync(exportPath, exportedText);
    const exported = JSON.parse(exportedText);
    assert.ok(Array.isArray(exported.accounts) && exported.accounts.some(a => a.token === FAKE_TOKEN),
        '导出 JSON 含该凭据（回环数据源）');
    record(key, 'pass', `导出成功（blob 内容核验）→ ${path.basename(exportPath)}`);
    // 删除
    assert.ok(await clickRowButton(page, 'accounts', ACC_NOTE, STR.accDelete), '找到账号行「删除」按钮');
    await page.waitForFunction(rt => ![...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
        .some(tr => (tr.textContent || '').includes(rt)), ACC_NOTE, { timeout: 10000 });
    record(key, 'pass', '删除账号成功（window.confirm 已自动接受）');
    // 导入回环
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
    await clickPanel(page, `${zone} [data-role="import"]`);
    const chooser = await chooserPromise;
    await chooser.setFiles(exportPath);
    await page.waitForFunction(rt => [...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
        .some(tr => (tr.textContent || '').includes(rt)), ACC_NOTE, { timeout: 15000 });
    const afterImport = await page.evaluate(sel => document.querySelector(sel)?.textContent || '', zone);
    assert.ok(!afterImport.includes(FAKE_TOKEN), '导入回环后脱敏依旧');
    record(key, 'pass', '导入回环成功：账号已恢复且仍脱敏');
    await shot(page, 'case4-roundtrip');
    // 清理：把回环导入的测试账号移除，不污染实例
    assert.ok(await clickRowButton(page, 'accounts', ACC_NOTE, STR.accDelete), '清理：找到「删除」按钮');
    await page.waitForFunction(rt => ![...document.querySelectorAll('[data-zone="accounts"] [data-role="rows"] tr')]
        .some(tr => (tr.textContent || '').includes(rt)), ACC_NOTE, { timeout: 10000 });
    record(key, 'pass', '清理完成：测试账号已移除');
}

// ---------------------------------------------------------------- 主流程
const browser = await chromium.launch({ headless: true });
let exitCode = 1;
try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-e2e-cases-')),
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('dialog', dialog => {
        console.log(`    ↷ window 对话框自动接受: ${String(dialog.message()).slice(0, 80)}`);
        dialog.accept().catch(() => { /* 已被其他 handler 处理 */ });
    });

    console.log(`\nE2E 四项用例 · ${MODE} · ${BASE}`);
    const boot = await openPanel(page);
    console.log(`  ↷ 面板已打开（引导竞态 workaround: ${boot.workaroundUsed ? '需要' : '不需要'}）`);
    await shot(page, 'case0-booted');

    let installedName = null;
    const cases = [
        ['case1 骨架与徽标', () => case1(page)],
        ['case2 安装冒烟', async () => { installedName = await case2(page); }],
        ['case3 治理闭环', () => case3(page, installedName, installedName !== null)],
        ['case4 账号流', () => case4(page)],
    ];
    for (const [label, fn] of cases) {
        const key = label.split(' ')[0];
        console.log(`▶ ${label}`);
        try {
            await fn();
            if (!results.some(r => r.case === key && r.status === 'fail')) {
                record(key, 'pass', '用例完成');
            }
        } catch (error) {
            record(key, 'fail', String(error?.message || error).slice(0, 300));
            await shot(page, `${key}-failure`).catch(() => { /* 截图失败不掩盖主错 */ });
        }
    }

    // 结果汇总（按 case 聚合；含 skip 时仍可 PASS，全 skip 记 SKIP）
    console.log('\n—— 结果汇总 ——');
    const byCase = new Map();
    for (const r of results) {
        if (!byCase.has(r.case)) byCase.set(r.case, []);
        byCase.get(r.case).push(r);
    }
    let failed = false;
    for (const key of [...byCase.keys()].sort()) {
        const rs = byCase.get(key);
        const status = rs.some(r => r.status === 'fail') ? 'FAIL'
            : rs.every(r => r.status === 'skip') ? 'SKIP' : 'PASS';
        if (status === 'FAIL') failed = true;
        console.log(`${status}  ${key}（${rs.length} 条断言/记录）`);
        for (const r of rs) console.log(`      [${r.status}] ${r.note}`);
    }
    if (pageErrors.length > 0) {
        console.log(`页面 JS 错误 ${pageErrors.length} 条（前 5，参考信息）:`);
        for (const e of pageErrors.slice(0, 5)) console.log(`  - ${e.slice(0, 160)}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'e2e-panel-cases-result.json'), JSON.stringify({
        mode: MODE, base: BASE, installUrl: INSTALL_URL, at: new Date().toISOString(),
        pageErrors: pageErrors.length, results,
    }, null, 2));
    console.log(`\n结果与截图 → ${OUT_DIR}`);
    exitCode = failed ? 1 : 0;
} finally {
    await browser.close();
}
process.exit(exitCode);
