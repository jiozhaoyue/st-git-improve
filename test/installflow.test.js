// installflow 纯逻辑单测：preflightAccessible 预检分支（fetchRepoInfo 探测链复用，fetchImpl 注入）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { preflightAccessible } from '../extension/src/core/installflow.js';

const jsonResponse = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
});

describe('installflow: preflightAccessible（复用站点 API 探测链）', () => {
    it('公开仓 200 → ok:true（仓库可达）', async () => {
        const result = await preflightAccessible('https://github.com/a/b', null, {
            fetchImpl: async () => jsonResponse({ description: 'x' }),
        });
        assert.equal(result.ok, true);
        assert.match(result.note, /仓库可达/);
    });

    it('无凭据 404 → 明确提示先登录', async () => {
        const result = await preflightAccessible('https://github.com/a/missing', null, {
            fetchImpl: async () => jsonResponse({}, 404),
        });
        assert.equal(result.ok, false);
        assert.match(result.note, /私有仓库请先在「账号」页登录/);
    });

    it('有凭据 404 → 提示确认仓库地址与账号权限', async () => {
        const result = await preflightAccessible('https://github.com/a/missing', { username: 'u', password: 't' }, {
            fetchImpl: async () => jsonResponse({}, 404),
        });
        assert.equal(result.ok, false);
        assert.match(result.note, /该账号无权访问/);
    });

    it('401 → 凭据无效提示', async () => {
        const result = await preflightAccessible('https://github.com/a/b', { username: 'u', password: 'bad' }, {
            fetchImpl: async () => jsonResponse({}, 401),
        });
        assert.equal(result.ok, false);
        assert.match(result.note, /凭据无效（401）/);
    });

    it('网络失败 → 静默放行（不阻断安装）', async () => {
        const result = await preflightAccessible('https://github.com/a/b', null, {
            fetchImpl: async () => { throw new Error('boom'); },
        });
        assert.equal(result.ok, null);
        assert.match(result.note, /不阻断|以实际安装结果为准/);
    });

    it('非法地址 → ok:false（直接拦截）', async () => {
        const result = await preflightAccessible('git@github.com:a/b.git', null, { fetchImpl: async () => jsonResponse({}) });
        assert.equal(result.ok, false);
    });
});
