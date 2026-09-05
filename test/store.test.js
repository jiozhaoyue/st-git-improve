import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CredentialStore, defaultAuthUsername } from '../plugin/auth/store.js';

describe('CredentialStore', () => {
    /** @type {CredentialStore} */
    let store;
    let file;

    beforeEach(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-store-'));
        file = path.join(dir, 'credentials.json');
        store = new CredentialStore(file);
    });

    it('adds, replaces per host+user, and lists sanitized', () => {
        store.addSite({ host: 'git.example.com', baseUrl: 'https://git.example.com', type: 'gitea', method: 'pat', username: 'alice', token: 'tok1' });
        store.addSite({ host: 'git.example.com', baseUrl: 'https://git.example.com', type: 'gitea', method: 'pat', username: 'alice', token: 'tok2' });
        store.addSite({ host: 'github.com', type: 'github', method: 'pat', token: 'ghp_x' });

        const sites = store.listSites();
        assert.equal(sites.length, 2);
        assert.ok(!JSON.stringify(sites).includes('tok1'));
        assert.ok(!JSON.stringify(sites).includes('ghp_x'));
        assert.equal(sites.find(site => site.host === 'github.com').hasToken, true);

        const internal = store.findForUrl('https://git.example.com/some/repo.git');
        assert.equal(internal.token, 'tok2');
    });

    it('findForUrl matches host case-insensitively, ignores unknown hosts', () => {
        store.addSite({ host: 'Gitea.Example.COM', type: 'gitea', token: 't' });
        assert.ok(store.findForUrl('https://gitea.example.com/a/b'));
        assert.equal(store.findForUrl('https://other.example.com/a/b'), undefined);
    });

    it('updateToken and removeSite', () => {
        const site = store.addSite({ host: 'h.example.com', type: 'gitea', method: 'pat', token: 'old' });
        store.updateToken(site.id, 'new');
        assert.equal(store.findForUrl('https://h.example.com/x').token, 'new');
        assert.equal(store.removeSite(site.id), true);
        assert.equal(store.findForUrl('https://h.example.com/x'), undefined);
        assert.equal(store.removeSite(site.id), false);
    });

    it('authResolverForUrl returns credentials only for matching hosts', () => {
        store.addSite({ host: 'git.example.com', type: 'gitea', username: 'bob', token: 't' });
        const resolver = store.authResolverForUrl('https://git.example.com/r.git');
        assert.deepEqual(resolver(), { username: 'bob', password: 't' });
        assert.equal(store.authResolverForUrl('https://elsewhere.com/r.git')(), undefined);
    });

    it('persists atomically to the given file', () => {
        store.addSite({ host: 'x.example.com', type: 'gitea', token: 't' });
        const reloaded = new CredentialStore(file);
        assert.ok(reloaded.findForUrl('https://x.example.com/a'));
    });
});

describe('defaultAuthUsername', () => {
    it('uses conventions per site type', () => {
        assert.equal(defaultAuthUsername({ type: 'github' }), 'x-access-token');
        assert.equal(defaultAuthUsername({ type: 'gitlab' }), 'oauth2');
        assert.equal(defaultAuthUsername({ type: 'gitea', username: 'alice' }), 'alice');
    });
});
