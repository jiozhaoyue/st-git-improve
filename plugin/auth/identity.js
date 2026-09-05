import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tavernRoot } from '../paths.js';

/**
 * Host identity integration. Native SillyTavern and Luker both ship
 * <tavern>/src/users.js exporting setUserDataMiddleware/requireLoginMiddleware
 * (cookieSession is applied globally by the host, so plugin routes can see
 * request.session). When that module loads we get real user identity:
 * request.user.profile.admin gates force-override actions, and per-user
 * directories route operations at the calling user's data dir.
 *
 * The host module is imported lazily on first request — it pulls in the host's
 * config-dependent module graph, which is only safe after host bootstrap
 * (config-init precedes plugin loading in the host, but laziness removes any
 * ordering assumption). On failure we degrade to 'fallback' mode: no identity,
 * force actions gated only by the explicit checkbox (trust declaration).
 *
 * @typedef {{ mode: 'unknown' | 'host' | 'fallback', setUserData?: Function, requireLogin?: Function, ensure?: () => Promise<void> }} Identity
 */

/**
 * @returns {Promise<{ mode: 'host' | 'fallback', setUserData?: Function, requireLogin?: Function }>}
 */
async function loadHostIdentity() {
    const usersModuleUrl = pathToFileURL(path.join(tavernRoot, 'src', 'users.js')).href;
    const users = await import(usersModuleUrl);
    if (typeof users.setUserDataMiddleware !== 'function' || typeof users.requireLoginMiddleware !== 'function') {
        throw new Error('host users.js does not export the expected middleware');
    }
    return { mode: 'host', setUserData: users.setUserDataMiddleware, requireLogin: users.requireLoginMiddleware };
}

/**
 * A mutable identity holder whose ensure() resolves the real mode on first
 * call (memoized). Routes capture the same object, so in-place updates are
 * visible everywhere.
 * @returns {Identity}
 */
export function createIdentity() {
    const identity = { mode: 'unknown', setUserData: null, requireLogin: null };
    let promise = null;
    identity.ensure = () => {
        if (!promise) {
            promise = loadHostIdentity()
                .then(resolved => {
                    identity.mode = resolved.mode;
                    identity.setUserData = resolved.setUserData;
                    identity.requireLogin = resolved.requireLogin;
                    console.info(`[st-git-improve] identity mode: ${identity.mode}`);
                })
                .catch(error => {
                    identity.mode = 'fallback';
                    console.info(`[st-git-improve] host identity unavailable (${error?.message || error}); using fallback trust mode`);
                });
        }
        return promise;
    };
    return identity;
}

/** @returns {boolean} true when identity is real and the request user is admin */
export function isAdminRequest(identity, request) {
    if (identity.mode !== 'host') {
        return false;
    }
    return request.user?.profile?.admin === true;
}

/**
 * Per-request directories: use the calling user's data directories when the
 * host provides them, else the configured defaults.
 * @param {Identity} identity
 * @param {object} request
 * @param {object} contextDirs
 */
export function dirsForRequest(identity, request, contextDirs) {
    const userExtensions = identity.mode === 'host' ? request.user?.directories?.extensions : undefined;
    if (!userExtensions) {
        return contextDirs;
    }
    return { ...contextDirs, localExtensionsDir: userExtensions };
}
