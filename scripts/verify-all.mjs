// 一键 UI 验证串跑：把 standalone 壳的全部验证脚本按依赖顺序执行一遍。
// 依赖注入的脚本（check-iter2/iter7/backup）自动做 default-settings.json 注入/还原
// （备份在系统临时目录，验证后无论成败都还原）。每步独立收集结果；退出码 = 失败数。
// Run: npm run standalone（另开终端，3040）→ node scripts/verify-all.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')));
const SETTINGS = path.join(REPO_ROOT, 'standalone', 'default-settings.json');

/** 注入测试数据（账号 + 真实登记 + ghost 登记）；返回备份路径。 */
function inject() {
    const backup = path.join(os.tmpdir(), `stgi-settings-backup-${Date.now()}.json`);
    fs.copyFileSync(SETTINGS, backup);
    const data = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    data.extension_settings = data.extension_settings || {};
    data.extension_settings.st_git_improve = {
        version: 1,
        accounts: [{ id: 'acct_t1', type: 'github', username: 'tester', token: 'fake-token', method: 'pat', note: '测试号', createdAt: 1793983200 }],
        defaults: {},
        installs: {
            'st-git-improve': { url: 'https://github.com/jiozhaoyue/st-git-improve.git', branch: 'main', target: 'extension', installedAt: 1793983206, oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
            'ghost-ext': { url: 'https://github.com/a/ghost.git', branch: '', target: 'extension', installedAt: 1793983200, oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
    };
    fs.writeFileSync(SETTINGS, JSON.stringify(data, null, 4));
    return backup;
}

function restore(backup) {
    if (backup && fs.existsSync(backup)) {
        fs.copyFileSync(backup, SETTINGS);
        fs.rmSync(backup, { force: true });
        return true;
    }
    return false;
}

// 步骤定义：name = 脚本名（不带 .mjs），needsInject = 是否需要注入测试数据
const STEPS = [
    { name: 'shot-standalone', args: ['verifyall'], needsInject: false },
    { name: 'check-input-normalize', needsInject: false },
    { name: 'check-register', needsInject: false },
    { name: 'check-iter2-interactions', needsInject: true },
    { name: 'check-iter7', needsInject: true },
    { name: 'check-backup', needsInject: true },
    { name: 'check-repo-summary', needsInject: false },
    { name: 'check-mobile', needsInject: false },
];

const results = [];
let backup = null;
try {
    for (const step of STEPS) {
        if (step.needsInject && !backup) backup = inject();
        if (!step.needsInject && backup) {
            restore(backup);
            backup = null;
        }
        const script = path.join(REPO_ROOT, 'scripts', `${step.name}.mjs`);
        const run = spawnSync(process.execPath, [script, ...(step.args || [])], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 240000,
        });
        const ok = run.status === 0;
        results.push({ step: step.name, ok, tail: (run.stdout || '').trim().split('\n').slice(-2).join(' | ') || (run.stderr || '').trim().slice(-160) });
        console.log(`${ok ? '✓' : '✗'} ${step.name}`);
        if (!ok) console.log(`  ${(run.stderr || run.stdout || '').trim().slice(-300)}`);
    }
} finally {
    if (restore(backup)) console.log('已还原 default-settings.json');
}

const failed = results.filter(r => !r.ok);
console.log(`\n==== 结果：${results.length - failed.length}/${results.length} 通过 ====`);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.step}  ${r.tail.slice(0, 120)}`);
process.exit(failed.length);
