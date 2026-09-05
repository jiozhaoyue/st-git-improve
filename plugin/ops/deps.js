import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const NPM_EXECUTABLE = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const LOG_LIMIT = 400;

/**
 * Run `npm install --omit=dev` inside a directory. npm ships with Node, so
 * this does not add any environment git dependency.
 * @param {{ dir: string, rebuildLock?: boolean, registry?: string, timeoutMs?: number, log?: (line: string) => void }} options
 * @returns {Promise<{ skipped: boolean, code?: number, logTail: string[] }>}
 */
export async function npmInstall({ dir, rebuildLock = false, registry, timeoutMs = 10 * 60 * 1000, log }) {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
        return { skipped: true, logTail: [] };
    }

    if (rebuildLock) {
        fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
        fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
    }

    const args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
    if (registry) {
        args.push('--registry', registry);
    }

    /** @type {string[]} */
    const lines = [];
    const collect = (line) => {
        const text = String(line).replace(/\r?\n$/, '');
        if (!text) return;
        if (lines.push(text) > LOG_LIMIT) {
            lines.shift();
        }
        log?.(text);
    };

    await new Promise((resolve, reject) => {
        const child = spawn(NPM_EXECUTABLE, args, {
            cwd: dir,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`npm install 超时（${Math.round(timeoutMs / 60000)} 分钟）`));
        }, timeoutMs);

        child.stdout?.on('data', data => collect(String(data)));
        child.stderr?.on('data', data => collect(String(data)));
        child.on('error', error => {
            clearTimeout(timer);
            reject(new Error(`无法启动 npm: ${error.message}`));
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                const tail = lines.slice(-20).join('\n');
                reject(new Error(`npm install 退出码 ${code}\n${tail}`));
            }
        });
    });

    return { skipped: false, code: 0, logTail: lines };
}

/**
 * Whether a directory has npm dependencies that are not installed.
 * @param {string} dir
 */
export function depsMissing(dir) {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
        return false;
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return false;
    }
    const deps = { ...(manifest.dependencies || {}) };
    const names = Object.keys(deps);
    if (names.length === 0) {
        return false;
    }
    const modulesDir = path.join(dir, 'node_modules');
    if (!fs.existsSync(modulesDir)) {
        return true;
    }
    return names.some(name => {
        // scoped packages: @scope/name live in @scope/name/
        const probe = name.startsWith('@')
            ? path.join(modulesDir, ...name.split('/'))
            : path.join(modulesDir, name);
        return !fs.existsSync(probe);
    });
}
