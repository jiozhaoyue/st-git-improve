// GET /governance/ledger 路由级测试：预置台账文件 → 最新在前、只读不写。
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRouteApp } from './helpers/route-app.mjs';

function writeLedger(root, actions) {
    const dir = path.join(root, 'git-improve');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'governance.json'), JSON.stringify({ actions }));
}

describe('GET /governance/ledger (route level)', () => {
    let app;
    let root;

    afterEach(async () => {
        if (app) await app.close();
        if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    });

    it('预置记录按最新在前返回（封顶 50 条）', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-ledger-'));
        const many = Array.from({ length: 60 }, (_, i) => ({
            ts: `2026-10-31T0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}:00.000Z`,
            action: 'disable',
            name: `demo-${i}`,
            bytes: 1024,
        }));
        writeLedger(root, many);
        app = await startRouteApp(root);
        const response = await fetch(`${app.baseUrl}/governance/ledger`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.actions.length, 50);
        assert.equal(data.actions[0].name, 'demo-59'); // 最新在前
        assert.equal(data.actions[49].name, 'demo-10');
    });

    it('无台账文件 → 空列表（不报错）', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-ledger-empty-'));
        app = await startRouteApp(root);
        const response = await fetch(`${app.baseUrl}/governance/ledger`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.actions, []);
    });
});
