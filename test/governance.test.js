import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    disableExtension,
    enableExtension,
    listGovernance,
    purgeParked,
    SELF_PANEL_NAME,
} from '../plugin/ops/governance.js';

const DEMO_MANIFEST = JSON.stringify({ display_name: 'Demo', version: '1.2.3' });
const DEMO_CODE = '// demo code';
const DEMO_STATE = '{"kept":true}';

/**
 * Fixture: a fake tavern data root with local/global/plugin extension dirs
 * and one installed local extension. All dirs are plain (non-git), so
 * dirtyCount resolves to -1 like a real imported extension would.
 */
function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-gov-'));
    const dataUser = path.join(root, 'data', 'default-user');
    const dirs = {
        localExtensionsDir: path.join(dataUser, 'extensions'),
        globalExtensionsDir: path.join(root, 'data', 'extensions', 'third-party'),
        pluginsDir: path.join(root, 'plugins'),
        selfPluginDir: path.join(root, 'plugins', 'st-git-improve'),
    };
    for (const dir of Object.values(dirs)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.mkdirSync(path.join(dirs.localExtensionsDir, 'demo-ext', 'data'), { recursive: true });
    fs.writeFileSync(path.join(dirs.localExtensionsDir, 'demo-ext', 'manifest.json'), DEMO_MANIFEST);
    fs.writeFileSync(path.join(dirs.localExtensionsDir, 'demo-ext', 'index.js'), DEMO_CODE);
    fs.writeFileSync(path.join(dirs.localExtensionsDir, 'demo-ext', 'data', 'state.json'), DEMO_STATE);
    return { root, dirs };
}

describe('governance', () => {
    let fixture;

    beforeEach(() => {
        fixture = makeFixture();
    });

    afterEach(() => {
        fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
    });

    it('listGovernance reports all scopes, sizes and totals', async () => {
        const { dirs } = fixture;
        fs.mkdirSync(path.join(dirs.globalExtensionsDir, 'global-ext'), { recursive: true });
        fs.writeFileSync(path.join(dirs.globalExtensionsDir, 'global-ext', 'manifest.json'), '{"version":"0.1.0"}');
        fs.mkdirSync(path.join(dirs.pluginsDir, 'some-plugin'), { recursive: true });
        fs.writeFileSync(path.join(dirs.pluginsDir, 'some-plugin', 'index.js'), '// plugin');
        fs.writeFileSync(path.join(dirs.selfPluginDir, 'index.js'), '// self');
        const overview = await listGovernance({ dirs });
        const byScope = Object.groupBy(overview.entries, entry => entry.scope);
        assert.deepEqual(byScope.local.map(entry => entry.name), ['demo-ext']);
        assert.deepEqual(byScope.global.map(entry => entry.name), ['global-ext']);
        assert.deepEqual(byScope.plugin.map(entry => entry.name), ['some-plugin'], 'self plugin dir is excluded');
        const demo = overview.entries.find(entry => entry.name === 'demo-ext');
        assert.equal(demo.bytes, Buffer.byteLength(DEMO_MANIFEST) + Buffer.byteLength(DEMO_CODE) + Buffer.byteLength(DEMO_STATE));
        assert.equal(demo.isRepo, false);
        assert.equal(demo.dirtyCount, -1);
        assert.ok(overview.totals.localBytes > 0);
        assert.equal(overview.totals.parkedBytes, 0);
        assert.ok(overview.parkedDir.endsWith('extensions-disabled'));
    });

    it('disable moves the whole dir (data included) into parking + ledger entry', async () => {
        const { dirs } = fixture;
        const result = disableExtension({ name: 'demo-ext', dirs });
        assert.equal(result.name, 'demo-ext');
        assert.ok(fs.existsSync(path.join(result.parkedDir, 'manifest.json')));
        assert.ok(fs.existsSync(path.join(result.parkedDir, 'data', 'state.json')), 'extension data travels with the dir');
        assert.equal(fs.existsSync(path.join(dirs.localExtensionsDir, 'demo-ext')), false);
        const overview = await listGovernance({ dirs });
        const parked = overview.entries.find(entry => entry.scope === 'parked');
        assert.equal(parked.name, 'demo-ext');
        assert.equal(parked.version, '1.2.3');
        assert.ok(parked.parkedAt, 'ledger recorded disable time');
        assert.equal(overview.totals.parkedBytes, result.bytes);
        const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(dirs.localExtensionsDir), 'git-improve', 'governance.json'), 'utf8'));
        assert.equal(ledger.actions.at(-1).action, 'disable');
        assert.equal(ledger.actions.at(-1).name, 'demo-ext');
    });

    it('enable moves a parked copy back intact', async () => {
        const { dirs } = fixture;
        disableExtension({ name: 'demo-ext', dirs });
        const result = enableExtension({ name: 'demo-ext', dirs });
        assert.equal(result.name, 'demo-ext');
        const restored = path.join(dirs.localExtensionsDir, 'demo-ext');
        assert.equal(JSON.parse(fs.readFileSync(path.join(restored, 'manifest.json'), 'utf8')).version, '1.2.3');
        assert.equal(JSON.parse(fs.readFileSync(path.join(restored, 'data', 'state.json'), 'utf8')).kept, true);
        assert.equal(fs.existsSync(path.join(path.dirname(dirs.localExtensionsDir), 'extensions-disabled', 'demo-ext')), false);
    });

    it('disable/enable reject bad input: self panel, missing dirs, name conflicts', () => {
        const { dirs } = fixture;
        assert.throws(() => disableExtension({ name: SELF_PANEL_NAME, dirs }), /管理面板/);
        assert.throws(() => disableExtension({ name: 'nope', dirs }), /不存在/);
        assert.throws(() => enableExtension({ name: 'nope', dirs }), /停用区/);
        disableExtension({ name: 'demo-ext', dirs });
        assert.throws(() => disableExtension({ name: 'demo-ext', dirs }), /不存在/);
        // conflict: enable while an identical local name exists
        fs.mkdirSync(path.join(dirs.localExtensionsDir, 'demo-ext'), { recursive: true });
        assert.throws(() => enableExtension({ name: 'demo-ext', dirs }), /同名/);
    });

    it('name sanitization never escapes the parking area', () => {
        const { root, dirs } = fixture;
        assert.throws(() => disableExtension({ name: '..', dirs }), /无效的扩展名/);
        assert.throws(() => purgeParked({ name: '..', confirm: true, dirs }), /无效的扩展名/);
        // separators become '_', so '../escape' is just a missing sibling name → 404, nothing written outside
        assert.throws(() => disableExtension({ name: '../escape', dirs }), /不存在/);
        assert.equal(fs.existsSync(path.join(root, 'escape')), false);
        assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false);
        assert.throws(() => enableExtension({ name: 'a/b', dirs }), /停用区/);
    });

    it('purge requires confirm, frees space and records the ledger', () => {
        const { dirs } = fixture;
        const parked = disableExtension({ name: 'demo-ext', dirs });
        assert.throws(() => purgeParked({ name: 'demo-ext', confirm: false, dirs }), /confirm/);
        const result = purgeParked({ name: 'demo-ext', confirm: true, dirs });
        assert.equal(result.freedBytes, parked.bytes);
        assert.equal(fs.existsSync(parked.parkedDir), false);
        const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(dirs.localExtensionsDir), 'git-improve', 'governance.json'), 'utf8'));
        assert.equal(ledger.actions.length, 2);
        assert.equal(ledger.actions.at(-1).action, 'purge');
        assert.equal(ledger.actions.at(-1).bytes, parked.bytes);
    });

    it('purge refuses to touch a live (non-parked) extension', () => {
        const { dirs } = fixture;
        assert.throws(() => purgeParked({ name: 'demo-ext', confirm: true, dirs }), /停用区没有该副本/);
        assert.equal(fs.existsSync(path.join(dirs.localExtensionsDir, 'demo-ext')), true);
    });

    it('ledger is capped at 200 actions', () => {
        const { dirs } = fixture;
        const ledgerFile = path.join(path.dirname(dirs.localExtensionsDir), 'git-improve', 'governance.json');
        const actions = Array.from({ length: 260 }, (_, i) => ({ ts: 't', action: 'disable', name: `x${i}`, version: '', bytes: 0 }));
        fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
        fs.writeFileSync(ledgerFile, JSON.stringify({ actions }));
        disableExtension({ name: 'demo-ext', dirs });
        const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
        assert.equal(ledger.actions.length, 200);
        assert.equal(ledger.actions.at(-1).name, 'demo-ext');
    });
});
