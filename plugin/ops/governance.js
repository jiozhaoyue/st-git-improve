import fs from 'node:fs';
import path from 'node:path';

import * as engine from '../git/engine.js';
import { atomicWriteJson, httpError, readJsonOr } from '../util.js';

/** Front-end panel of this plugin — disabling it would orphan the manager. */
export const SELF_PANEL_NAME = 'st-git-improve';

const REGISTRY_MAX_ACTIONS = 200;

/**
 * Parking area for the effective user: a sibling of the extensions directory
 * the request resolves to (per-user in host identity mode, configured default
 * otherwise). Outside the host's scan path, so parked copies never load.
 * @param {{ localExtensionsDir: string }} dirs
 */
export function parkedDirFor(dirs) {
    return path.join(path.dirname(dirs.localExtensionsDir), 'extensions-disabled');
}

/** Per-user governance ledger, inside the plugin's private data area. */
function ledgerFileFor(dirs) {
    return path.join(path.dirname(dirs.localExtensionsDir), 'git-improve', 'governance.json');
}

/**
 * Append an action to the governance ledger (capped, atomic write).
 * @param {string} registryFile
 * @param {{ action: string, name: string, version?: string, bytes?: number }} entry
 */
export function recordAction(registryFile, { action, name, version = '', bytes = 0 }) {
    const data = readJsonOr(registryFile, {});
    const actions = Array.isArray(data.actions) ? data.actions : [];
    actions.push({ ts: new Date().toISOString(), action, name, version, bytes });
    atomicWriteJson(registryFile, { actions: actions.slice(-REGISTRY_MAX_ACTIONS) });
}

/** Ledger lookup: latest disable timestamp per name. */
function parkedAtByName(registryFile) {
    const data = readJsonOr(registryFile, {});
    const out = new Map();
    for (const entry of Array.isArray(data.actions) ? data.actions : []) {
        if (entry?.action === 'disable' && entry?.name) {
            out.set(String(entry.name), String(entry.ts || ''));
        }
    }
    return out;
}

async function scanScope(scope, baseDir, { registryFile, skipNames = [] }) {
    const parkedAt = registryFile ? parkedAtByName(registryFile) : null;
    if (!fs.existsSync(baseDir)) {
        return [];
    }
    const skip = new Set(skipNames);
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(item => item.isDirectory() && !skip.has(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));

    // statusMatrix is fs-bound; a small worker pool keeps large instances snappy.
    const CONCURRENCY = 8;
    const entries = new Array(dirs.length);
    let cursor = 0;
    async function worker() {
        while (cursor < dirs.length) {
            const index = cursor;
            cursor += 1;
            const item = dirs[index];
            const dir = path.join(baseDir, item.name);
            let manifest = null;
            try {
                manifest = readJsonOr(path.join(dir, 'manifest.json'), null);
            } catch {
                manifest = null;
            }
            let dirtyCount = 0;
            try {
                dirtyCount = (await engine.dirtyTrackedFiles({ dir })).length;
            } catch {
                dirtyCount = -1; // not a git repo
            }
            const entry = {
                scope,
                name: item.name,
                version: manifest && typeof manifest === 'object' ? String(manifest.version || '') : '',
                bytes: await dirSizeBytesAsync(dir),
                isRepo: dirtyCount !== -1,
                dirtyCount,
            };
            if (scope === 'parked' && parkedAt) {
                entry.parkedAt = parkedAt.get(item.name) || '';
            }
            entries[index] = entry;
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker));
    return entries.filter(Boolean);
}

/**
 * Recursive disk usage in bytes (files only).
 * @param {string} dir
 * @returns {number}
 */
export function dirSizeBytes(dir) {
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
 * Non-blocking variant of dirSizeBytes for scan paths: async walk + stat so a
 * live server's event loop is never blocked by a 300 MB node_modules tree.
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function dirSizeBytesAsync(dir) {
    const fsp = fs.promises;
    let files;
    try {
        const dirents = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
        files = dirents.filter(entry => entry.isFile());
    } catch {
        return 0;
    }
    let total = 0;
    let cursor = 0;
    async function worker() {
        while (cursor < files.length) {
            const index = cursor;
            cursor += 1;
            const entry = files[index];
            // parentPath mirrors the dir as passed (absolute in → absolute out,
            // relative in → relative to CWD), so resolving against it alone is
            // always right; mixing in a resolved base would double-append.
            const full = path.resolve(entry.parentPath ?? entry.path ?? dir, entry.name);
            try {
                const stat = await fsp.stat(full);
                if (stat.isFile()) {
                    total += stat.size;
                }
            } catch {
                /* vanished concurrently */
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
    return total;
}

/**
 * Move a directory into/out of the parking area. rename is atomic on the
 * same volume; fall back to copy+delete for exotic deployments.
 * @param {string} from @param {string} to
 */
function moveDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch {
        fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

/**
 * Governance overview: all extension assets across scopes + disk totals.
 * Results are cached briefly (the scan hashes every repo's worktree); every
 * mutating action clears the cache so the next list is fresh.
 * @param {{ dirs: object }} options
 */
const SCAN_TTL_MS = 60_000;
const scanCache = new Map();

export function invalidateGovernanceCache() {
    scanCache.clear();
}

export async function listGovernance({ dirs }) {
    const key = [dirs.localExtensionsDir, dirs.globalExtensionsDir, dirs.pluginsDir].join('|');
    const hit = scanCache.get(key);
    if (hit && Date.now() < hit.expiresAt) {
        return hit.value;
    }
    const registryFile = ledgerFileFor(dirs);
    const parkedDir = parkedDirFor(dirs);
    const [local, global, parked, plugins] = await Promise.all([
        scanScope('local', dirs.localExtensionsDir, { registryFile }),
        scanScope('global', dirs.globalExtensionsDir, { registryFile }),
        scanScope('parked', parkedDir, { registryFile }),
        scanScope('plugin', dirs.pluginsDir, { registryFile, skipNames: [path.basename(dirs.selfPluginDir)] }),
    ]);
    const overview = {
        parkedDir,
        entries: [...local, ...global, ...parked, ...plugins],
        totals: {
            localBytes: local.reduce((sum, entry) => sum + entry.bytes, 0),
            parkedBytes: parked.reduce((sum, entry) => sum + entry.bytes, 0),
        },
    };
    scanCache.set(key, { value: overview, expiresAt: Date.now() + SCAN_TTL_MS });
    return overview;
}

/** @param {string} name */
function cleanName(name) {
    const clean = String(name || '').replace(/[\\/]+/g, '_');
    if (!clean || clean === '.' || clean === '..') {
        throw httpError(400, '无效的扩展名');
    }
    return clean;
}

/**
 * Disable a user-installed extension: move its whole directory (data
 * included) into the parking area; the host stops loading it.
 * @param {{ name: string, dirs: object }} options
 */
export function disableExtension({ name, dirs }) {
    const clean = cleanName(name);
    if (clean === SELF_PANEL_NAME) {
        throw httpError(409, '这是本插件的管理面板，停用后治理入口会消失，因此不允许停用');
    }
    const localPath = path.join(dirs.localExtensionsDir, clean);
    const parkedPath = path.join(parkedDirFor(dirs), clean);
    if (!fs.existsSync(localPath)) {
        throw httpError(404, `本地扩展不存在: ${clean}`);
    }
    if (fs.existsSync(parkedPath)) {
        throw httpError(409, '停用区已有同名副本，请先启用或彻底清理它');
    }
    const bytes = dirSizeBytes(localPath);
    let manifest = null;
    try {
        manifest = readJsonOr(path.join(localPath, 'manifest.json'), null);
    } catch {
        manifest = null;
    }
    moveDir(localPath, parkedPath);
    invalidateGovernanceCache();
    recordAction(ledgerFileFor(dirs), {
        action: 'disable',
        name: clean,
        version: manifest?.version ? String(manifest.version) : '',
        bytes,
    });
    return { name: clean, bytes, parkedDir: parkedPath };
}

/**
 * Re-enable a parked extension: move it back into the user's extensions dir.
 * @param {{ name: string, dirs: object }} options
 */
export function enableExtension({ name, dirs }) {
    const clean = cleanName(name);
    const parkedPath = path.join(parkedDirFor(dirs), clean);
    const localPath = path.join(dirs.localExtensionsDir, clean);
    if (!fs.existsSync(parkedPath)) {
        throw httpError(404, `停用区没有该副本: ${clean}`);
    }
    if (fs.existsSync(localPath)) {
        throw httpError(409, '本地已存在同名扩展，无法启用停用副本');
    }
    const bytes = dirSizeBytes(parkedPath);
    moveDir(parkedPath, localPath);
    invalidateGovernanceCache();
    recordAction(ledgerFileFor(dirs), { action: 'enable', name: clean, bytes });
    return { name: clean, bytes };
}

/**
 * Permanently delete a parked copy to reclaim disk space. Requires explicit
 * confirm; the ledger records what was freed.
 * @param {{ name: string, confirm: boolean, dirs: object }} options
 */
export function purgeParked({ name, confirm, dirs }) {
    const clean = cleanName(name);
    if (confirm !== true) {
        throw httpError(400, '缺少 confirm:true —— 彻底清理不可恢复，需要显式确认');
    }
    const parkedPath = path.join(parkedDirFor(dirs), clean);
    if (!fs.existsSync(parkedPath)) {
        throw httpError(404, `停用区没有该副本: ${clean}`);
    }
    const freedBytes = dirSizeBytes(parkedPath);
    fs.rmSync(parkedPath, { recursive: true, force: true });
    invalidateGovernanceCache();
    recordAction(ledgerFileFor(dirs), { action: 'purge', name: clean, bytes: freedBytes });
    return { name: clean, freedBytes };
}

/**
 * Disable every user-installed extension in one go. The manager panel is
 * always skipped; conflicts (parked copy already exists) are collected, not
 * fatal. Each successful move is ledger-recorded by disableExtension.
 * @param {{ dirs: object }} options
 */
export function disableAllExtensions({ dirs }) {
    const base = dirs.localExtensionsDir;
    /** @type {string[]} */
    const disabled = [];
    /** @type {Array<{ name: string, reason: string }>} */
    const skipped = [];
    if (!fs.existsSync(base)) {
        return { disabled, skipped };
    }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }
        if (entry.name === SELF_PANEL_NAME) {
            skipped.push({ name: entry.name, reason: '本插件管理面板不允许停用' });
            continue;
        }
        try {
            disabled.push(disableExtension({ name: entry.name, dirs }).name);
        } catch (error) {
            skipped.push({ name: entry.name, reason: String(error?.message || error) });
        }
    }
    return { disabled, skipped };
}

/**
 * Enable every parked copy in one go; local name conflicts are skipped.
 * @param {{ dirs: object }} options
 */
export function enableAllExtensions({ dirs }) {
    const parked = parkedDirFor(dirs);
    /** @type {string[]} */
    const enabled = [];
    /** @type {Array<{ name: string, reason: string }>} */
    const skipped = [];
    if (!fs.existsSync(parked)) {
        return { enabled, skipped };
    }
    for (const entry of fs.readdirSync(parked, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }
        try {
            enabled.push(enableExtension({ name: entry.name, dirs }).name);
        } catch (error) {
            skipped.push({ name: entry.name, reason: String(error?.message || error) });
        }
    }
    return { enabled, skipped };
}
