import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeRepoUrl,
    dirNameFromUrl,
    redactUrl,
    sanitizeDirName,
    validateTreePaths,
    atomicWriteJson,
    readJsonOr,
} from '../plugin/util.js';

describe('normalizeRepoUrl', () => {
    it('strips web UI paths', () => {
        assert.equal(
            normalizeRepoUrl('https://github.com/user/repo/blob/main/index.js'),
            'https://github.com/user/repo');
        assert.equal(
            normalizeRepoUrl('https://gitea.example.com/user/repo/src/branch/main/foo'),
            'https://gitea.example.com/user/repo');
    });

    it('strips query and fragment, keeps .git suffix', () => {
        assert.equal(
            normalizeRepoUrl('https://github.com/user/repo.git?foo=bar#frag'),
            'https://github.com/user/repo.git');
    });

    it('keeps nested group paths (gitlab)', () => {
        assert.equal(
            normalizeRepoUrl('https://gitlab.com/group/sub/repo/-/tree/main'),
            'https://gitlab.com/group/sub/repo');
    });
});

describe('dirNameFromUrl', () => {
    it('uses last segment without .git', () => {
        assert.equal(dirNameFromUrl('https://github.com/user/My-Extension.git'), 'My-Extension');
        assert.equal(dirNameFromUrl('https://github.com/user/repo'), 'repo');
    });

    it('sanitizes hostile names', () => {
        assert.equal(dirNameFromUrl('https://host/a/bad..name'), 'bad..name');
        // percent-encoded separators stay encoded -> literal, traversal-safe name
        assert.equal(dirNameFromUrl('https://host/a/..%2F..%2Fetc'), '..%2F..%2Fetc');
    });
});

describe('redactUrl', () => {
    it('masks userinfo and drops query', () => {
        const out = redactUrl('https://user:secretToken@host/path/to.git?private=1');
        assert.ok(!out.includes('secretToken'), out);
        assert.ok(out.startsWith('https://***@host/path/to.git'), out);
    });

    it('leaves clean urls alone', () => {
        assert.equal(redactUrl('https://github.com/u/r.git'), 'https://github.com/u/r.git');
    });

    it('fallback regex for unparsable input', () => {
        assert.ok(!redactUrl('https://user:pass@bad url').includes('pass'));
    });
});

describe('sanitizeDirName', () => {
    it('allows common chars', () => {
        assert.equal(sanitizeDirName('a-b_c v1.2'), 'a-b_c v1.2');
    });

    it('neutralizes separators and traversal', () => {
        assert.equal(sanitizeDirName('../../etc'), '.._.._etc');
        assert.equal(sanitizeDirName('..'), '');
        assert.equal(sanitizeDirName('.'), '');
        assert.equal(sanitizeDirName('a/b\\c'), 'a_b_c');
    });
});

describe('validateTreePaths', () => {
    it('accepts normal trees', () => {
        const result = validateTreePaths(['manifest.json', 'index.js', 'assets/a.png']);
        assert.equal(result.ok, true, result.issues.join(';'));
    });

    it('rejects traversal and control chars', () => {
        assert.equal(validateTreePaths(['../escape']).ok, false);
        assert.equal(validateTreePaths(['a\u0000b']).ok, false);
    });

    it('rejects NFC collisions', () => {
        const nfd = 'cafe\u0301';
        const nfc = 'caf\u00e9';
        const result = validateTreePaths([nfd, nfc]);
        assert.equal(result.ok, false);
    });
});

describe('atomicWriteJson / readJsonOr', () => {
    it('round-trips and tolerates missing files', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const dir = await mkdtemp(join(tmpdir(), 'stgi-'));
        try {
            const file = join(dir, 'nested', 'data.json');
            atomicWriteJson(file, { a: 1 });
            assert.deepEqual(readJsonOr(file, null), { a: 1 });
            assert.equal(readJsonOr(join(dir, 'missing.json'), { fallback: true }).fallback, true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
