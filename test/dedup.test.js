import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateDedup, dirSize, readManifest } from '../plugin/ops/dedup.js';
import { cleanStaleTempDirs } from '../plugin/ops/install.js';

describe('evaluateDedup', () => {
    const candidate = { version: '1.0.0' };

    it('no global extension → allow', () => {
        const result = evaluateDedup({ candidateManifest: candidate, globalManifest: null, granularity: 'name' });
        assert.equal(result.blocked, false);
    });

    it('name granularity: any same-name global blocks', () => {
        const result = evaluateDedup({ candidateManifest: candidate, globalManifest: { version: '9.9.9' }, granularity: 'name' });
        assert.equal(result.blocked, true);
        assert.equal(result.globalVersion, '9.9.9');
        assert.ok(result.reason.includes('全局'), result.reason);
    });

    it('name granularity: global without version still blocks, message omits version', () => {
        const result = evaluateDedup({ candidateManifest: candidate, globalManifest: {}, granularity: 'name' });
        assert.equal(result.blocked, true);
        assert.ok(!result.reason.includes('v'), result.reason);
    });

    it('name+version granularity: same version blocks', () => {
        const result = evaluateDedup({ candidateManifest: { version: '1.0.0' }, globalManifest: { version: '1.0.0' }, granularity: 'name+version' });
        assert.equal(result.blocked, true);
        assert.ok(result.reason.includes('相同版本'), result.reason);
    });

    it('name+version granularity: different version allows', () => {
        const result = evaluateDedup({ candidateManifest: { version: '2.0.0' }, globalManifest: { version: '1.0.0' }, granularity: 'name+version' });
        assert.equal(result.blocked, false);
    });

    it('name+version granularity: candidate without version allows (cannot prove same)', () => {
        const result = evaluateDedup({ candidateManifest: {}, globalManifest: { version: '1.0.0' }, granularity: 'name+version' });
        assert.equal(result.blocked, false);
    });
});

describe('readManifest / dirSize', () => {
    it('reads manifest or returns null', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-dedup-'));
        try {
            assert.equal(readManifest(dir), null);
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
            assert.equal(readManifest(dir).version, '1.2.3');
            fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
            fs.writeFileSync(path.join(dir, 'manifest2.json'), JSON.stringify({}));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        }
    });

    it('dirSize sums file bytes recursively', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-size-'));
        try {
            fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100));
            fs.mkdirSync(path.join(dir, 'sub'));
            fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), 'y'.repeat(50));
            assert.equal(dirSize(dir), 150);
            assert.equal(dirSize(path.join(dir, 'missing')), 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        }
    });
});

describe('cleanStaleTempDirs', () => {
    it('removes .tmp-stgi-* dirs, keeps everything else', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-clean-'));
        try {
            fs.mkdirSync(path.join(dir, '.tmp-stgi-hello-123'));
            fs.writeFileSync(path.join(dir, '.tmp-stgi-hello-123', 'junk'), 'x');
            fs.mkdirSync(path.join(dir, 'real-extension'));
            fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
            cleanStaleTempDirs(dir);
            assert.equal(fs.existsSync(path.join(dir, '.tmp-stgi-hello-123')), false);
            assert.equal(fs.existsSync(path.join(dir, 'real-extension')), true);
            assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
            assert.equal(fs.existsSync(dir), true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        }
    });
});
