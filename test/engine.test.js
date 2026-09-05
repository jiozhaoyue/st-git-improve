import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as git from 'isomorphic-git';
import * as engine from '../plugin/git/engine.js';
import { depsMissing } from '../plugin/ops/deps.js';

const AUTHOR = { name: 'test', email: 'test@local' };

/** isomorphic-git writes read-only loose objects; make the tree removable. */
function rmRfSafe(dir) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                rmRfSafe(child);
            } else {
                fs.chmodSync(child, 0o666);
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
}

async function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-eng-'));
    await git.init({ fs, dir, defaultBranch: 'main' });
    return dir;
}

describe('git engine (local repo operations)', () => {
    it('backupDirtyWorktree backs up tracked changes and restores clean worktree', async () => {
        const dir = await makeRepo();
        try {
            const file = path.join(dir, 'a.txt');
            fs.writeFileSync(file, 'v1 original content');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'init', author: AUTHOR });

            // dirty: modify tracked file with different length
            fs.writeFileSync(file, 'v1 original content PLUS substantial local modification');

            const backupRef = await engine.backupDirtyWorktree({ dir });
            assert.ok(backupRef, 'expected a backup ref');
            assert.ok(backupRef.startsWith('refs/git-improve/backup/'));

            // worktree restored to HEAD
            assert.equal(fs.readFileSync(file, 'utf8'), 'v1 original content');

            // backup ref resolves to a commit whose tree has the modified content
            const backups = await engine.listBackupRefs({ dir });
            assert.equal(backups.length, 1);
            const blob = await git.readBlob({ fs, dir, oid: backups[0].oid, filepath: 'a.txt' });
            assert.equal(new TextDecoder().decode(blob.blob).includes('PLUS substantial'), true);
        } finally {
            rmRfSafe(dir);
        }
    });

    it('backupDirtyWorktree returns null when clean', async () => {
        const dir = await makeRepo();
        try {
            fs.writeFileSync(path.join(dir, 'a.txt'), 'content');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'init', author: AUTHOR });
            assert.equal(await engine.backupDirtyWorktree({ dir }), null);
        } finally {
            rmRfSafe(dir);
        }
    });

    it('advanceAndCheckout rebuilds tracked files and moves the branch', async () => {
        const dir = await makeRepo();
        try {
            const file = path.join(dir, 'a.txt');
            fs.writeFileSync(file, 'old');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'old', author: AUTHOR });
            const oldOid = await engine.resolveHead({ dir });

            // simulate a candidate on a temp branch
            fs.writeFileSync(file, 'new content from remote');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'new', author: AUTHOR, ref: 'refs/heads/tmp-candidate' });
            const candidateOid = await git.resolveRef({ fs, dir, ref: 'refs/heads/tmp-candidate' });

            // local dirty change must NOT block rebuild (TT semantics)
            fs.writeFileSync(file, 'dirty local state');

            await engine.advanceAndCheckout({ dir, branch: 'main', oid: candidateOid });
            assert.equal(fs.readFileSync(file, 'utf8'), 'new content from remote');
            assert.equal(await git.resolveRef({ fs, dir, ref: 'refs/heads/main' }), candidateOid);
            assert.equal(await engine.currentBranch({ dir }), 'main');
            assert.notEqual(candidateOid, oldOid);
        } finally {
            rmRfSafe(dir);
        }
    });

    it('restoreBackup rolls the worktree back to the backup point', async () => {
        const dir = await makeRepo();
        try {
            const file = path.join(dir, 'a.txt');
            fs.writeFileSync(file, 'base');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'base', author: AUTHOR });

            fs.writeFileSync(file, 'base with local edits that took real effort');
            const backupRef = await engine.backupDirtyWorktree({ dir });
            assert.ok(backupRef);

            // move forward
            fs.writeFileSync(file, 'upstream version');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.commit({ fs, dir, message: 'upstream', author: AUTHOR });

            await engine.restoreBackup({ dir, backupRef });
            assert.ok(fs.readFileSync(file, 'utf8').includes('local edits'));
        } finally {
            rmRfSafe(dir);
        }
    });

    it('dirtyTrackedFiles and listFiles behave', async () => {
        const dir = await makeRepo();
        try {
            fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
            fs.mkdirSync(path.join(dir, 'sub'));
            fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'y');
            await git.add({ fs, dir, filepath: 'a.txt' });
            await git.add({ fs, dir, filepath: 'sub/b.txt' });
            await git.commit({ fs, dir, message: 'init', author: AUTHOR });

            assert.deepEqual(await engine.dirtyTrackedFiles({ dir }), []);
            const files = await engine.listFiles({ dir });
            assert.ok(files.includes('a.txt') && files.includes('sub/b.txt'));

            fs.writeFileSync(path.join(dir, 'a.txt'), 'xxxxxxxxxxxxxxx');
            assert.deepEqual(await engine.dirtyTrackedFiles({ dir }), ['a.txt']);
        } finally {
            rmRfSafe(dir);
        }
    });
});

describe('depsMissing', () => {
    it('detects missing node_modules and missing scoped packages', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const dir = await mkdtemp(path.join(os.tmpdir(), 'stgi-deps-'));
        try {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4' } }));
            assert.equal(depsMissing(dir), true);

            fs.mkdirSync(path.join(dir, 'node_modules', 'lodash'), { recursive: true });
            assert.equal(depsMissing(dir), false);

            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@scope/pkg': '^1' } }));
            assert.equal(depsMissing(dir), true);

            fs.mkdirSync(path.join(dir, 'node_modules', '@scope', 'pkg'), { recursive: true });
            assert.equal(depsMissing(dir), false);

            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            assert.equal(depsMissing(dir), false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
