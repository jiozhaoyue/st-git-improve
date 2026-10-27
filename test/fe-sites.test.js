// 纯前端站点适配器单测（URL 归一化 / 类型识别 / 仓库解析 / 站点 key / userinfo 提取）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeBaseUrl,
    detectTypeForHost,
    parseRepoUrl,
    siteKeyOf,
    extractUserinfo,
    defaultBaseUrl,
    getAdapter,
    adapters,
} from '../extension/src/core/sites.js';

test('normalizeBaseUrl：去尾斜杠、保留路径、拒绝非 http 协议', () => {
    assert.equal(normalizeBaseUrl('https://git.example.com/'), 'https://git.example.com');
    assert.equal(normalizeBaseUrl('https://git.example.com/gitea//'), 'https://git.example.com/gitea');
    assert.throws(() => normalizeBaseUrl('ftp://x'), /http\/https/);
    assert.throws(() => normalizeBaseUrl(''), /为空|合法/);
    assert.throws(() => normalizeBaseUrl('not a url'), /合法/);
});

test('detectTypeForHost：主流站点与子域名', () => {
    assert.equal(detectTypeForHost('github.com'), 'github');
    assert.equal(detectTypeForHost('gist.github.com'), 'github');
    assert.equal(detectTypeForHost('gitlab.com'), 'gitlab');
    assert.equal(detectTypeForHost('gitee.com'), 'gitee');
    assert.equal(detectTypeForHost('git.example.com'), '');
});

test('parseRepoUrl：https / .git 后缀 / 内嵌凭据 / 子路径', () => {
    const basic = parseRepoUrl('https://github.com/octocat/Hello-World');
    assert.equal(basic.owner, 'octocat');
    assert.equal(basic.repo, 'Hello-World');
    assert.equal(basic.type, 'github');
    assert.equal(basic.httpsUrl, 'https://github.com/octocat/Hello-World.git');

    const withGit = parseRepoUrl('https://git.example.com/group/repo.git');
    assert.equal(withGit.repo, 'repo');
    assert.equal(withGit.host, 'git.example.com');

    const withAuth = parseRepoUrl('https://user:token@github.com/a/b.git');
    assert.equal(withAuth.owner, 'a');
    assert.equal(withAuth.httpsUrl, 'https://github.com/a/b.git');
});

test('parseRepoUrl：拒绝非 http 与缺 owner/repo', () => {
    assert.throws(() => parseRepoUrl('git@github.com:a/b.git'), /http\/https/);
    assert.throws(() => parseRepoUrl('https://github.com/only-owner'), /owner\/repo/);
    assert.throws(() => parseRepoUrl('not-a-url'), /http\/https/);
});

test('siteKeyOf：同站点大小写无关、自建走 baseUrl、默认站点', () => {
    assert.equal(siteKeyOf('github', ''), siteKeyOf('github', 'https://github.com'));
    assert.equal(siteKeyOf('github', 'https://GitHub.com'), siteKeyOf('github', 'https://github.com'));
    const selfA = siteKeyOf('gitea', 'https://Git.Example.com/gitea');
    const selfB = siteKeyOf('gitea', 'https://git.example.com/gitea');
    assert.equal(selfA, selfB);
    assert.equal(defaultBaseUrl('gitea'), '');
    assert.equal(defaultBaseUrl('github'), 'https://github.com');
});

test('getAdapter：未知类型抛错；四类适配器齐备', () => {
    assert.throws(() => getAdapter('sourcehut'), /未知站点类型/);
    for (const id of ['github', 'gitlab', 'gitea', 'gitee']) {
        const adapter = getAdapter(id);
        assert.equal(typeof adapter.testCredential, 'function');
    }
    assert.equal(adapters.gitea.requiresBaseUrl, true);
    assert.equal(adapters.github.requiresBaseUrl, false);
});

test('extractUserinfo：提取 user/token 并识别类型；无凭据返回 null', () => {
    const extracted = extractUserinfo('https://octocat:ghp_abc@github.com/octocat/repo.git');
    assert.equal(extracted.username, 'octocat');
    assert.equal(extracted.token, 'ghp_abc');
    assert.equal(extracted.type, 'github');
    assert.equal(extracted.baseUrl, 'https://github.com');
    assert.equal(extractUserinfo('https://github.com/octocat/repo.git'), null);
    assert.equal(extractUserinfo('nonsense'), null);
});
