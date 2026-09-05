#!/usr/bin/env node
// Install this plugin into a SillyTavern/Luker instance.
// Usage: node scripts/install-to-tavern.mjs <path-to-tavern-root>
// Copies plugin/ sources and runs `npm install --omit=dev` inside the
// installed directory. The front-end panel self-bootstraps on first start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.resolve(process.argv[2] || '');

if (!fs.existsSync(path.join(target, 'server.js'))) {
    console.error(`不是有效的酒馆目录（缺少 server.js）: ${target}`);
    process.exit(1);
}

const pluginName = 'st-git-improve';
const dest = path.join(target, 'plugins', pluginName);

// Layout: dest/plugin/index.js (entry, via package.json "main"), dest/extension/,
// dest/package.json. The host's plugin-loader resolves package.json.main.
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'plugin'), path.join(dest, 'plugin'), { recursive: true });
fs.cpSync(path.join(repoRoot, 'extension'), path.join(dest, 'extension'), { recursive: true });
for (const file of ['package.json', 'README.md']) {
    fs.cpSync(path.join(repoRoot, file), path.join(dest, file));
}
console.log(`已复制到 ${dest}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dest,
    stdio: 'inherit',
    shell: process.platform === 'win32',
});
if (result.status !== 0) {
    console.error('npm install 失败；插件目录仍可用，但需手动安装依赖后重启酒馆。');
    process.exit(result.status ?? 1);
}
console.log('安装完成。重启酒馆后，扩展菜单会出现「Git 源管理」。');
