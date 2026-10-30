// SSH/file 桥（系统 git 通道）单测：本地裸仓 + file:// 全流程，无网络依赖。
// 前提：测试环境 PATH 中有系统 git（缺失则整组跳过）。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as engine from '../plugin/git/engine.js';
import { normalizeRepoUrl, dirNameFromUrl } from '../plugin/util.js';
import { updateRepo } from '../plugin/ops/update.js';
import { invalidateGovernanceCache } from '../plugin/ops/governance.js';

const GIT_ARGS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function g(args, cwd) {
    return execFileSync('git', GIT_ARGS.concat(args), { cwd, encoding: 'utf8' }).trim();
}

function hasSystemGit() {
    try {
        execFileSync('git', ['--version']);
        return true;
    } catch {
        return false;
    }
}

const MANIFEST_V1 = JSON.stringify({ display_name: 'Ssh Bridge Demo', version: '1.0.0' });
const MANIFEST_V2 = JSON.stringify({ display_name: 'Ssh Bridge Demo', version: '1.1.0' });

describe('ssh/file bridge (system git channel)', () => {
    let fixture;

    beforeEach(() => {
        if (!hasSystemGit()) {
            return;
        }
        fixture = {};
        fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-ssh-'));
        // 源仓库（普通仓库）+ 裸仓（模拟远端）
        fixture.source = path.join(fixture.root, 'source');
        fixture.bare = path.join(fixture.root, 'remote.git');
        fs.mkdirSync(fixture.source, { recursive: true });
        g(['init', '--initial-branch=main'], fixture.source);
        fs.writeFileSync(path.join(fixture.source, 'manifest.json'), MANIFEST_V1);
        fs.writeFileSync(path.join(fixture.source, 'index.js'), '// v1');
        g(['add', '.'], fixture.source);
        g(['commit', '-m', 'v1'], fixture.source);
        g(['clone', '--bare', fixture.source, fixture.bare]);
        g(['symbolic-ref', 'HEAD', 'refs/heads/main'], fixture.bare);
        fixture.installDir = path.join(fixture.root, 'data', 'default-user', 'extensions', 'ssh-demo');
        fs.mkdirSync(path.dirname(fixture.installDir), { recursive: true });
    });

    afterEach(() => {
        if (fixture?.root) {
            fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
        }
    });

    it('isSystemGitUrl 识别 ssh/scp/git/file 并放过 http(s)', () => {
        assert.equal(engine.isSystemGitUrl('git@github.com:a/b.git'), true);
        assert.equal(engine.isSystemGitUrl('ssh://git@host/path'), true);
        assert.equal(engine.isSystemGitUrl('file:///tmp/repo'), true);
        assert.equal(engine.isSystemGitUrl('git://host/repo'), true);
        assert.equal(engine.isSystemGitUrl('https://github.com/a/b'), false);
        assert.equal(engine.isSystemGitUrl('http://localhost/x'), false);
    });

    it('systemGitAvailable 与 systemGitVersion 探测一致（有 git 时版本串非空）', () => {
        const available = engine.systemGitAvailable();
        const version = engine.systemGitVersion();
        assert.equal(typeof version, 'string');
        if (available) {
            assert.match(version, /^git version/i);
        } else {
            assert.equal(version, '');
        }
    });

    it('normalizeRepoUrl 把 scp 语法规范化为 ssh:// 且目录名正确', () => {
        const normalized = normalizeRepoUrl('git@github.com:user/repo.git');
        assert.equal(normalized, 'ssh://git@github.com/user/repo.git');
        assert.equal(dirNameFromUrl(normalized), 'repo');
        // http 形式不受影响
        assert.equal(normalizeRepoUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
    });

    it('engine.clone 经系统 git 完成 file:// 安装', async () => {
        const url = `file://${fixture.bare.replace(/\\/g, '/')}`;
        await engine.clone({ url, dir: fixture.installDir, branch: 'main' });
        assert.equal(fs.readFileSync(path.join(fixture.installDir, 'manifest.json'), 'utf8'), MANIFEST_V1);
        assert.equal(fs.existsSync(path.join(fixture.installDir, '.git')), true);
    });

    it('updateRepo 对 file:// 远端完成重建式更新（备份+前进）', async () => {
        const url = `file://${fixture.bare.replace(/\\/g, '/')}`;
        await engine.clone({ url, dir: fixture.installDir, branch: 'main' });
        // 远端前进一个提交
        fs.writeFileSync(path.join(fixture.source, 'manifest.json'), MANIFEST_V2);
        fs.writeFileSync(path.join(fixture.source, 'index.js'), '// v2');
        g(['add', '.'], fixture.source);
        g(['commit', '-m', 'v2'], fixture.source);
        g(['push', fixture.bare, 'main'], fixture.source);
        invalidateGovernanceCache();

        const result = await updateRepo({ dir: fixture.installDir, runDeps: false, log: () => {} });
        assert.equal(result.upToDate, false);
        assert.equal(fs.readFileSync(path.join(fixture.installDir, 'manifest.json'), 'utf8'), MANIFEST_V2);
        assert.equal(fs.readFileSync(path.join(fixture.installDir, 'index.js'), 'utf8'), '// v2');
    });

    it('updateRepo 干净仓库无新提交时报告已是最新', async () => {
        const url = `file://${fixture.bare.replace(/\\/g, '/')}`;
        await engine.clone({ url, dir: fixture.installDir, branch: 'main' });
        const result = await updateRepo({ dir: fixture.installDir, runDeps: false, log: () => {} });
        assert.equal(result.upToDate, true);
    });
});
