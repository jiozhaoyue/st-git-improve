// Local end-to-end: full plugin router against temp sandbox dirs + fixture git
// server. Run: node test/e2e-local.mjs  (requires git on PATH for fixtures only)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import express from 'express';

import { CredentialStore } from '../plugin/auth/store.js';
import { createRouter } from '../plugin/routes.js';
import {
    startGitHttpBackend,
    createBareRepo,
    makeWorkClone,
    pushNewCommit,
    pushManifestVersion,
    tempRoot,
} from './helpers/fixture-server.mjs';

/**
 * Plain HTTP forward proxy (absolute-form request line), counting requests.
 * Only http targets are supported — enough to verify the proxy switch E2E.
 */
function startForwardProxy() {
    let count = 0;
    const server = http.createServer((request, response) => {
        count += 1;
        const target = new URL(request.url); // absolute-form
        const headers = { ...request.headers };
        delete headers['proxy-connection'];
        headers.host = target.host;
        const upstream = http.request({
            hostname: target.hostname,
            port: target.port,
            method: request.method,
            path: target.pathname + target.search,
            headers,
        }, upstreamResponse => {
            response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        });
        upstream.on('error', error => {
            response.writeHead(502);
            response.end(String(error));
        });
        request.pipe(upstream);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                count: () => count,
                close: () => server.close(),
            });
        });
    });
}

const root = tempRoot();
const fixtureDir = path.join(root, 'fixture');
fs.mkdirSync(fixtureDir, { recursive: true });
const sandbox = {
    localExtensionsDir: path.join(root, 'data', 'default-user', 'extensions'),
    globalExtensionsDir: path.join(root, 'data', 'extensions', 'third-party'),
    pluginsDir: path.join(root, 'plugins'),
    selfPluginDir: path.join(root, 'plugins', 'st-git-improve'),
};

const { server, port, close } = await startGitHttpBackend(fixtureDir);
const { repoDir } = createBareRepo(fixtureDir);
const base = `http://127.0.0.1:${port}`;
const repoUrl = `${base}/hello.git`;
const proxy = await startForwardProxy();

const app = express();
app.use(express.json());
app.use('/api/plugins/st-git-improve', createRouter({
    dirs: sandbox,
    selfPluginDir: sandbox.selfPluginDir,
    tavernRoot: root,
    store: new CredentialStore(path.join(root, 'data', 'default-user', 'git-improve', 'credentials.json')),
    registry: 'https://registry.npmmirror.com',
}));
const httpServer = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const apiPort = httpServer.address().port;
const API = `http://127.0.0.1:${apiPort}/api/plugins/st-git-improve`;

const call = async (verb, urlPath, body) => {
    const response = await fetch(`${API}${urlPath}`, {
        method: verb,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text };
    }
    return { status: response.status, data };
};

/** @param {string} name */
function expect(cond, message) {
    if (!cond) {
        throw new Error(`E2E FAIL: ${message}`);
    }
    console.log(`  ✔ ${message}`);
}

let exitCode = 1;
try {
    // 1. health
    {
        const { status, data } = await call('GET', '/health');
        assert.equal(status, 200);
        expect(data.ok === true, 'health');
    }

    // 2. install (anonymous clone of fixture)
    {
        const { status, data } = await call('POST', '/install', { url: repoUrl, target: 'extension' });
        assert.equal(status, 200, JSON.stringify(data));
        expect(data.name === 'hello', 'install returns dir name');
        const manifest = JSON.parse(fs.readFileSync(path.join(sandbox.localExtensionsDir, 'hello', 'manifest.json'), 'utf8'));
        expect(manifest.display_name === 'Hello', 'manifest present after install');
    }

    // 3. duplicate install → 409
    {
        const { status } = await call('POST', '/install', { url: repoUrl, target: 'extension' });
        assert.equal(status, 409);
        expect(status === 409, 'duplicate install conflicts with 409');
        const { status: replaceStatus } = await call('POST', '/install', { url: repoUrl, target: 'extension', replace: true });
        assert.equal(replaceStatus, 200);
        expect(replaceStatus === 200, 'replace install succeeds');
    }

    // 4. diagnose shows the extension, clean
    {
        const { status, data } = await call('GET', '/diagnose');
        assert.equal(status, 200);
        const entry = data.entries.find(e => e.name === 'hello');
        expect(entry && entry.isRepo && entry.issues.length === 0, 'diagnose reports clean extension');
    }

    // 5. update → up to date
    {
        const { status, data } = await call('POST', '/update', { target: 'extension', name: 'hello' });
        assert.equal(status, 200, JSON.stringify(data));
        expect(data.upToDate === true, 'update reports up-to-date');
    }

    // 6. dirty local + upstream commit → rebuild with backup
    let backupRef;
    {
        const extDir = path.join(sandbox.localExtensionsDir, 'hello');
        fs.writeFileSync(path.join(extDir, 'README'), 'local hack that took real effort\n');

        const work = makeWorkClone(fixtureDir, repoDir);
        pushNewCommit(repoDir, work, 'upstream v2', 'upstream readme v2\n');

        const { status, data } = await call('POST', '/update', { target: 'extension', name: 'hello' });
        assert.equal(status, 200, JSON.stringify(data));
        expect(data.upToDate === false && data.backupRef, 'update rebuilds despite dirty worktree and creates backup');
        backupRef = data.backupRef;
        const readme = fs.readFileSync(path.join(extDir, 'README'), 'utf8');
        expect(readme.includes('upstream readme v2'), 'worktree now matches upstream');
        const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
        expect(manifest.display_name === 'Hello', 'manifest intact after rebuild');
    }

    // 7. backups list + recover
    {
        const { data: list } = await call('GET', '/backups?target=extension&name=hello');
        expect(list.backups.length >= 1, 'backup listed');
        const { status, data } = await call('POST', '/recover', { target: 'extension', name: 'hello', backupRef });
        assert.equal(status, 200, JSON.stringify(data));
        const readme = fs.readFileSync(path.join(sandbox.localExtensionsDir, 'hello', 'README'), 'utf8');
        expect(readme.includes('local hack'), 'recover restores backed-up local state');
    }

    // 8. re-repair to upstream
    {
        const { data } = await call('POST', '/update', { target: 'extension', name: 'hello' });
        expect(data.upToDate === false, 're-repair pulls upstream again');
        const { data: again } = await call('POST', '/update', { target: 'extension', name: 'hello' });
        expect(again.upToDate === true, 'converges to up-to-date');
    }

    // 9. deps repair with mirror registry
    {
        const pluginDir = path.join(sandbox.pluginsDir, 'fake-plugin');
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'fake-plugin', main: 'index.js', dependencies: { 'left-pad': '^1.3.0' } }));
        fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};\n');
        const { status, data } = await call('POST', '/deps', { target: 'plugin', name: 'fake-plugin' });
        assert.equal(status, 200, JSON.stringify(data).slice(0, 300));
        expect(data.skipped === false, 'deps install runs');
        expect(fs.existsSync(path.join(pluginDir, 'node_modules', 'left-pad')), 'dependency installed');
    }

    // 10. credentials: PAT add, sanitized list, userinfo path, delete
    {
        const { status, data } = await call('POST', '/sites', {
            method: 'pat',
            baseUrl: 'https://git.example.com',
            type: 'gitea',
            username: 'alice',
            token: 'SECRET_TOKEN_123',
        });
        assert.equal(status, 200);
        expect(data.site.hasToken === true && !JSON.stringify(data.site).includes('SECRET_TOKEN_123'), 'PAT saved without echoing token');

        const list = await (await fetch(`${API}/sites`)).json();
        expect(!JSON.stringify(list).includes('SECRET_TOKEN_123'), 'site list never leaks token');

        const { status: uiStatus, data: uiData } = await call('POST', '/sites', {
            method: 'userinfo',
            url: 'https://bob:TOPSECRET99@gitlab.corp.cn/group/repo.git',
            type: 'gitlab',
        });
        assert.equal(uiStatus, 200, JSON.stringify(uiData));
        expect(uiData.site.host === 'gitlab.corp.cn' && uiData.site.type === 'gitlab', 'userinfo URL extracts host and keeps explicit type');
        const list2 = await (await fetch(`${API}/sites`)).json();
        expect(!JSON.stringify(list2).includes('TOPSECRET99'), 'userinfo secret never leaks');

        const removed = await call('DELETE', `/sites/${uiData.site.id}`);
        assert.equal(removed.status, 200);
        expect(removed.data.ok === true, 'site delete works');
    }

    // 11. explicit proxy switch
    {
        const { status, data } = await call('POST', '/settings', { proxy: proxy.url });
        assert.equal(status, 200, JSON.stringify(data));
        expect(data.proxy === proxy.url, 'settings round-trip: custom proxy saved');

        const before = proxy.count();
        const { status: viaProxy } = await call('POST', '/install', { url: repoUrl, target: 'global', replace: true });
        assert.equal(viaProxy, 200);
        expect(proxy.count() > before, 'url mode: git traffic goes through the proxy');

        await call('POST', '/settings', { proxy: 'direct' });
        const before2 = proxy.count();
        const { status: direct } = await call('POST', '/install', { url: repoUrl, target: 'global', replace: true });
        assert.equal(direct, 200);
        expect(proxy.count() === before2, 'direct mode bypasses the proxy');

        const { data: settings } = await call('GET', '/settings');
        expect(settings.proxy === 'direct', 'settings restored to direct');
    }

    // 12. dedup policy: global blocks local install (granularity configurable)
    {
        // global hello exists from the proxy section; local hello also exists.
        const blocked = await call('POST', '/install', { url: repoUrl, target: 'extension', replace: true });
        assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
        expect(blocked.status === 409, 'name granularity: local install blocked when global exists');
        expect(String(blocked.data.raw || '').includes('全局'), 'block message mentions global');

        const { status: forced } = await call('POST', '/install', { url: repoUrl, target: 'extension', replace: true, force: true });
        assert.equal(forced, 200);
        expect(forced === 200, 'force bypasses dedup');

        const { data: dedup } = await call('GET', '/dedup');
        const dup = dedup.duplicates.find(d => d.name === 'hello');
        expect(dup && dup.localSize > 0 && dup.globalSize > 0, 'dedup scan reports duplicate with disk usage');

        // dirty local copy → delete refused unless forced
        fs.writeFileSync(path.join(sandbox.localExtensionsDir, 'hello', 'README'), 'dirty local edit\n');
        const refused = await fetch(`${API}/dedup`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'hello' }),
        });
        assert.equal(refused.status, 409);
        expect(refused.status === 409, 'delete refused when local copy has changes');

        const removed = await fetch(`${API}/dedup`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'hello', force: true }),
        });
        assert.equal(removed.status, 200);
        expect(!fs.existsSync(path.join(sandbox.localExtensionsDir, 'hello')), 'local duplicate removed');

        // name+version granularity: different candidate version allowed
        await call('POST', '/settings', { dedupGranularity: 'name+version' });
        const work = makeWorkClone(fixtureDir, repoDir);
        pushManifestVersion(repoDir, work, '2.0.0');
        const allowed = await call('POST', '/install', { url: repoUrl, target: 'extension' });
        assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
        expect(allowed.status === 200, 'name+version granularity: different version allowed');

        // same candidate version as global → blocked
        pushManifestVersion(repoDir, work, '1.0.0');
        const blockedSame = await call('POST', '/install', { url: repoUrl, target: 'extension', replace: true });
        assert.equal(blockedSame.status, 409);
        expect(blockedSame.status === 409, 'name+version granularity: same version blocked');

        const { data: settings } = await call('POST', '/settings', { dedupGranularity: 'name' });
        expect(settings.dedupGranularity === 'name', 'granularity restored');
    }

    // 13. host identity gating (stubbed host users middleware) + auto-dedup
    {
        const makeApi = (admin, userExtensions) => {
            const identity = {
                mode: 'host',
                setUserData: (request, response, next) => {
                    request.user = {
                        profile: { admin, handle: admin ? 'admin' : 'user1' },
                        directories: userExtensions ? { extensions: userExtensions } : {},
                    };
                    next();
                },
                requireLogin: (request, response, next) => next(),
            };
            const dedupApp = express();
            dedupApp.use(express.json());
            dedupApp.use('/api/plugins/st-git-improve', createRouter({
                dirs: sandbox,
                selfPluginDir: sandbox.selfPluginDir,
                tavernRoot: root,
                store: new CredentialStore(path.join(root, 'data', 'default-user', 'git-improve', 'credentials.json')),
                registry: 'https://registry.npmmirror.com',
                identity,
            }));
            return new Promise(resolve => {
                const s = dedupApp.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}/api/plugins/st-git-improve`));
            });
        };

        // non-admin: force forbidden, dedup still blocks
        const userApi = await makeApi(false, null);
        const whoami = await (await fetch(`${userApi}/whoami`)).json();
        expect(whoami.mode === 'host' && whoami.canForce === false, 'whoami: non-admin cannot force in host mode');
        const forbiddenForce = await fetch(`${userApi}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: repoUrl, target: 'extension', replace: true, force: true }),
        });
        assert.equal(forbiddenForce.status, 403);
        expect(forbiddenForce.status === 403, 'non-admin force install rejected with 403');

        const userBlocked = await fetch(`${userApi}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: repoUrl, target: 'extension' }),
        });
        assert.equal(userBlocked.status, 409);
        expect(userBlocked.status === 409, 'non-admin normal install still dedup-blocked');

        // admin: force allowed; auto-dedup removes clean duplicate
        const adminApi = await makeApi(true, null);
        const adminInstall = await fetch(`${adminApi}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: repoUrl, target: 'extension', force: true, replace: true }),
        });
        assert.equal(adminInstall.status, 200, await adminInstall.text());
        expect(adminInstall.status === 200, 'admin force install allowed');

        const auto1 = await (await fetch(`${adminApi}/dedup/auto`, { method: 'POST' })).json();
        expect(auto1.removed.includes('hello'), 'auto-dedup removes clean duplicate');

        // dirty duplicate → skipped by auto-dedup
        const reinstall = await fetch(`${adminApi}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: repoUrl, target: 'extension', force: true }),
        });
        assert.equal(reinstall.status, 200);
        fs.writeFileSync(path.join(sandbox.localExtensionsDir, 'hello', 'README'), 'dirty again\n');
        const auto2 = await (await fetch(`${adminApi}/dedup/auto`, { method: 'POST' })).json();
        expect(auto2.skipped.some(s => s.name === 'hello' && s.dirtyCount > 0), 'auto-dedup skips dirty duplicate');
        expect(fs.existsSync(path.join(sandbox.localExtensionsDir, 'hello')), 'dirty duplicate survives auto-dedup');

        // per-user directories: install lands in the user's own extensions dir
        const userExtDir = path.join(root, 'data', 'user1', 'extensions');
        const adminWithUserDirs = await makeApi(true, userExtDir);
        const perUser = await fetch(`${adminWithUserDirs}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: repoUrl, target: 'extension', force: true }),
        });
        assert.equal(perUser.status, 200, await perUser.text());
        expect(fs.existsSync(path.join(userExtDir, 'hello', 'manifest.json')), 'per-user directories respected');
    }

    console.log('\nE2E ALL PASS ✔');
    exitCode = 0;
} catch (error) {
    console.error('\nE2E FAILED:', error?.message || error);
    exitCode = 1;
} finally {
    close();
    proxy.close();
    try {
        httpServer.close();
    } catch { /* best effort */ }
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* best effort */ }
}
// keep-alive sockets to the fixture servers would keep the process alive
process.exit(exitCode);