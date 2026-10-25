import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { dirsForRequest } from '../plugin/auth/identity.js';
import { tavernRoot } from '../plugin/paths.js';

const contextDirs = {
    localExtensionsDir: path.join(tavernRoot, 'data', 'default-user', 'extensions'),
    globalExtensionsDir: path.join(tavernRoot, 'data', 'extensions', 'third-party'),
    pluginsDir: path.join(tavernRoot, 'plugins'),
    selfPluginDir: path.join(tavernRoot, 'plugins', 'st-git-improve'),
};

describe('dirsForRequest', () => {
    it('keeps context dirs when the host provides none', () => {
        const identity = { mode: 'host' };
        const request = { user: { directories: {} } };
        assert.equal(dirsForRequest(identity, request, contextDirs), contextDirs);
    });

    it('anchors host-relative extension dirs at the tavern root', () => {
        const identity = { mode: 'host' };
        const request = { user: { directories: { extensions: 'data\\user1\\extensions' } } };
        const dirs = dirsForRequest(identity, request, contextDirs);
        assert.equal(dirs.localExtensionsDir, path.join(tavernRoot, 'data', 'user1', 'extensions'));
        assert.ok(path.isAbsolute(dirs.localExtensionsDir), 'result is absolute');
        // other scopes pass through untouched
        assert.equal(dirs.globalExtensionsDir, contextDirs.globalExtensionsDir);
    });

    it('keeps host-absolute extension dirs as-is', () => {
        const identity = { mode: 'host' };
        const absolute = path.join(tavernRoot, 'data', 'user2', 'extensions');
        const request = { user: { directories: { extensions: absolute } } };
        const dirs = dirsForRequest(identity, request, contextDirs);
        assert.equal(dirs.localExtensionsDir, absolute);
    });
});
