// conflict 分类器单测：真实 git 错误文本形态（宿主 /api/extensions/update 失败响应体同源）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGitError, kinds } from '../extension/src/core/conflict.js';

describe('conflict: classifyGitError（未跟踪文件挡道更新——2026-11-07 实测场景）', () => {
    it('merge 形态：头行 + TAB 清单 + Please move + Aborting → untracked-conflict 且逐条列出文件', () => {
        const text = [
            'From https://git.example.com/foo/bar',
            '   1a2b3c4..5d6e7f8  main       -> origin/main',
            'error: The following untracked working tree files would be overwritten by merge:',
            '\tindex.js',
            '\tsrc/core/util.js',
            '\tdist/bundle.css',
            'Please move or remove them before you merge.',
            'Aborting',
        ].join('\n');
        const result = classifyGitError(text);
        assert.equal(result.kind, kinds.UNTRACKED_CONFLICT);
        assert.deepEqual(result.files, ['index.js', 'src/core/util.js', 'dist/bundle.css']);
        assert.match(result.header, /untracked working tree files/);
    });

    it('checkout 形态与带引号路径：解引后仍逐条可读', () => {
        const text = [
            'error: The following untracked working tree files would be overwritten by checkout:',
            '\t"含中文 目录/文件.txt"',
            '\tvendor/lib.js',
            'Please move or remove them before you switch branches.',
            'Aborting',
        ].join('\n');
        const result = classifyGitError(text);
        assert.equal(result.kind, kinds.UNTRACKED_CONFLICT);
        assert.equal(result.files.length, 2);
        assert.equal(result.files[0], '含中文 目录/文件.txt');
    });

    it('两类清单头并列出现：未跟踪优先，文件清单合并去重', () => {
        const text = [
            'error: Your local changes to the following files would be overwritten by merge:',
            '\ttracked.js',
            'Please commit your changes or stash them before you merge.',
            'error: The following untracked working tree files would be overwritten by merge:',
            '\tuntracked.js',
            'Please move or remove them before you merge.',
            'Aborting',
        ].join('\n');
        const result = classifyGitError(text);
        assert.equal(result.kind, kinds.UNTRACKED_CONFLICT);
        assert.deepEqual(result.files, ['tracked.js', 'untracked.js']);
    });

    it('大清单（2188 文件量级抽样）：全部列出且保持顺序去重', () => {
        const lines = ['error: The following untracked working tree files would be overwritten by merge:'];
        const expected = [];
        for (let i = 0; i < 500; i++) {
            const path = `assets/img/bg_${i}.png`;
            expected.push(path);
            lines.push(`\t${path}`);
        }
        lines.push('Please move or remove them before you merge.', 'Aborting');
        const result = classifyGitError(lines.join('\n'));
        assert.equal(result.kind, kinds.UNTRACKED_CONFLICT);
        assert.equal(result.files.length, 500);
        assert.deepEqual(result.files, expected);
    });
});

describe('conflict: classifyGitError（其余形态）', () => {
    it('本地改动冲突（无未跟踪文件）→ local-changes + 文件清单', () => {
        const text = [
            'error: Your local changes to the following files would be overwritten by merge:',
            '\tstyle.css',
            'Please commit your changes or stash them before you merge.',
            'Aborting',
        ].join('\n');
        const result = classifyGitError(text);
        assert.equal(result.kind, kinds.LOCAL_CHANGES);
        assert.deepEqual(result.files, ['style.css']);
    });

    it('仅一句提示语（无清单头行）也能归类', () => {
        assert.equal(classifyGitError('error: untracked working tree files would be overwritten by merge').kind, kinds.UNTRACKED_CONFLICT);
        assert.equal(classifyGitError('Please move or remove them before you merge. Aborting').kind, kinds.UNTRACKED_CONFLICT);
        assert.equal(classifyGitError('Please commit your changes or stash them before you merge.').kind, kinds.LOCAL_CHANGES);
    });

    it('分叉 / 非快进 → diverged', () => {
        assert.equal(classifyGitError('fatal: Need to specify how to reconcile divergent branches.').kind, kinds.DIVERGED);
        assert.equal(classifyGitError('error: Your local changes would be overwritten. Please fetch first.').kind, kinds.DIVERGED);
        assert.equal(classifyGitError('fatal: Not possible to fast-forward, aborting.').kind, kinds.DIVERGED);
    });

    it('认证 / 网络 / 远端不可达 → network', () => {
        assert.equal(classifyGitError('fatal: Authentication failed for \'https://github.com/a/b\'').kind, kinds.NETWORK);
        assert.equal(classifyGitError('fatal: unable to access \'https://x\': Could not resolve host: x').kind, kinds.NETWORK);
    });

    it('已知形态之外的错误 → other；空文本 → none', () => {
        assert.equal(classifyGitError('fatal: not a git repository (or any of the parent directories): .git').kind, kinds.OTHER);
        assert.equal(classifyGitError('').kind, kinds.NONE);
        assert.equal(classifyGitError(null).kind, kinds.NONE);
        assert.equal(classifyGitError('   \n  ').kind, kinds.NONE);
    });

    it('HTTP 包装文本（宿主把 git stderr 原样返回）不误判为 other', () => {
        const text = 'Error: Extension update failed\n\nerror: The following untracked working tree files would be overwritten by merge:\n\tindex.js\nPlease move or remove them before you merge.\nAborting';
        const result = classifyGitError(text);
        assert.equal(result.kind, kinds.UNTRACKED_CONFLICT);
        assert.deepEqual(result.files, ['index.js']);
    });
});

// ---------------------------------------------------------------- summarizeFileList（修复卡清单预览摘要）
import { summarizeFileList } from '../extension/src/core/conflict.js';

describe('conflict: summarizeFileList（大清单按目录聚合）', () => {
    it('小清单（≤50）平铺：lines 即逐条路径，grouped=false', () => {
        const files = ['a.js', 'src/b.css'];
        const summary = summarizeFileList(files);
        assert.equal(summary.grouped, false);
        assert.deepEqual(summary.lines, files);
        assert.equal(summary.total, 2);
    });

    it('大清单（>50）按目录聚合：统计行降序 + 目录总数（2188 文件量级形态）', () => {
        const files = [];
        for (let i = 0; i < 2188; i++) files.push(`assets/img/bg_${i}.png`);
        files.push('index.js');
        const summary = summarizeFileList(files, { flatLimit: 50, dirGroups: 12 });
        assert.equal(summary.grouped, true);
        assert.equal(summary.total, 2189);
        assert.equal(summary.dirCount, 2);
        assert.equal(summary.lines.length, 2);
        assert.match(summary.lines[0], /assets\/img —— 2188 个文件/);
        assert.match(summary.lines[1], /—— 1 个文件/);
    });

    it('超过 dirGroups 上限时只保留前 N 个目录（数量多的优先）', () => {
        const files = [];
        for (let d = 0; d < 15; d++) {
            for (let i = 0; i < (15 - d) * 10; i++) files.push(`dir_${d}/f${i}.js`);
        }
        const summary = summarizeFileList(files, { flatLimit: 50, dirGroups: 5 });
        assert.equal(summary.lines.length, 5);
        assert.match(summary.lines[0], /dir_0/);
    });

    it('根目录文件归入「(根目录)」桶', () => {
        const files = Array.from({ length: 60 }, (_, i) => `file_${i}.js`);
        const summary = summarizeFileList(files);
        assert.equal(summary.grouped, true);
        assert.match(summary.lines[0], /\(根目录\) —— 60 个文件/);
    });
});
