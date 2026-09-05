import fs from 'node:fs';
import path from 'node:path';

import { createRouter } from './routes.js';
import { CredentialStore } from './auth/store.js';
import { createIdentity } from './auth/identity.js';
import { cleanStaleTempDirs } from './ops/install.js';
import { runAutoDedup } from './ops/dedup.js';
import {
    globalExtensionsDir,
    localExtensionsDir,
    pluginDataDir,
    readConfig,
    serverPluginsDir,
    tavernRoot,
    packageRoot,
} from './paths.js';
import { readJsonOr, redactUrl } from './util.js';

export const info = {
    id: 'st-git-improve',
    name: 'ST Git Improve',
    description: '私有源认证安装、重建式更新（自动备份）、npm 依赖修复与扩展诊断。补充面板，不改动原生扩展管理。',
};

/**
 * Copy the bundled front-end extension into the user's extension directory
 * when its version differs. Only ever touches its own directory.
 * @param {{ dirs: object }} context
 */
function bootstrapFrontendExtension(context) {
    const sourceDir = path.join(packageRoot, 'extension');
    const manifestSource = path.join(sourceDir, 'manifest.json');
    if (!fs.existsSync(manifestSource)) {
        console.warn('[st-git-improve] extension/ manifest missing, skip bootstrap');
        return;
    }
    let version = '';
    try {
        version = String(JSON.parse(fs.readFileSync(manifestSource, 'utf8')).version || '');
    } catch {
        return;
    }
    const targetDir = path.join(context.dirs.localExtensionsDir, info.id);
    const manifestTarget = path.join(targetDir, 'manifest.json');
    let installedVersion = '';
    try {
        installedVersion = String(JSON.parse(fs.readFileSync(manifestTarget, 'utf8')).version || '');
    } catch {
        /* not installed yet */
    }
    if (version && version === installedVersion && fs.existsSync(path.join(targetDir, 'index.js'))) {
        return;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of fs.readdirSync(sourceDir)) {
        fs.cpSync(path.join(sourceDir, file), path.join(targetDir, file), { force: true });
    }
    console.info(`[st-git-improve] front-end panel installed to ${targetDir} (v${version})`);
}

/**
 * @param {import('express').Router} router Router provided by the host; the
 * host mounts it at /api/plugins/st-git-improve
 */
export async function init(router) {
    const config = readConfig();
    const dirs = {
        localExtensionsDir: localExtensionsDir(),
        globalExtensionsDir: globalExtensionsDir(),
        pluginsDir: serverPluginsDir(),
        selfPluginDir: path.dirname(packageRoot),
    };
    const context = {
        dirs,
        selfPluginDir: path.dirname(packageRoot),
        tavernRoot,
        store: new CredentialStore(path.join(pluginDataDir(), 'credentials.json')),
        registry: process.env.ST_GIT_IMPROVE_REGISTRY || config.registry || '',
        identity: createIdentity(),
    };

    try {
        cleanStaleTempDirs(dirs.localExtensionsDir);
        cleanStaleTempDirs(dirs.globalExtensionsDir);
        bootstrapFrontendExtension(context);
    } catch (error) {
        console.error('[st-git-improve] startup housekeeping failed:', error?.message || error);
    }

    if (readJsonOr(path.join(pluginDataDir(), 'settings.json'), {}).autoDedup === true) {
        try {
            const result = await runAutoDedup({ dirs });
            if (result.removed.length > 0 || result.skipped.length > 0) {
                console.info(`[st-git-improve] auto-dedup removed: ${result.removed.join(', ') || '(none)'}` +
                    (result.skipped.length > 0 ? `; skipped (has local changes): ${result.skipped.map(s => s.name).join(', ')}` : ''));
            }
        } catch (error) {
            console.error('[st-git-improve] auto-dedup failed:', error?.message || error);
        }
    }

    router.use(createRouter(context));
    console.info(`[st-git-improve] ready. api=/api/plugins/${info.id} data=${redactUrl(pluginDataDir())}`);
}

export default { info, init };
