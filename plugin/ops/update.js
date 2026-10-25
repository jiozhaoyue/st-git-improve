import fs from 'node:fs';
import path from 'node:path';

import * as engine from '../git/engine.js';
import { httpError, redactUrl, validateTreePaths } from '../util.js';
import { npmInstall, depsMissing } from './deps.js';
import { invalidateGovernanceCache } from './governance.js';

/**
 * Rebuild-style update (ported from TauriTavern semantics):
 *   ls-refs compare → depth-1 fetch → backup dirty tracked state →
 *   candidate preflight → advance branch ref → force checkout.
 * Local changes never block the update and are never silently lost.
 *
 * @param {{ dir: string, registry?: string, runDeps?: boolean, log?: (line: string) => void, resolveAuth?: (remote: string) => (() => object | undefined) | undefined }} options
 */
export async function updateRepo({ dir, registry, runDeps, log, resolveAuth }) {
    if (!fs.existsSync(path.join(dir, '.git'))) {
        throw httpError(409, '该目录不是 git 仓库（无 .git），请重装');
    }

    const branch = await engine.currentBranch({ dir });
    const remote = await engine.remoteUrl({ dir });
    if (!branch || !remote) {
        throw httpError(409, '无法确定分支或远端地址，请重装该扩展');
    }
    // Private sources need credentials on every network call — resolve them
    // for this repo's remote the same way install does.
    const authResolver = resolveAuth?.(remote);

    const localOid = await engine.resolveHead({ dir });
    let remoteOid = '';
    try {
        const refs = await engine.listRemoteBranches({ url: remote, authResolver });
        remoteOid = refs.find(ref => ref.ref === `refs/heads/${branch}`)?.oid || '';
    } catch (error) {
        throw httpError(502, `无法访问远端 ${redactUrl(remote)}: ${error.message}`);
    }

    if (!remoteOid || remoteOid === localOid) {
        return { upToDate: true, oid: localOid, backupRef: null, branch, remote: redactUrl(remote) };
    }

    log?.(`fetch ${branch} → ${remoteOid.slice(0, 7)}`);
    await engine.fetchBranch({ dir, url: remote, branch, authResolver });

    const candidateOid = (await engine.resolveRemoteTracking({ dir, branch })) || remoteOid;
    if (candidateOid === localOid) {
        return { upToDate: true, oid: localOid, backupRef: null, branch, remote: redactUrl(remote) };
    }

    // Candidate preflight: validate manifest + path safety before touching the
    // worktree or advancing any ref.
    const manifestBlob = await engine.readBlobAt({ dir, oid: candidateOid, filepath: 'manifest.json' });
    if (manifestBlob !== null) {
        try {
            const manifest = JSON.parse(new TextDecoder().decode(manifestBlob));
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('not an object');
            }
        } catch {
            throw httpError(400, '候选版本 manifest.json 非法，更新中止');
        }
    }
    const candidateFiles = await engine.listFiles({ dir, ref: candidateOid });
    const pathCheck = validateTreePaths(candidateFiles);
    if (!pathCheck.ok) {
        throw httpError(400, `候选版本路径校验失败: ${pathCheck.issues.slice(0, 5).join('; ')}`);
    }

    // Backup local tracked changes onto a stable ref inside .git.
    const backupRef = await engine.backupDirtyWorktree({ dir });
    if (backupRef) {
        log?.(`本地改动已备份到 ${backupRef}`);
    }

    await engine.advanceAndCheckout({ dir, branch, oid: candidateOid });
    invalidateGovernanceCache();

    let deps = null;
    if (runDeps && fs.existsSync(path.join(dir, 'package.json'))) {
        deps = await npmInstall({ dir, registry, log });
    }

    log?.(`更新完成 ${localOid.slice(0, 7)} → ${candidateOid.slice(0, 7)}`);
    return {
        upToDate: false,
        from: localOid,
        oid: candidateOid,
        backupRef,
        branch,
        remote: redactUrl(remote),
        deps,
    };
}

/**
 * @param {{ dir: string }} options
 */
export async function listBackups({ dir }) {
    return engine.listBackupRefs({ dir });
}

/**
 * @param {{ dir: string, backupRef: string }} options
 */
export async function recoverBackup({ dir, backupRef }) {
    await engine.restoreBackup({ dir, backupRef });
    const oid = await engine.resolveHead({ dir });
    let deps = null;
    if (depsMissing(dir)) {
        // caller may follow up with a deps repair; recover itself does not npm
        deps = { missing: true };
    }
    return { oid, deps };
}

/**
 * @param {{ dir: string, backupRef: string }} options
 */
export async function removeBackup({ dir, backupRef }) {
    if (!String(backupRef || '').startsWith('refs/git-improve/backup/')) {
        throw httpError(400, '仅允许删除 refs/git-improve/backup/ 前缀的备份 ref');
    }
    await engine.deleteBackupRef({ dir, backupRef });
    return { ok: true, ref: backupRef };
}

/**
 * Update every git-managed directory across scopes. One failure never stops
 * the batch — per-entry results are collected for the caller.
 * @param {{ dirs: object, selfPluginDir: string, registry?: string, log?: (line: string) => void, resolveAuth?: (remote: string) => (() => object | undefined) | undefined }} options
 */
export async function updateAllRepos({ dirs, selfPluginDir, registry, log, resolveAuth }) {
    const groups = [
        { target: 'extension', base: dirs.localExtensionsDir },
        { target: 'global', base: dirs.globalExtensionsDir },
        { target: 'plugin', base: dirs.pluginsDir },
    ];
    /** @type {Array<object>} */
    const updated = [];
    /** @type {string[]} */
    const upToDate = [];
    /** @type {Array<{ name: string, target: string, error: string }>} */
    const failed = [];
    for (const group of groups) {
        if (!fs.existsSync(group.base)) {
            continue;
        }
        for (const entry of fs.readdirSync(group.base, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const dir = path.join(group.base, entry.name);
            if (path.resolve(dir) === path.resolve(selfPluginDir)) {
                continue;
            }
            if (!fs.existsSync(path.join(dir, '.git'))) {
                continue; // not managed by git — nothing to update
            }
            try {
                const result = await updateRepo({
                    dir,
                    registry,
                    runDeps: group.target === 'plugin',
                    log,
                    resolveAuth,
                });
                if (result.upToDate) {
                    upToDate.push(entry.name);
                } else {
                    updated.push({
                        name: entry.name,
                        target: group.target,
                        from: result.from,
                        oid: result.oid,
                        backupRef: result.backupRef,
                    });
                }
            } catch (error) {
                failed.push({ name: entry.name, target: group.target, error: String(error?.message || error) });
            }
        }
    }
    return { updated, upToDate, failed };
}
