import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    agentForUrl,
    createHttpClient,
    effectiveProxyMode,
    invalidateSettingsCache,
} from '../plugin/git/proxy-http.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// proxy-http.js reads settings from <tavernRoot>/data/... — in this repo
// (no server.js marker) tavernRoot resolves to process.cwd(), so tests write
// the settings file into the repo's own data/ dir and clean up afterwards.
const settingsDir = path.join(process.cwd(), 'data', 'default-user', 'git-improve');
const settingsFile = path.join(settingsDir, 'settings.json');

function writeSettings(proxy) {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ proxy }));
    invalidateSettingsCache();
}

afterEach(() => {
    delete process.env.ST_GIT_IMPROVE_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    try {
        fs.rmSync(settingsFile, { force: true });
    } catch { /* ignore */ }
    invalidateSettingsCache();
});

describe('effectiveProxyMode', () => {
    it('defaults to direct', () => {
        assert.equal(effectiveProxyMode(), 'direct');
    });

    it('uses settings.json value', () => {
        writeSettings('http://127.0.0.1:7890');
        assert.equal(effectiveProxyMode(), 'http://127.0.0.1:7890');
    });

    it('env var overrides settings', () => {
        writeSettings('http://127.0.0.1:7890');
        process.env.ST_GIT_IMPROVE_PROXY = 'env';
        assert.equal(effectiveProxyMode(), 'env');
    });
});

describe('agentForUrl', () => {
    it('direct mode: no agent', () => {
        assert.equal(agentForUrl('https://github.com/a/b.git'), undefined);
    });

    it('url mode: https target gets HttpsProxyAgent', () => {
        writeSettings('http://proxy.local:7890');
        const agent = agentForUrl('https://github.com/a/b.git');
        assert.ok(agent instanceof HttpsProxyAgent, 'expected HttpsProxyAgent');
        assert.equal(agent.proxy.href, 'http://proxy.local:7890/');
    });

    it('url mode: http target gets HttpProxyAgent', () => {
        writeSettings('http://proxy.local:7890');
        const agent = agentForUrl('http://git.example.com/a/b.git');
        assert.ok(agent instanceof HttpProxyAgent, 'expected HttpProxyAgent');
        assert.equal(agent.proxy.href, 'http://proxy.local:7890/');
    });

    it('url mode: applies to loopback targets too (explicit intent)', () => {
        writeSettings('http://proxy.local:7890');
        assert.ok(agentForUrl('http://127.0.0.1:9000/repo.git'));
    });

    it('env mode: follows HTTPS_PROXY', () => {
        process.env.ST_GIT_IMPROVE_PROXY = 'env';
        process.env.HTTPS_PROXY = 'http://envproxy.local:7891';
        const agent = agentForUrl('https://github.com/a/b.git');
        assert.ok(agent instanceof HttpsProxyAgent);
        assert.equal(agent.proxy.href, 'http://envproxy.local:7891/');
    });

    it('env mode: loopback targets bypass the proxy', () => {
        process.env.ST_GIT_IMPROVE_PROXY = 'env';
        process.env.HTTP_PROXY = 'http://envproxy.local:7891';
        assert.equal(agentForUrl('http://127.0.0.1:9000/repo.git'), undefined);
        assert.equal(agentForUrl('http://localhost:9000/repo.git'), undefined);
    });

    it('env mode: honors NO_PROXY', () => {
        process.env.ST_GIT_IMPROVE_PROXY = 'env';
        process.env.HTTPS_PROXY = 'http://envproxy.local:7891';
        process.env.NO_PROXY = 'github.com,example.org';
        assert.equal(agentForUrl('https://github.com/a/b.git'), undefined);
        assert.ok(agentForUrl('https://gitlab.com/a/b.git'));
    });
});

describe('createHttpClient', () => {
    it('exposes the isomorphic-git HttpClient interface', () => {
        const client = createHttpClient();
        assert.equal(typeof client.request, 'function');
    });
});
