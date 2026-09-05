import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// plugin/paths.js lives at <tavern>/plugins/st-git-improve/plugin/ when installed.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.dirname(thisDir);

/**
 * Locate the tavern root by walking up from the package directory looking for
 * a marker (server.js + data/). Falls back to CWD for development runs.
 * @returns {string}
 */
function findTavernRoot() {
    let current = packageRoot;
    for (let i = 0; i < 5; i++) {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
        if (fs.existsSync(path.join(current, 'server.js')) && fs.existsSync(path.join(current, 'data'))) {
            return current;
        }
    }
    return process.cwd();
}

export const tavernRoot = findTavernRoot();

/**
 * Global third-party extension directory: prefer the data-root layout, fall
 * back to the default public tree (mirrors PUBLIC_DIRECTORIES resolution).
 * @returns {string}
 */
export function globalExtensionsDir() {
    const dataLayout = path.join(tavernRoot, 'data', 'extensions', 'third-party');
    if (fs.existsSync(dataLayout)) {
        return dataLayout;
    }
    return path.join(tavernRoot, 'public', 'scripts', 'extensions', 'third-party');
}

/** @returns {string} Server plugins directory (includes this plugin itself). */
export function serverPluginsDir() {
    return path.join(tavernRoot, 'plugins');
}

/**
 * @param {string} [userHandle]
 * @returns {string} Per-user data root, e.g. <tavern>/data/default-user
 */
export function userDataRoot(userHandle) {
    const handle = userHandle || process.env.ST_GIT_IMPROVE_USER || readConfig().user || 'default-user';
    return path.join(tavernRoot, 'data', handle);
}

/** @param {string} [userHandle] @returns {string} Local per-user extension directory */
export function localExtensionsDir(userHandle) {
    return path.join(userDataRoot(userHandle), 'extensions');
}

/** @param {string} [userHandle] @returns {string} Plugin-private data directory */
export function pluginDataDir(userHandle) {
    return path.join(userDataRoot(userHandle), 'git-improve');
}

/**
 * Optional config file: <tavern>/data/git-improve.json — { user, registry }
 * @returns {{ user?: string, registry?: string }}
 */
export function readConfig() {
    const configPath = path.join(tavernRoot, 'data', 'git-improve.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}
