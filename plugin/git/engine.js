import fs from 'node:fs';
import path from 'node:path';

import * as git from 'isomorphic-git';

import { createHttpClient } from './proxy-http.js';

const DEFAULT_AUTHOR = { name: 'st-git-improve', email: 'noreply@st-git-improve.local' };
const http = createHttpClient();

/**
 * @typedef {() => ({ username?: string, password?: string } | undefined) | Promise<({ username?: string, password?: string } | undefined)>} AuthResolver
 */

/** @param {AuthResolver} [authResolver] */
function onAuthFactory(authResolver) {
    if (!authResolver) {
        return undefined;
    }
    return async () => {
        const auth = await authResolver();
        return auth || undefined;
    };
}

/**
 * Clone a repository (shallow, single branch by default).
 * @param {{ url: string, dir: string, branch?: string, depth?: number, authResolver?: AuthResolver, onProgress?: (event: object) => void }} options
 */
export async function clone({ url, dir, branch, depth = 1, authResolver, onProgress }) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git.clone({
        fs,
        http,
        dir,
        url,
        depth,
        singleBranch: true,
        noCheckout: false,
        ref: branch || undefined,
        onAuth: onAuthFactory(authResolver),
        onProgress,
    });
}

/**
 * List remote branch heads without downloading objects (ref advertisement).
 * @param {{ url: string, authResolver?: AuthResolver }} options
 * @returns {Promise<Array<{ ref: string, oid: string }>>}
 */
export async function listRemoteBranches({ url, authResolver }) {
    const refs = await git.listServerRefs({
        fs,
        http,
        url,
        prefix: 'refs/heads/',
        onAuth: onAuthFactory(authResolver),
    });
    return refs.map(ref => ({ ref: ref.ref, oid: ref.oid }));
}

/**
 * Shallow-fetch a branch's newest commit into the local repo.
 * @param {{ dir: string, url: string, branch: string, authResolver?: AuthResolver }} options
 */
export async function fetchBranch({ dir, url, branch, authResolver }) {
    await git.fetch({
        fs,
        http,
        dir,
        url,
        ref: branch,
        depth: 1,
        singleBranch: true,
        onAuth: onAuthFactory(authResolver),
    });
}

/**
 * @param {{ dir: string, ref?: string }} options
 * @returns {Promise<string>} OID or ''
 */
export async function resolveHead({ dir, ref = 'HEAD' }) {
    try {
        return (await git.resolveRef({ fs, dir, ref })) || '';
    } catch {
        return '';
    }
}

/** @param {{ dir: string, branch: string }} options @returns {Promise<string>} */
export async function resolveRemoteTracking({ dir, branch }) {
    try {
        return (await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` })) || '';
    } catch {
        return '';
    }
}

/** @param {{ dir: string }} options @returns {Promise<string>} current branch short name or '' */
export async function currentBranch({ dir }) {
    try {
        return (await git.currentBranch({ fs, dir, fullname: false })) || '';
    } catch {
        return '';
    }
}

/** @param {{ dir: string }} options @returns {Promise<string>} remote.origin.url or '' */
export async function remoteUrl({ dir }) {
    try {
        return (await git.getConfig({ fs, dir, path: 'remote.origin.url' })) || '';
    } catch {
        return '';
    }
}

/**
 * Rows where a tracked file differs from HEAD (modified, staged or deleted).
 * Reuses the predicate proven in the host codebase.
 * @param {{ dir: string }} options
 */
export async function dirtyTrackedFiles({ dir }) {
    const matrix = await git.statusMatrix({ fs, dir });
    return matrix
        .filter(([, head, workdir, stage]) => Number(head) > 0 && (Number(workdir) !== Number(head) || Number(stage) !== Number(head)))
        .map(([file]) => file);
}

/**
 * List every file path in a worktree (or a given commit when `ref` is set).
 * @param {{ dir: string, ref?: string }} options
 * @returns {Promise<string[]>}
 */
export async function listFiles({ dir, ref }) {
    return git.listFiles({ fs, dir, ref });
}

/**
 * Read a single file's bytes from a commit tree.
 * @param {{ dir: string, oid: string, filepath: string }} options
 * @returns {Promise<Uint8Array | null>}
 */
export async function readBlobAt({ dir, oid, filepath }) {
    try {
        const blob = await git.readBlob({ fs, dir, oid, filepath });
        return blob.blob;
    } catch {
        return null;
    }
}

/**
 * Commit the current worktree state (tracked changes only) onto a dedicated
 * backup branch without moving the active branch, then restore the active
 * branch checkout. Returns the stable backup ref name, or null when clean.
 * @param {{ dir: string, message?: string }} options
 * @returns {Promise<string | null>}
 */
export async function backupDirtyWorktree({ dir, message }) {
    const activeBranch = await currentBranch({ dir });
    if (!activeBranch) {
        return null;
    }

    const dirty = await dirtyTrackedFiles({ dir });
    if (dirty.length === 0) {
        return null;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupBranch = `git-improve-bak-${stamp}`;
    const backupRef = `refs/git-improve/backup/${stamp}`;

    await git.branch({ fs, dir, ref: backupBranch, checkout: true });

    try {
        for (const file of dirty) {
            const exists = fs.existsSync(path.join(dir, file));
            if (exists) {
                await git.add({ fs, dir, filepath: file });
            } else {
                await git.remove({ fs, dir, filepath: file });
            }
        }
        await git.commit({
            fs,
            dir,
            message: message || `st-git-improve backup ${stamp}`,
            author: DEFAULT_AUTHOR,
        });

        const backupOid = await git.resolveRef({ fs, dir, ref: `refs/heads/${backupBranch}` });
        await git.writeRef({ fs, dir, ref: backupRef, value: backupOid, force: true });
    } finally {
        await git.checkout({ fs, dir, ref: activeBranch, force: true });
        await git.deleteBranch({ fs, dir, ref: backupBranch }).catch(() => {});
    }

    return backupRef;
}

/**
 * Advance a branch to a new OID and force-checkout it (rebuild tracked files;
 * untracked files are untouched).
 * @param {{ dir: string, branch: string, oid: string }} options
 */
export async function advanceAndCheckout({ dir, branch, oid }) {
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
}

/**
 * List backup refs created by this plugin. Enumerates the filesystem and
 * packed-refs directly (listRefs is unreliable for loose custom-ref trees).
 * @param {{ dir: string }} options
 * @returns {Promise<Array<{ ref: string, oid: string }>>}
 */
export async function listBackupRefs({ dir }) {
    const names = [];
    const refsDir = path.join(dir, '.git', 'refs', 'git-improve', 'backup');
    const walk = rel => {
        const base = path.join(refsDir, rel);
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            const child = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(child);
            } else {
                names.push(`refs/git-improve/backup/${child}`);
            }
        }
    };
    if (fs.existsSync(refsDir)) {
        walk('');
    }
    const packed = path.join(dir, '.git', 'packed-refs');
    if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
            const match = line.match(/^([a-f0-9]{40}) (refs\/git-improve\/backup\/\S+)$/i);
            if (match) {
                names.push(match[2]);
            }
        }
    }

    const out = [];
    for (const ref of [...new Set(names)].sort().reverse()) {
        try {
            out.push({ ref, oid: await git.resolveRef({ fs, dir, ref }) });
        } catch {
            /* ref vanished concurrently */
        }
    }
    return out;
}

/**
 * Force-checkout a backup ref's tree into the worktree (rollback).
 * @param {{ dir: string, backupRef: string }} options
 */
export async function restoreBackup({ dir, backupRef }) {
    if (!String(backupRef).startsWith('refs/git-improve/backup/')) {
        throw new Error('invalid backup ref');
    }
    const oid = await git.resolveRef({ fs, dir, ref: backupRef });
    const branch = await currentBranch({ dir });
    await git.checkout({ fs, dir, ref: oid, force: true });
    if (branch) {
        await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
        await git.checkout({ fs, dir, ref: branch, force: true });
    }
}
