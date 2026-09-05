import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adapters, detectTypeForHost, normalizeBaseUrl, deviceFlowPoll, deviceFlowStart } from '../plugin/auth/sites.js';

describe('site detection', () => {
    it('detects known public hosts', () => {
        assert.equal(detectTypeForHost('github.com'), 'github');
        assert.equal(detectTypeForHost('gitlab.com'), 'gitlab');
        assert.equal(detectTypeForHost('gitee.com'), 'gitee');
        assert.equal(detectTypeForHost('git.example.com'), '');
    });
});

describe('normalizeBaseUrl', () => {
    it('strips trailing slashes and rejects non-http', () => {
        assert.equal(normalizeBaseUrl('https://git.example.com/'), 'https://git.example.com');
        assert.equal(normalizeBaseUrl('https://git.example.com/gitea/'), 'https://git.example.com/gitea');
        assert.throws(() => normalizeBaseUrl('ftp://x'));
    });
});

describe('adapter capabilities', () => {
    it('matches the design matrix', () => {
        assert.equal(adapters.gitea.passwordExchange, true);
        assert.equal(adapters.gitea.deviceFlow, false);
        assert.equal(adapters.github.deviceFlow, true);
        assert.equal(adapters.github.passwordExchange, false);
        assert.equal(adapters.gitlab.deviceFlow, true);
        assert.equal(adapters.gitee.deviceFlow, false);
        assert.equal(adapters.gitee.passwordExchange, false);
    });

    it('device flow start fails fast without client id', async () => {
        delete process.env.ST_GIT_IMPROVE_GITHUB_CLIENT_ID;
        await assert.rejects(
            () => deviceFlowStart({
                deviceCodeUrl: 'https://github.com/login/device/code',
                tokenUrl: 'https://github.com/login/oauth/access_token',
                clientId: '',
                scope: 'repo',
            }),
            /client_id/,
        );
    });
});

describe('deviceFlowPoll', () => {
    const makeState = () => ({
        deviceCode: 'DC',
        _tokenUrl: 'https://token.example',
        _clientId: 'CID',
    });

    async function withFetch(payload, fn) {
        const original = globalThis.fetch;
        globalThis.fetch = async () => ({ json: async () => payload });
        try {
            return await fn();
        } finally {
            globalThis.fetch = original;
        }
    }

    it('maps authorization_pending to pending', async () => {
        await withFetch({ error: 'authorization_pending' }, async () =>
            assert.equal((await deviceFlowPoll({ state: makeState() })).status, 'pending'));
    });

    it('maps access_token to granted', async () => {
        await withFetch({ access_token: 'T' }, async () => {
            const result = await deviceFlowPoll({ state: makeState() });
            assert.equal(result.status, 'granted');
            assert.equal(result.token, 'T');
        });
    });

    it('maps expired_token to expired', async () => {
        await withFetch({ error: 'expired_token' }, async () =>
            assert.equal((await deviceFlowPoll({ state: makeState() })).status, 'expired'));
    });
});
