import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

// ------------------------- SSH / file 桥（系统 git 通道） -------------------------

/**
 * 判断 URL 是否需要系统 git 通道（isomorphic-git 只支持 http/https）。
 * 接受 ssh://、scp 语法（git@host:path）、git:// 与 file://。
 * @param {string} url
 */
export function isSystemGitUrl(url) {
    const raw = String(url || '').trim();
    if (/^file:\/\//i.test(raw)) return true;
    if (/^ssh:\/\//i.test(raw)) return true;
    if (/^git:\/\//i.test(raw)) return true;
    return /^[^@/]+@[^:/]+:.+$/.test(raw) && !/^https?:\/\//i.test(raw);
}

let systemGitProbeCache;
/**
 * 系统 git 探测（结果缓存）：可用性 + 版本字符串（如 "git version 2.45.0"）。
 * @returns {{ available: boolean, version: string }}
 */
function probeSystemGit() {
    if (systemGitProbeCache === undefined) {
        try {
            const { status, stdout } = spawnSync('git', ['--version'], {
                encoding: 'utf8',
                windowsHide: true,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            });
            const version = status === 0 ? String(stdout || '').trim() : '';
            systemGitProbeCache = { available: status === 0, version };
        } catch {
            systemGitProbeCache = { available: false, version: '' };
        }
    }
    return systemGitProbeCache;
}

/**
 * 系统 git 是否可用（结果缓存）。
 * @returns {boolean}
 */
export function systemGitAvailable() {
    return probeSystemGit().available;
}

/**
 * 系统 git 版本字符串（不可用时为空串；结果缓存）。
 * @returns {string}
 */
export function systemGitVersion() {
    return probeSystemGit().version;
}

/**
 * 运行系统 git（异步，拒绝交互式提示；stdout/stderr 以 utf8 收集）。
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runSystemGit(args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd: options.cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

/**
 * 把 scp 语法（git@host:path）规范化为 ssh:// 形式，其余原样返回。
 * @param {string} url
 * @returns {string}
 */
export function toSystemGitUrl(url) {
    const raw = String(url || '').trim();
    const scp = raw.match(/^([^@/]+)@([^:/]+):(?!\d)(.+)$/);
    if (scp && !/^[a-z]+:\/\//i.test(raw)) {
        return `ssh://${scp[1]}@${scp[2]}/${scp[3].replace(/^\/+/, '')}`;
    }
    return raw;
}

/**
 * 系统 git 克隆（完整历史，不做浅克隆——浅克隆重会让 isomorphic-git 的
 * 本地对象读取在 graft 提交上不可靠）。
 * @param {{ url: string, dir: string, branch?: string }} options
 */
export async function systemGitClone({ url, dir, branch }) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const args = ['clone', toSystemGitUrl(url), dir];
    if (branch) args.push('--branch', branch, '--single-branch');
    const { status, stderr } = await runSystemGit(args);
    if (status !== 0) {
        throw new Error(stderr.trim() || `git clone 退出码 ${status}`);
    }
}

/**
 * 系统 git 列出远端分支 head（ls-remote）。
 * @param {{ url: string, branch: string }} options
 * @returns {Promise<string>} OID 或 ''
 */
export async function systemGitRemoteHead({ url, branch }) {
    const { status, stdout } = await runSystemGit(['ls-remote', toSystemGitUrl(url), `refs/heads/${branch}`]);
    if (status !== 0) {
        throw new Error(`git ls-remote 失败`);
    }
    return stdout.split('\n')[0]?.split('\t')[0]?.trim() || '';
}

/**
 * 系统 git 拉取远端分支并更新 origin 跟踪引用（完整拉取，供 isomorphic-git
 * 的本地对象读取与后续 advance/checkout 使用）。
 * @param {{ dir: string, branch: string }} options
 */
export async function systemGitFetch({ dir, branch }) {
    const { status, stderr } = await runSystemGit(['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: dir });
    if (status !== 0) {
        throw new Error(stderr.trim() || `git fetch 退出码 ${status}`);
    }
}

// ------------------------- isomorphic-git 主通道 -------------------------

/**
 * Clone a repository (shallow, single branch by default).
 * http/https 走 isomorphic-git（零系统依赖）；ssh/git@/file 走系统 git 桥。
 * @param {{ url: string, dir: string, branch?: string, depth?: number, authResolver?: AuthResolver, onProgress?: (event: object) => void }} options
 */
export async function clone({ url, dir, branch, depth = 1, authResolver, onProgress }) {
    if (isSystemGitUrl(url)) {
        if (!systemGitAvailable()) {
            throw new Error('SSH/file 远端需要系统 git（PATH 中未检测到 git）');
        }
        return systemGitClone({ url, dir, branch });
    }
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
    if (isSystemGitUrl(url)) {
        if (!systemGitAvailable()) {
            throw new Error('SSH/file 远端需要系统 git（PATH 中未检测到 git）');
        }
        const { status, stdout, stderr } = await runSystemGit(['ls-remote', toSystemGitUrl(url), 'refs/heads/*']);
        if (status !== 0) {
            throw new Error(stderr.trim() || 'git ls-remote 失败');
        }
        return stdout.split('\n').filter(Boolean).map(line => {
            const [oid, ref] = line.split('\t');
            return { ref: (ref || '').trim(), oid: (oid || '').trim() };
        }).filter(entry => entry.ref && entry.oid);
    }
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
 * ssh/file 远端走系统 git 完整拉取（并更新 origin 跟踪引用）。
 * @param {{ dir: string, url: string, branch: string, authResolver?: AuthResolver }} options
 */
export async function fetchBranch({ dir, url, branch, authResolver }) {
    if (isSystemGitUrl(url)) {
        if (!systemGitAvailable()) {
            throw new Error('SSH/file 远端需要系统 git（PATH 中未检测到 git）');
        }
        return systemGitFetch({ dir, branch });
    }
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
 * Reuses the predicate proven in the host codebase. The workdir walk skips
 * node_modules — never tracked in practice, and hashing them made scans of
 * large extensions (hundreds of MB) take seconds each.
 * @param {{ dir: string }} options
 */
export async function dirtyTrackedFiles({ dir }) {
    const matrix = await git.statusMatrix({
        fs,
        dir,
        filter: file => !file.startsWith('node_modules') && !file.includes('/node_modules/'),
    });
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
 * Delete one backup ref (loose first, packed-refs fallback) so repeated
 * updates don't grow .git forever.
 * @param {{ dir: string, backupRef: string }} options
 */
export async function deleteBackupRef({ dir, backupRef }) {
    if (!String(backupRef).startsWith('refs/git-improve/backup/')) {
        throw new Error('invalid backup ref');
    }
    const loosePath = path.join(dir, '.git', ...String(backupRef).split('/'));
    if (fs.existsSync(loosePath)) {
        fs.rmSync(loosePath, { force: true });
        return;
    }
    const packed = path.join(dir, '.git', 'packed-refs');
    if (fs.existsSync(packed)) {
        const lines = fs.readFileSync(packed, 'utf8').split('\n');
        const kept = lines.filter(line => !line.endsWith(` ${backupRef}`));
        if (kept.length !== lines.length) {
            fs.writeFileSync(packed, kept.join('\n'), 'utf8');
            return;
        }
    }
    throw new Error(`backup ref not found: ${backupRef}`);
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
