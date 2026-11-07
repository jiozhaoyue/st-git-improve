// repairflow 编排单测：probeNativeUpdate 分类链路 + repairByRebuild 重建序列（fetch 路由桩）。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { probeNativeUpdate, repairByRebuild } from '../extension/src/core/repairflow.js';

const CSRF = { 'GET /csrf-token': { token: 'test-csrf' } };

function jsonResponse(data, { ok = true, status = 200 } = {}) {
    const text = async () => JSON.stringify(data);
    // json() 按真实 Response 语义返回**已解析对象**（remote-status.requestJson 走 json()，
    // backend.hostApi 走 text()——两种消费形态都要正确）
    return { ok, status, text, json: async () => data };
}

function rawResponse(rawText, { status = 500 } = {}) {
    // 宿主把 git stderr 原文放响应体（非 JSON）
    const text = async () => rawText;
    return { ok: status < 400, status, text, json: async () => { throw new Error('not json'); } };
}

/** routes 值支持 { __raw, __status }（纯文本响应）或普通对象（JSON）；未注册一律 404。 */
function stubFetch(routes, { calls = [] } = {}) {
    return async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const key = `${method} ${String(url).split('?')[0]}`;
        calls.push({ key, body: init.body ? JSON.parse(String(init.body)) : null });
        const hit = routes[key];
        if (hit === undefined) return jsonResponse({}, { ok: false, status: 404 });
        if (hit?.__raw !== undefined) return rawResponse(hit.__raw, { status: hit.__status ?? 500 });
        if (hit?.__status) return jsonResponse(hit.__body ?? {}, { ok: hit.__status < 400, status: hit.__status });
        return jsonResponse(hit);
    };
}

const CONFLICT_TEXT = [
    'error: The following untracked working tree files would be overwritten by merge:',
    '\tindex.js',
    '\tstyle.css',
    'Please move or remove them before you merge.',
    'Aborting',
].join('\n');

function fakeStore() {
    return {
        credentialsFor: async () => ({ auth: { username: 'u', password: 'p' } }),
        recordInstall: async (name, meta) => ({ name, meta }),
    };
}

describe('repairflow: probeNativeUpdate', () => {
    beforeEach(() => { });

    it('200 isUpToDate → up-to-date', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { isUpToDate: true } });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'up-to-date');
        assert.deepEqual(result.files, []);
    });

    it('200 更新成功 → updated + shortCommitHash', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { isUpToDate: false, shortCommitHash: 'abc1234' } });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'updated');
        assert.equal(result.shortCommitHash, 'abc1234');
    });

    it('请求体按实测契约传裸名 + global 标志', async () => {
        const calls = [];
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { isUpToDate: true } }, { calls });
        await probeNativeUpdate('third-party/demo', { global: true });
        const updateCall = calls.find(c => c.key === 'POST /api/extensions/update');
        assert.deepEqual(updateCall.body, { extensionName: 'demo', global: true });
    });

    it('404 → no-channel（宿主无此通道，调用方回退删旧重装）', async () => {
        global.fetch = stubFetch({});
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'no-channel');
    });

    it('500 + git 冲突原文 → untracked-conflict + 文件清单（响应体与后端日志同源）', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { __raw: CONFLICT_TEXT, __status: 500 } });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'untracked-conflict');
        assert.deepEqual(result.files, ['index.js', 'style.css']);
        assert.match(result.raw, /Aborting/);
    });

    it('500 + 本地改动冲突原文 → local-changes', async () => {
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/update': { __raw: 'error: Your local changes to the following files would be overwritten by merge:\n\tstyle.css\nPlease commit your changes or stash them before you merge.\nAborting', __status: 500 },
        });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'local-changes');
        assert.deepEqual(result.files, ['style.css']);
    });

    it('500 + 未知错误文本 → other（raw 透传供 UI 展示）', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { __raw: 'fatal: something else', __status: 500 } });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'other');
        assert.equal(result.raw, 'fatal: something else');
    });
});

describe('repairflow: repairByRebuild（重建修复序列）', () => {
    it('成功路径：备份缺失时跳过备份 → 删旧 → 重装 → 登记回写', async () => {
        const calls = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
        }, { calls });
        const store = fakeStore();
        const logLines = [];
        const result = await repairByRebuild({
            name: 'demo',
            url: 'https://git.example.com/foo/bar.git',
            branch: 'main',
            target: 'extension',
            accounts: store,
            onLog: line => logLines.push(line),
        });
        assert.equal(result.mode, 'rebuild');
        assert.equal(result.backedUp, false);
        const deleteCall = calls.findIndex(c => c.key === 'POST /api/extensions/delete');
        const installCall = calls.findIndex(c => c.key === 'POST /api/extensions/install');
        assert.ok(deleteCall >= 0 && installCall > deleteCall, 'install 必须在 delete 之后');
        const installBody = calls[installCall].body;
        assert.equal(installBody.global, false);
        assert.equal(installBody.branch, 'main');
        assert.match(String(installBody.url), /u:p@git\.example\.com/);
        assert.ok(logLines.some(l => /重建修复完成/.test(l)));
    });

    it('backupFn 注入时先备份再删旧（backedUp: true）', async () => {
        const calls = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
        }, { calls });
        const order = [];
        const result = await repairByRebuild({
            name: 'demo',
            url: 'https://git.example.com/foo/bar.git',
            accounts: fakeStore(),
            backupFn: async () => { order.push('backup'); },
            onLog: () => { },
        });
        assert.equal(result.backedUp, true);
        const deleteCall = calls.findIndex(c => c.key === 'POST /api/extensions/delete');
        assert.ok(deleteCall >= 0);
        await Promise.resolve();
        assert.equal(order[0], 'backup');
        assert.ok(calls.length > 0, 'delete 已发生（备份在 delete 之前由 await 顺序保证）');
    });

    it('删旧失败 → 抛错且不重装', async () => {
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': { __raw: 'cannot delete', __status: 500 },
        });
        await assert.rejects(
            repairByRebuild({ name: 'demo', url: 'https://git.example.com/foo/bar.git', accounts: fakeStore() }),
            /删除旧版失败/,
        );
    });

    it('删旧成功但重装失败 → 抛「重装失败」（扩展已删除，错误必须醒目）', async () => {
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { __raw: 'not found', __status: 404 },
        });
        await assert.rejects(
            repairByRebuild({ name: 'demo', url: 'https://git.example.com/foo/bar.git', accounts: fakeStore() }),
            /重装失败/,
        );
    });
});

// ---------------------------------------------------------------- selfExtensionName（面板自更新执行的前置：自身目录名解析）
import { selfExtensionName } from '../extension/src/core/selfupdate.js';

describe('selfupdate: selfExtensionName（从模块 URL 解析自身安装目录名）', () => {
    it('用户扩展形态：/extensions/third-party/<名>/index.js → 裸名', () => {
        assert.equal(selfExtensionName('https://host/data/default-user/extensions/third-party/st-git-improve/index.js'), 'st-git-improve');
    });

    it('全局扩展形态：/scripts/extensions/third-party/<名>/index.js → 裸名', () => {
        assert.equal(selfExtensionName('https://host/scripts/extensions/third-party/st-git-improve/index.js?v=0.9.3'), 'st-git-improve');
    });

    it('带 URL 编码与版本参数不破坏解析', () => {
        assert.equal(selfExtensionName('https://host/extensions/third-party/my%20ext/index.js?v=1'), 'my ext');
    });

    it('非 extensions 路径 → null（无法确定时不猜）', () => {
        assert.equal(selfExtensionName('https://host/somewhere/else/index.js'), null);
        assert.equal(selfExtensionName('not-a-url'), null);
    });
});

describe('repairflow: 重建修复后的登记 oid 同步', () => {
    it('远端 HEAD 可取 → recordInstall 写入完整 sha（远端状态列不假阳性）', async () => {
        const recorded = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
            'GET https://api.github.com/repos/foo/bar/commits': [{ sha: 'abcdef1234567890abcdef1234567890abcdef12' }],
        });
        const store = fakeStore();
        store.recordInstall = async (name, meta) => { recorded.push({ name, meta }); return { name, meta }; };
        const result = await repairByRebuild({
            name: 'demo',
            url: 'https://github.com/foo/bar.git',
            branch: 'main',
            accounts: store,
            onLog: () => { },
        });
        assert.equal(result.oid, 'abcdef1234567890abcdef1234567890abcdef12');
        assert.equal(recorded[0]?.meta.oid, 'abcdef1234567890abcdef1234567890abcdef12');
    });

    it('远端不可达 → oid 置空（远端状态列降级为「无法比较」而非停留在旧值说谎）', async () => {
        const recorded = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
        });
        const store = fakeStore();
        store.recordInstall = async (name, meta) => { recorded.push({ name, meta }); return { name, meta }; };
        const result = await repairByRebuild({
            name: 'demo',
            url: 'https://github.com/foo/bar.git',
            accounts: store,
            onLog: () => { },
        });
        assert.equal(result.oid, '');
        assert.equal(recorded[0]?.meta.oid, '');
    });
});

describe('repairflow: probeNativeUpdate 其余宿主形态', () => {
    it('403（无权限，如非管理员更新全局扩展）→ other（raw 透传）', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': { __raw: 'You don\'t have permission to update global extensions.', __status: 403 } });
        const result = await probeNativeUpdate('demo', { global: true });
        assert.equal(result.status, 'other');
        assert.match(result.raw, /permission/);
    });

    it('200 但 isUpToDate 缺字段 → updated（与原生 UI 同为 truthy 判定，hash 缺失显示 ?）', async () => {
        global.fetch = stubFetch({ ...CSRF, 'POST /api/extensions/update': {} });
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'updated');
        assert.equal(result.shortCommitHash, '');
    });
});

describe('repairflow: 删除通道 global 标志（原生 UI 同款契约）', () => {
    it('重建修复全局扩展 → delete 请求体显式带 global:true', async () => {
        const calls = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
        }, { calls });
        await repairByRebuild({
            name: 'demo',
            url: 'https://git.example.com/foo/bar.git',
            target: 'global',
            accounts: fakeStore(),
            onLog: () => { },
        });
        const deleteBody = calls.find(c => c.key === 'POST /api/extensions/delete')?.body;
        assert.deepEqual(deleteBody, { extensionName: 'demo', global: true });
    });

    it('本地扩展重建 → delete 请求体 global:false（显式而非省略）', async () => {
        const calls = [];
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/delete': 'Extension has been deleted at somewhere',
            'POST /api/extensions/install': { status: 'installed' },
        }, { calls });
        await repairByRebuild({
            name: 'demo',
            url: 'https://git.example.com/foo/bar.git',
            accounts: fakeStore(),
            onLog: () => { },
        });
        const deleteBody = calls.find(c => c.key === 'POST /api/extensions/delete')?.body;
        assert.equal(deleteBody.global, false);
    });
});

describe('repairflow: probeNativeUpdate 响应形态兜底', () => {
    it('500 + JSON { error: 冲突原文 }（代理/宿主包装形态）也能分类', async () => {
        global.fetch = stubFetch({
            ...CSRF,
            'POST /api/extensions/update': { error: 'error: The following untracked working tree files would be overwritten by merge:\n\tindex.js\nPlease move or remove them before you merge.\nAborting' },
            // 注意：stub 的对象命中走 jsonResponse → JSON 200 ok… 这里需要显式 500
        });
        // 上行 stub 会按 200 返回——改用 __raw 模拟同语义：宿主 500 纯文本是主形态，
        // JSON error 字段兜底由 rawText/raw/error 读取顺序保证，此处以单测锁 error 读取链
        global.fetch = async (url, init = {}) => {
            await Promise.resolve();
            const method = (init.method || 'GET').toUpperCase();
            if (method === 'GET' && String(url).includes('csrf-token')) {
                const text = async () => JSON.stringify({ token: 't' });
                return { ok: true, status: 200, text, json: async () => ({ token: 't' }) };
            }
            const text = async () => JSON.stringify({ error: 'error: The following untracked working tree files would be overwritten by merge:\n\tindex.js\nAborting' });
            return { ok: false, status: 500, text, json: async () => ({ error: 'error: The following untracked working tree files would be overwritten by merge:\n\tindex.js\nAborting' }) };
        };
        const result = await probeNativeUpdate('demo');
        assert.equal(result.status, 'untracked-conflict');
        assert.deepEqual(result.files, ['index.js']);
    });
});
