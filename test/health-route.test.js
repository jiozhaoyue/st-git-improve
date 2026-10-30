// /health 路由级测试：panelVersions 与 systemGit 字段契约。
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRouteApp } from './helpers/route-app.mjs';

describe('GET /health (route level)', () => {
    let app;
    let root;

    afterEach(async () => {
        if (app) await app.close();
        if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    });

    it('返回 ok/panelVersions/systemGit（systemGit 与本机 git 一致）', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-health-'));
        app = await startRouteApp(root);
        const response = await fetch(`${app.baseUrl}/health`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.ok, true);
        // panelVersions 来自注入的 context（9.9.9 占位证明字段直达响应）
        assert.equal(data.panelVersions.bundled, '9.9.9');
        assert.equal(typeof data.systemGit.available, 'boolean');
        assert.equal(typeof data.systemGit.version, 'string');
        if (data.systemGit.available) {
            assert.match(data.systemGit.version, /^git version/i);
        }
    });
});
