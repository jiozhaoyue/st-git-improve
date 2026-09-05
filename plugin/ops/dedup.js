import fs from 'node:fs';
import path from 'node:path';

import * as engine from '../git/engine.js';
import { httpError, readJsonOr } from '../util.js';

/**
 * Dedup decision for a local-scope install against an installed global
 * extension of the same repository name.
 * @param {{ candidateManifest: object | null, globalManifest: object | null, granularity: 'name' | 'name+version' }} options
 * @returns {{ blocked: boolean, reason: string, globalVersion: string, candidateVersion: string }}
 */
export function evaluateDedup({ candidateManifest, globalManifest, granularity }) {
    const candidateVersion = candidateManifest && typeof candidateManifest === 'object'
        ? String(candidateManifest.version || '')
        : '';
    const globalVersion = globalManifest && typeof globalManifest === 'object'
        ? String(globalManifest.version || '')
        : '';

    if (!globalManifest) {
        return { blocked: false, reason: '', globalVersion, candidateVersion };
    }

    if (granularity === 'name+version') {
        if (candidateVersion && candidateVersion === globalVersion) {
            return {
                blocked: true,
                reason: `全局扩展已存在相同版本 v${globalVersion}，为节省服务器空间已阻止本地重复安装（直接启用全局版即可）`,
                globalVersion,
                candidateVersion,
            };
        }
        return { blocked: false, reason: '', globalVersion, candidateVersion };
    }

    return {
        blocked: true,
        reason: `全局扩展已存在同名扩展${globalVersion ? ` v${globalVersion}` : ''}，为节省服务器空间已阻止本地重复安装（直接启用全局版即可）`,
        globalVersion,
        candidateVersion,
    };
}

/**
 * Read a directory's manifest.json (null when absent/invalid).
 * @param {string} dir
 */
export function readManifest(dir) {
    return readJsonOr(path.join(dir, 'manifest.json'), null);
}

/**
 * Recursive disk usage in bytes (files only).
 * @param {string} dir
 * @returns {number}
 */
export function dirSize(dir) {
    let total = 0;
    const walk = current => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(child);
            } else if (entry.isFile()) {
                try {
                    total += fs.statSync(child).size;
                } catch {
                    /* vanished concurrently */
                }
            }
        }
    };
    walk(dir);
    return total;
}

/**
 * Local extensions that shadow a global extension with the same name.
 * @param {{ dirs: { localExtensionsDir: string, globalExtensionsDir: string } }} context
 */
export async function listDuplicates({ dirs }) {
    const localDir = dirs.localExtensionsDir;
    const globalDir = dirs.globalExtensionsDir;
    if (!fs.existsSync(localDir) || !fs.existsSync(globalDir)) {
        return [];
    }

    const globalNames = new Set(fs.readdirSync(globalDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name));

    const out = [];
    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !globalNames.has(entry.name)) {
            continue;
        }
        const localPath = path.join(localDir, entry.name);
        const globalPath = path.join(globalDir, entry.name);
        const localManifest = readManifest(localPath);
        const globalManifest = readManifest(globalPath);
        let dirtyCount = 0;
        try {
            dirtyCount = (await engine.dirtyTrackedFiles({ dir: localPath })).length;
        } catch {
            dirtyCount = -1; // not a git repo
        }
        out.push({
            name: entry.name,
            localVersion: localManifest?.version ? String(localManifest.version) : '',
            globalVersion: globalManifest?.version ? String(globalManifest.version) : '',
            localSize: dirSize(localPath),
            globalSize: dirSize(globalPath),
            dirtyCount,
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete a local extension that duplicates a global one. Refuses when the
 * local copy has tracked local modifications unless force is set.
 * @param {{ name: string, force?: boolean, dirs: object }} options
 */
export async function removeLocalDuplicate({ name, force, dirs }) {
    const clean = String(name || '').replace(/[\\/]+/g, '_');
    if (!clean || clean === '.' || clean === '..') {
        throw httpError(400, '无效的扩展名');
    }
    const localPath = path.join(dirs.localExtensionsDir, clean);
    const globalPath = path.join(dirs.globalExtensionsDir, clean);
    if (!fs.existsSync(localPath)) {
        throw httpError(404, `本地扩展不存在: ${clean}`);
    }
    if (!fs.existsSync(globalPath)) {
        throw httpError(409, '该扩展没有全局版本，删除本地副本会使其彻底消失');
    }

    const manifest = readManifest(localPath);
    const globalManifest = readManifest(globalPath);
    const decision = evaluateDedup({ candidateManifest: manifest, globalManifest, granularity: 'name' });
    if (!decision.blocked) {
        throw httpError(409, '未检测到同名全局扩展');
    }

    let dirtyCount = 0;
    try {
        dirtyCount = (await engine.dirtyTrackedFiles({ dir: localPath })).length;
    } catch {
        dirtyCount = 0; // not a git repo — nothing tracked to lose
    }
    if (dirtyCount > 0 && !force) {
        throw httpError(409, `本地副本有 ${dirtyCount} 个改动文件，删除会丢失修改；确认放弃请勾选强制删除`);
    }

    const removedBytes = dirSize(localPath);
    fs.rmSync(localPath, { recursive: true, force: true });
    return { name: clean, removedBytes };
}

/**
 * Auto-cleanup: remove local duplicates that have NO local modifications.
 * Dirty copies are reported and skipped — never silently deleted.
 * @param {{ dirs: object }} options
 * @returns {Promise<{ removed: string[], skipped: Array<{ name: string, dirtyCount: number }> }>}
 */
export async function runAutoDedup({ dirs }) {
    const duplicates = await listDuplicates({ dirs });
    /** @type {string[]} */
    const removed = [];
    /** @type {Array<{ name: string, dirtyCount: number }>} */
    const skipped = [];
    for (const dup of duplicates) {
        if (dup.dirtyCount > 0) {
            skipped.push({ name: dup.name, dirtyCount: dup.dirtyCount });
            continue;
        }
        fs.rmSync(path.join(dirs.localExtensionsDir, dup.name), { recursive: true, force: true });
        removed.push(dup.name);
    }
    return { removed, skipped };
}
