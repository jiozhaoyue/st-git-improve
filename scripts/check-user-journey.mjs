// 用户旅程模拟：新用户第一次打开面板 → 添加账号 → 尝试安装 → 查看更新/卸载入口。
// 每步截图（test-results/journey-*.png），暴露流程摩擦点。hook 全 mock，无真实数据风险。
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
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
    });
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

    // 步骤 1：添加账号（GitHub + 假 token——验证流程与失败态展示）
    await page.evaluate(() => document.querySelector('[data-zone="accounts"]')?.scrollIntoView({ block: 'start' }));
    await page.selectOption('[data-zone="accounts"] [data-role="type"]', 'github');
    await page.fill('[data-zone="accounts"] [data-role="token"]', 'ghp_fake_token_for_ui_test');
    await page.fill('[data-zone="accounts"] [data-role="note"]', '旅程测试号');
    await page.screenshot({ path: 'test-results/journey-1-account-form.png' });
    await page.evaluate(() => document.querySelector('[data-zone="accounts"] [data-role="add"]')?.click());
    await page.waitForTimeout(3000); // 自动验证（401 toast）+ 表格刷新
    await page.evaluate(() => document.querySelector('[data-zone="accounts"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/journey-2-account-added.png' });
    const accountRow = await page.evaluate(() => {
        const row = document.querySelector('[data-zone="accounts"] .stgi-table tbody tr');
        return row?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100);
    });
    console.log('账号行:', JSON.stringify(accountRow));
    console.log('账号区 toasts:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-2)));

    // 步骤 2：安装入口输入私有仓地址 → 通道提示 + 摘要（401 凭据无效提示——账号 token 是假的）
    await page.fill('[data-zone="extensions"] [data-role="url"]', 'jiozhaoyue/ST-Switcher');
    await page.waitForTimeout(4500);
    await page.evaluate(() => document.querySelector('[data-zone="extensions"]')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/journey-3-install-hint.png' });
    console.log('摘要提示:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-role="repoSummary"]')?.textContent?.trim())));

    // 步骤 3：点安装 → 日志区流程（预检失败即拦截——私有仓 401 后 pureInstall 抛错）
    await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="go"]')?.click());
    await page.waitForTimeout(5000);
    await page.evaluate(() => document.querySelector('[data-zone="extensions"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/journey-4-install-attempt.png' });
    console.log('安装日志:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-role="log"]')?.textContent?.trim().slice(0, 200))));
    console.log('安装按钮文字:', JSON.stringify(await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="go"]')?.textContent?.trim())));

    // 步骤 3b：失败日志的「复制日志」按钮（排障正发生在失败场景）
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('[data-zone="extensions"] button')]
            .find(b => b.textContent.trim() === '复制日志' && b.offsetParent !== null);
        btn?.click();
    });
    await page.waitForTimeout(800);
    console.log('复制日志 toast:', await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(x => x.textContent.trim()).slice(-1)));
    console.log('日志剪贴板:', JSON.stringify((await page.evaluate(() => navigator.clipboard.readText())).slice(0, 120)));

    // 步骤 4：已装列表（st-git-improve 无登记 → 登记来源按钮可见）
    await page.evaluate(() => document.querySelector('[data-zone="extensions"] [data-role="rows"]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/journey-5-list.png' });
    console.log('已装行按钮:', await page.evaluate(() => [...document.querySelectorAll('[data-zone="extensions"] .stgi-actions-cell button')].map(b => b.textContent.trim()).slice(0, 4)));

    await context.close();
} finally {
    await browser.close();
}
