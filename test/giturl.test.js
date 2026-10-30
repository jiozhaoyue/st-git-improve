// giturl 纯逻辑单测：通道分类 + 按模式的提示文案（与引擎 isSystemGitUrl 同规则镜像）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSystemGitUrl, classifyUrl, channelHint } from '../extension/src/core/giturl.js';

describe('giturl: isSystemGitUrl（与引擎判定同规则）', () => {
    it('识别 ssh/scp/git/file 形态', () => {
        assert.equal(isSystemGitUrl('git@github.com:a/b.git'), true);
        assert.equal(isSystemGitUrl('ssh://git@host/path'), true);
        assert.equal(isSystemGitUrl('file:///tmp/repo'), true);
        assert.equal(isSystemGitUrl('git://host/repo'), true);
    });

    it('放过 http(s) 与用户信息嵌在 http(s) 的形态', () => {
        assert.equal(isSystemGitUrl('https://github.com/a/b'), false);
        assert.equal(isSystemGitUrl('http://localhost/x'), false);
        assert.equal(isSystemGitUrl('https://user:token@github.com/a/b.git'), false);
    });

    it('空白与空串不算系统 git', () => {
        assert.equal(isSystemGitUrl(''), false);
        assert.equal(isSystemGitUrl('   '), false);
        assert.equal(isSystemGitUrl(undefined), false);
    });
});

describe('giturl: classifyUrl', () => {
    it('ssh/scp/file/git → system 通道', () => {
        assert.equal(classifyUrl('git@github.com:a/b.git').channel, 'system');
        assert.equal(classifyUrl('git@github.com:a/b.git').proto, 'ssh');
        assert.equal(classifyUrl('ssh://git@host/path').channel, 'system');
        assert.equal(classifyUrl('file:///d/repos/demo').channel, 'system');
        assert.equal(classifyUrl('git://host/repo').channel, 'system');
    });

    it('http(s) → browser 通道；未知 → unknown', () => {
        assert.equal(classifyUrl('https://github.com/a/b').channel, 'browser');
        assert.equal(classifyUrl('https://github.com/a/b').proto, 'https');
        assert.equal(classifyUrl('http://192.168.1.10:3000/repo.git').proto, 'http');
        assert.equal(classifyUrl('ftp://x/y').channel, 'unknown');
        assert.equal(classifyUrl('').installable, false);
    });
});

describe('giturl: channelHint（按运行模式合成安装页提示）', () => {
    it('空地址返回空提示', () => {
        assert.equal(channelHint('', { mode: 'pure' }).text, '');
    });

    it('纯前端 + SSH → error 级', () => {
        const hint = channelHint('git@github.com:a/b.git', { mode: 'pure' });
        assert.equal(hint.level, 'error');
        assert.match(hint.text, /纯前端模式不可用/);
    });

    it('服务端 + SSH + 系统 git 可用 → ok 级', () => {
        const hint = channelHint('git@github.com:a/b.git', { mode: 'server', systemGitAvailable: true });
        assert.equal(hint.level, 'ok');
        assert.match(hint.text, /系统 git 通道/);
    });

    it('服务端 + SSH + 系统 git 不可用 → error 级', () => {
        const hint = channelHint('ssh://git@host/path', { mode: 'server', systemGitAvailable: false });
        assert.equal(hint.level, 'error');
        assert.match(hint.text, /未检测到可用的系统 git/);
    });

    it('服务端 + SSH + 探测未知（undefined）→ info 级不误报', () => {
        const hint = channelHint('file:///d/x', { mode: 'server', systemGitAvailable: undefined });
        assert.equal(hint.level, 'info');
    });

    it('http(s)：纯前端与服务端都给 ok 级通道说明', () => {
        assert.equal(channelHint('https://github.com/a/b', { mode: 'pure' }).level, 'ok');
        assert.equal(channelHint('https://github.com/a/b', { mode: 'server' }).level, 'ok');
        assert.match(channelHint('https://github.com/a/b', { mode: 'pure' }).text, /浏览器内克隆/);
        assert.match(channelHint('https://github.com/a/b', { mode: 'server' }).text, /服务端插件通道/);
    });

    it('未知地址 → warn 级', () => {
        const hint = channelHint('ftp://x/y', { mode: 'server' });
        assert.equal(hint.level, 'warn');
    });
});
