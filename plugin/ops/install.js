import fs from 'node:fs';
import path from 'node:path';

import * as engine from '../git/engine.js';
import { normalizeRepoUrl, dirNameFromUrl, httpError, redactUrl } from '../util.js';
import { npmInstall } from './deps.js';
import { evaluateDedup, readManifest } from './dedup.js';

/**
 * @typedef {'extension' | 'global' | 'plugin'} InstallTarget
 */

/**
 * Resolve the base directory for a target kind.
 * @param {InstallTarget} target
 * @param {{ globalExtensionsDir: string, localExtensionsDir: string, pluginsDir: string }} dirs
 */
export function baseDirFor(target, dirs) {
    switch (target) {
        case 'extension':
            return dirs.localExtensionsDir;
        case 'global':
            return dirs.globalExtensionsDir;
        case 'plugin':
            return dirs.pluginsDir;
        default:
            throw httpError(400, `未知安装目标: ${target}`);
    }
}

/**
 * Candidate preflight for an installed tree. Extensions require a valid
 * manifest.json; server plugins require package.json or an index entry file.
 * @param {InstallTarget} target
 * @param {string} dir
 */
export function preflightInstall(target, dir) {
    if (target === 'plugin') {
        const hasEntry = ['package.json', 'index.js', 'index.cjs', 'index.mjs']
            .some(file => fs.existsSync(path.join(dir, file)));
        if (!hasEntry) {
            throw httpError(400, '插件仓库缺少 package.json 或 index.js 入口');
        }
        return;
    }
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw httpError(400, '扩展仓库缺少 manifest.json');
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            throw new Error('not an object');
        }
    } catch {
        throw httpError(400, 'manifest.json 不是合法的 JSON object');
    }
}

/**
 * Remove leftover temporary install directories from crashed runs.
 * @param {string} baseDir
 */
export function cleanStaleTempDirs(baseDir) {
    if (!fs.existsSync(baseDir)) {
        return;
    }
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.tmp-stgi-')) {
            fs.rmSync(path.join(baseDir, entry.name), { recursive: true, force: true });
        }
    }
}

/**
 * Install (authenticated clone) a repository into the target directory.
 *
 * Flow: clone into a sibling temp dir → preflight → dedup decision (local
 * installs only, unless forced) → rename into place. On failure the temp dir
 * is removed (fail-fast); nothing half-installed ever becomes discoverable.
 *
 * @param {{ url: string, branch?: string, target: InstallTarget, dirs: object, authResolver?: () => object | undefined, registry?: string, log?: (line: string) => void, replace?: boolean, force?: boolean, dedupGranularity?: 'name' | 'name+version' }} options
 */
export async function installFromUrl({ url, branch, target, dirs, authResolver, registry, log, replace, force, dedupGranularity }) {
    const raw = String(url || '').trim();
    if (!raw) {
        throw httpError(400, '缺少仓库 URL');
    }
    let normalized;
    try {
        normalized = normalizeRepoUrl(raw);
    } catch {
        throw httpError(400, '无法解析仓库 URL（仅支持 http/https）');
    }
    if (!/^https?:/i.test(normalized)) {
        throw httpError(400, '仅支持 http/https 仓库地址');
    }

    const name = dirNameFromUrl(normalized);
    if (!name) {
        throw httpError(400, '无法从 URL 推断目录名');
    }
    const basePath = baseDirFor(target, dirs);
    const targetPath = path.join(basePath, name);
    const tempPath = path.join(basePath, `.tmp-stgi-${name}-${Date.now()}`);

    if (targetPath === dirs.selfPluginDir) {
        throw httpError(400, '不能覆盖本插件自身目录');
    }
    if (fs.existsSync(targetPath) && !replace) {
        throw httpError(409, `目录已存在: ${name}（可勾选替换重装）`);
    }

    try {
        log?.(`clone ${redactUrl(normalized)}${branch ? ` @ ${branch}` : ''}`);
        await engine.clone({ url: normalized, dir: tempPath, branch, authResolver });
        preflightInstall(target, tempPath);

        if (target === 'extension' && !force) {
            const decision = evaluateDedup({
                candidateManifest: readManifest(tempPath),
                globalManifest: readManifest(path.join(dirs.globalExtensionsDir, name)),
                granularity: dedupGranularity === 'name+version' ? 'name+version' : 'name',
            });
            if (decision.blocked) {
                throw httpError(409, decision.reason);
            }
            if (decision.globalVersion) {
                log?.(`dedup check passed: global v${decision.globalVersion} vs candidate v${decision.candidateVersion}`);
            }
        }

        // Only now replace: a blocked or failed install leaves the previous
        // local copy untouched.
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        fs.mkdirSync(basePath, { recursive: true });
        fs.renameSync(tempPath, targetPath);

        let deps = null;
        if (target === 'plugin') {
            deps = await npmInstall({ dir: targetPath, registry, log });
        }

        const headOid = await engine.resolveHead({ dir: targetPath });
        log?.(`安装完成 ${name} @ ${headOid.slice(0, 7)}`);
        return { name, target, path: targetPath, oid: headOid, deps };
    } catch (error) {
        fs.rmSync(tempPath, { recursive: true, force: true });
        throw error;
    }
}
