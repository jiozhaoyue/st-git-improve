import fs from 'node:fs';
import path from 'node:path';

import * as engine from '../git/engine.js';
import { redactUrl, readJsonOr } from '../util.js';
import { depsMissing } from './deps.js';

function manifestOk(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return null; // not an extension requirement (e.g. server plugin)
    }
    const manifest = readJsonOr(manifestPath, null);
    return Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
}

/**
 * Diagnose one managed directory.
 * @param {{ name: string, target: string, dir: string, hasCredential: boolean, remoteProbe?: boolean, authResolver?: Function }} entry
 */
export async function diagnoseEntry({ name, target, dir, hasCredential, remoteProbe, authResolver }) {
    /** @type {string[]} */
    const issues = [];
    const status = {
        name,
        target,
        dir,
        isRepo: false,
        branch: '',
        oid: '',
        remote: '',
        dirtyFiles: [],
        manifestOk: manifestOk(dir),
        depsMissing: depsMissing(dir),
        hasCredential,
        remoteReachable: null,
        issues,
    };

    if (!fs.existsSync(path.join(dir, '.git'))) {
        issues.push('非 git 目录（无法通过 git 更新）');
        return status;
    }
    status.isRepo = true;

    status.branch = await engine.currentBranch({ dir });
    status.oid = await engine.resolveHead({ dir });
    const remote = await engine.remoteUrl({ dir });
    status.remote = redactUrl(remote);

    if (status.manifestOk === false) {
        issues.push('manifest.json 缺失或损坏');
    }
    if (status.depsMissing) {
        issues.push('npm 依赖未安装或缺失');
    }
    if (!status.branch) {
        issues.push('处于分离 HEAD/标签状态（需重装才能更新）');
    }

    try {
        status.dirtyFiles = await engine.dirtyTrackedFiles({ dir });
        if (status.dirtyFiles.length > 0) {
            issues.push(`本地改动 ${status.dirtyFiles.length} 个文件（更新时会自动备份）`);
        }
    } catch {
        issues.push('git 状态读取失败');
    }

    if (remoteProbe && remote && status.branch) {
        try {
            await engine.listRemoteBranches({ url: remote, authResolver });
            status.remoteReachable = true;
        } catch {
            status.remoteReachable = false;
            issues.push(hasCredential ? '远端不可达（检查网络或凭据有效性）' : '远端不可达或需要凭据（未配置该站点的登录）');
        }
    }

    return status;
}

/**
 * Scan extension/plugin directories (excludes this plugin itself).
 * @param {{ dirs: object, selfPluginDir: string, store: object, remoteProbe?: boolean }} options
 */
export async function diagnoseAll({ dirs, selfPluginDir, store, remoteProbe }) {
    const groups = [
        { target: 'extension', base: dirs.localExtensionsDir },
        { target: 'global', base: dirs.globalExtensionsDir },
        { target: 'plugin', base: dirs.pluginsDir },
    ];

    const results = [];
    for (const group of groups) {
        if (!fs.existsSync(group.base)) {
            continue;
        }
        const entries = fs.readdirSync(group.base, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .filter(entry => !entry.name.startsWith('.'));
        for (const entry of entries) {
            const dir = path.join(group.base, entry.name);
            if (path.resolve(dir) === path.resolve(selfPluginDir)) {
                continue;
            }
            let remote = '';
            try {
                remote = await engine.remoteUrl({ dir });
            } catch { /* leave '' */ }
            const hasCredential = remote ? Boolean(store.findForUrl(remote)) : false;
            results.push(await diagnoseEntry({
                name: entry.name,
                target: group.target,
                dir,
                hasCredential,
                remoteProbe,
                authResolver: remote ? store.authResolverForUrl(remote) : undefined,
            }));
        }
    }
    return results;
}
