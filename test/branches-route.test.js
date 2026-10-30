// /branches 路由级测试：本地裸仓 + file:// 全流程（无网络）。
// 这层测试专抓「路由层漏导入/错消息」——ops/engine 单测覆盖不到。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';

import { createRouter } from '../plugin/routes.js';

const GIT_ARGS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function g(args, cwd) {
    return execFileSync('git', GIT_ARGS.concat(args), { cwd, encoding: 'utf8' }).trim();
}

describe('GET /branches (route level)', () => {
    let fixture;
    let server;
    let baseUrl;

    beforeEach(async () => {
        fixture = {};
        fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-br-'));
        fixture.source = path.join(fixture.root, 'source');
        fixture.bare = path.join(fixture.root, 'remote.git');
        fs.mkdirSync(fixture.source, { recursive: true });
        g(['init', '--initial-branch=main'], fixture.source);
        fs.writeFileSync(path.join(fixture.source, 'manifest.json'), '{"display_name":"B","version":"1.0.0"}');
        g(['add', '.'], fixture.source);
        g(['commit', '-m', 'init'], fixture.source);
        g(['clone', '--bare', fixture.source, fixture.bare]);
        g(['symbolic-ref', 'HEAD', 'refs/heads/main'], fixture.bare);

        const app = express();
        app.use('/api/plugins/st-git-improve', createRouter({
            dirs: {
                localExtensionsDir: path.join(fixture.root, 'ext'),
                globalExtensionsDir: path.join(fixture.root, 'global'),
                pluginsDir: path.join(fixture.root, 'plugins'),
                selfPluginDir: path.join(fixture.root, 'self'),
            },
            selfPluginDir: path.join(fixture.root, 'self'),
            tavernRoot: fixture.root,
            store: { authResolverForUrl: () => undefined },
            identity: { mode: 'fallback' },
            panelVersions: { bundled: '', installed: '' },
        }));
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}/api/plugins/st-git-improve`;
    });

    afterEach(() => new Promise(resolve => {
        server.close(() => resolve());
        setTimeout(() => {
            try { fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
            resolve();
        }, 500);
    }));

    it('file:// 裸仓返回分支名列表（并暴露路由层漏导入类回归）', async () => {
        const url = `${baseUrl}/branches?url=${encodeURIComponent(`file://${fixture.bare.replace(/\\/g, '/')}`)}`;
        const response = await fetch(url);
        const text = await response.text();
        assert.equal(response.status, 200, `HTTP ${response.status}: ${text}`);
        const data = JSON.parse(text);
        assert.deepEqual(data.branches, ['main']);
    });

    it('缺 url 参数 → 400', async () => {
        const response = await fetch(`${baseUrl}/branches`);
        assert.equal(response.status, 400);
    });

    it('无法解析的 URL → 400 可读错误', async () => {
        const response = await fetch(`${baseUrl}/branches?url=${encodeURIComponent('::::')}`);
        assert.equal(response.status, 400);
        const text = await response.text();
        assert.match(text, /无法解析仓库 URL/);
    });
});
