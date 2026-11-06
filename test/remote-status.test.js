// remote-status 纯逻辑单测：fetchRepoInfo 仓库摘要（站点 API，fetchImpl 注入无网络）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchRepoInfo, fetchBranches } from '../extension/src/core/remote-status.js';

const jsonResponse = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
});

describe('remote-status: fetchRepoInfo（安装前仓库摘要）', () => {
    it('github 仓库信息端点与归一化', async () => {
        let requestedUrl = '';
        let requestedHeaders = {};
        const fetchImpl = async (url, init = {}) => {
            requestedUrl = url;
            requestedHeaders = init.headers || {};
            return jsonResponse({
                description: 'SillyTavern 的私有源安装扩展',
                default_branch: 'main',
                pushed_at: '2026-11-06T12:00:00Z',
                stargazers_count: 7,
            });
        };
        const result = await fetchRepoInfo('https://github.com/a/b.git', { fetchImpl });
        assert.equal(result.ok, true);
        assert.equal(result.description, 'SillyTavern 的私有源安装扩展');
        assert.equal(result.defaultBranch, 'main');
        assert.equal(result.pushedAt, '2026-11-06T12:00:00Z');
        assert.equal(result.stars, 7);
        assert.match(requestedUrl, /^https:\/\/api\.github\.com\/repos\/a\/b\?*$/);
        assert.equal(requestedHeaders['User-Agent'], 'st-git-improve');
    });

    it('gitea 自建端点 + star_count 归一化', async () => {
        let requestedUrl = '';
        const fetchImpl = async url => {
            requestedUrl = url;
            return jsonResponse({ description: '自建', default_branch: 'master', updated_at: '2026-11-01T00:00:00Z', star_count: 2 });
        };
        const result = await fetchRepoInfo('https://git.example.com/a/b', { fetchImpl });
        assert.equal(result.ok, true);
        assert.equal(result.stars, 2);
        assert.equal(result.defaultBranch, 'master');
        assert.match(requestedUrl, /^https:\/\/git\.example\.com\/api\/v1\/repos\/a\/b$/);
    });

    it('gitlab 端点（URL 编码 project path）', async () => {
        let requestedUrl = '';
        const fetchImpl = async url => {
            requestedUrl = url;
            return jsonResponse({ description: 'd', default_branch: 'main', last_activity_at: '2026-11-02T00:00:00Z', star_count: 1 });
        };
        const result = await fetchRepoInfo('https://gitlab.com/group/repo', { fetchImpl });
        assert.equal(result.ok, true);
        assert.match(requestedUrl, /\/api\/v4\/projects\/group%2Frepo$/);
    });

    it('自建站点（host 无法判型）→ 探测 gitea 形态成功', async () => {
        const urls = [];
        const fetchImpl = async url => {
            urls.push(url);
            return jsonResponse({ description: '自建 gitea', default_branch: 'master', stargazers_count: 3 });
        };
        const result = await fetchRepoInfo('https://git.example.com/a/b', { fetchImpl });
        assert.equal(result.ok, true);
        assert.equal(result.stars, 3);
        assert.equal(urls.length, 1);
        assert.match(urls[0], /\/api\/v1\/repos\/a\/b$/);
    });

    it('自建站点 gitea 形态 404 → 换 gitlab 形态成功', async () => {
        const urls = [];
        const fetchImpl = async url => {
            urls.push(url);
            if (url.includes('/api/v1/')) return jsonResponse({}, 404);
            return jsonResponse({ description: '自建 gitlab', default_branch: 'main' });
        };
        const result = await fetchRepoInfo('https://git.example.com/a/b', { fetchImpl });
        assert.equal(result.ok, true);
        assert.equal(result.description, '自建 gitlab');
        assert.equal(urls.length, 2);
        assert.match(urls[1], /\/api\/v4\/projects\/a%2Fb$/);
    });

    it('自建站点两形态都 404 → notFound', async () => {
        const fetchImpl = async () => jsonResponse({}, 404);
        const result = await fetchRepoInfo('https://git.example.com/a/b', { fetchImpl });
        assert.equal(result.ok, false);
        assert.equal(result.reasonKey, 'remote.err.notFound');
    });

    it('已知 host（github）单端点失败直接上报，不做形态探测', async () => {
        let calls = 0;
        const fetchImpl = async () => { calls += 1; return jsonResponse({}, 404); };
        const result = await fetchRepoInfo('https://github.com/a/missing', { fetchImpl });
        assert.equal(result.reasonKey, 'remote.err.notFound');
        assert.equal(calls, 1);
    });

    it('非法地址 / 不支持站点 / 404 / 网络失败 → 降级 reasonKey', async () => {
        const bad = await fetchRepoInfo('git@github.com:a/b.git', { fetchImpl: async () => jsonResponse({}, 200) });
        assert.equal(bad.ok, false);
        assert.equal(bad.reasonKey, 'remote.err.badUrl');

        const scpUnsupported = await fetchRepoInfo('file:///d/x', { fetchImpl: async () => jsonResponse({}, 200) });
        assert.equal(scpUnsupported.reasonKey, 'remote.err.badUrl');

        const notFound = await fetchRepoInfo('https://github.com/a/missing', {
            fetchImpl: async () => jsonResponse({}, 404),
        });
        assert.equal(notFound.ok, false);
        assert.equal(notFound.reasonKey, 'remote.err.notFound');

        const network = await fetchRepoInfo('https://github.com/a/b', {
            fetchImpl: async () => { throw new Error('boom'); },
        });
        assert.equal(network.ok, false);
        assert.equal(network.reasonKey, 'remote.err.network');

        const badPayload = await fetchRepoInfo('https://github.com/a/b', {
            fetchImpl: async () => jsonResponse(null, 200),
        });
        assert.equal(badPayload.reasonKey, 'remote.err.badPayload');
    });
});

describe('remote-status: fetchBranches（回归护栏）', () => {
    it('公开仓分支列举归一化', async () => {
        const fetchImpl = async () => jsonResponse([{ name: 'main' }, { name: 'dev' }]);
        const result = await fetchBranches('https://github.com/a/b', { fetchImpl });
        assert.deepEqual(result.branches, ['main', 'dev']);
    });

    it('自建 gitea 分支列举（此前 host 判不出型而不可用——探测机制修复验证）', async () => {
        const fetchImpl = async () => jsonResponse([{ name: 'master' }]);
        const result = await fetchBranches('https://git.example.com/a/b', { fetchImpl });
        assert.equal(result.ok, true);
        assert.deepEqual(result.branches, ['master']);
    });
});
