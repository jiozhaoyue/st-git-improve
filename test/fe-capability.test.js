// 能力态三维矩阵单测（prd AC-2 / 决策 D8-1 D8-2 D9-1 D3-3）。
// 被测模块为纯逻辑（L1-MR-6），fetch 以桩函数按「METHOD 路径」分发模拟宿主/Authority 各状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectHostChannel,
    detectAuthority,
    detectAdmin,
    detectCapabilityState,
    can,
    resetCapabilityCache,
    AUTHORITY_CAPABILITIES,
} from '../extension/src/core/capability.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
    const text = async () => JSON.stringify(data);
    // 注意：backend.js 的 getCsrfToken 用 response.json()，capability.js 的 probeJson 用 response.text()——桩必须两个都提供
    return { ok, status, text, json: text };
}

/** routes 形如 { 'GET /api/extensions/discover': <body> }；
 * 值为 { __status } 时按该状态码返回（__body 可选）；值为 { __error: true } 时模拟网络异常；未注册路径一律 404。 */
function stubFetch(routes) {
    return async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const key = `${method} ${String(url).split('?')[0]}`;
        const hit = routes[key];
        if (hit === undefined) return jsonResponse({}, { ok: false, status: 404 });
        if (hit?.__error) throw new Error('network down');
        if (hit?.__status) {
            return jsonResponse(hit.__body ?? {}, { ok: hit.__status < 400, status: hit.__status });
        }
        return jsonResponse(hit);
    };
}

const BASE_ROUTES = {
    'GET /csrf-token': { token: 'test-csrf' },
    'GET /api/extensions/discover': [{ name: 'third-party/demo', type: 'local' }],
    'POST /api/settings/get': { settings: '{}', enable_accounts: true },
    'GET /api/users/me': { admin: true, handle: 'ops' },
};

test('AUTHORITY_CAPABILITIES 恒为五类管理能力（D2-4）', () => {
    assert.deepEqual([...AUTHORITY_CAPABILITIES].sort(), ['dedupClean', 'depsFix', 'disableZone', 'gitBridge', 'rebuildUpdate']);
});

// ---------------------------------------------------------------- 宿主通道维

test('宿主通道：discover 不可达 → 全灰 + hostUnreachable（D9-1）', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({});
    const host = await detectHostChannel();
    assert.equal(host.reachable, false);
    assert.equal(host.discover, false);
    assert.equal(host.install, false);
    assert.equal(host.remove, false);
    assert.equal(host.move, false);
    assert.equal(host.reasonKey, 'cap.reason.hostUnreachable');
});

test('宿主通道：discover 可达 + settings 可达 → 全通', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch(BASE_ROUTES);
    const host = await detectHostChannel();
    assert.equal(host.reachable, true);
    assert.equal(host.discover, true);
    assert.equal(host.install, true);
    assert.equal(host.remove, true);
    assert.equal(host.move, true);
    assert.equal(host.settings, true);
});

test('宿主通道：settings 失败仅影响 settings，install 随 discover 推断', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /csrf-token': { token: 't' },
        'GET /api/extensions/discover': [],
        // settings/get 缺席 → 404
    });
    const host = await detectHostChannel();
    assert.equal(host.reachable, true);
    assert.equal(host.install, true);
    assert.equal(host.settings, false);
});

test('宿主通道：网络异常（fetch 抛错）按不可达处理', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({ 'GET /api/extensions/discover': { __error: true } });
    const host = await detectHostChannel();
    assert.equal(host.reachable, false);
    assert.equal(host.reasonKey, 'cap.reason.hostUnreachable');
});

// ---------------------------------------------------------------- Authority 维（D8-1 逐能力探测）

test('Authority：不在位（404）→ present=false 且全能力 false', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({});
    const authority = await detectAuthority();
    assert.equal(authority.present, false);
    assert.equal(authority.version, null);
    for (const cap of AUTHORITY_CAPABILITIES) {
        assert.equal(authority.capabilities[cap], false);
    }
});

test('Authority：旧版缺能力 → 仅缺失项 false，其余 true（D8-1 降级粒度）', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /api/plugins/authority/ext-mgmt/capabilities': {
            version: '1.0.0',
            capabilities: { rebuildUpdate: true, depsFix: true, dedupClean: true, disableZone: true },
        },
    });
    const authority = await detectAuthority();
    assert.equal(authority.present, true);
    assert.equal(authority.capabilities.rebuildUpdate, true);
    assert.equal(authority.capabilities.gitBridge, false);
});

test('Authority：capabilities 非对象 → 视为不在位', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /api/plugins/authority/ext-mgmt/capabilities': { capabilities: 'bogus' },
    });
    const authority = await detectAuthority();
    assert.equal(authority.present, false);
});

// ---------------------------------------------------------------- 管理员维（D8-2）

test('管理员：users/me admin=true → 管理员（宿主标志）', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({ 'GET /api/users/me': { admin: true } });
    const admin = await detectAdmin();
    assert.equal(admin.admin, true);
    assert.equal(admin.reasonKey, 'cap.reason.adminHostFlag');
});

test('管理员：admin=false + enable_accounts=false → 单用户视为管理员', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /csrf-token': { token: 't' },
        'GET /api/users/me': { admin: false },
        'POST /api/settings/get': { settings: '{}', enable_accounts: false },
    });
    const admin = await detectAdmin();
    assert.equal(admin.admin, true);
    assert.equal(admin.reasonKey, 'cap.reason.adminSingleUser');
});

test('管理员：users/me 不可达 → 降级视为管理员', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({});
    const admin = await detectAdmin();
    assert.equal(admin.admin, true);
    assert.equal(admin.reasonKey, 'cap.reason.adminDegraded');
});

test('管理员：admin=false + enable_accounts=true → 非管理员', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /csrf-token': { token: 't' },
        'GET /api/users/me': { admin: false },
        'POST /api/settings/get': { settings: '{}', enable_accounts: true },
    });
    const admin = await detectAdmin();
    assert.equal(admin.admin, false);
    assert.equal(admin.reasonKey, 'cap.reason.needAdmin');
});

// ---------------------------------------------------------------- 三态徽标（D3-3）+ can() 矩阵（D9-1）

test('tier：纯前端态 + can() 宿主动作可用、Authority 动作 needAuthority', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch(BASE_ROUTES); // Authority 404
    const state = await detectCapabilityState();
    assert.equal(state.tier, 'pure');
    assert.deepEqual(can('install', state), { allowed: true, reasonKey: null });
    assert.deepEqual(can('governToggle', state), { allowed: true, reasonKey: null });
    assert.deepEqual(can('rebuildUpdate', state), { allowed: false, reasonKey: 'cap.reason.needAuthority' });
    assert.deepEqual(can('depsFix', state), { allowed: false, reasonKey: 'cap.reason.needAuthority' });
});

test('tier：Authority 在位 + 非管理员 → authority；Authority 动作 needAdmin', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        ...BASE_ROUTES,
        'GET /api/users/me': { admin: false },
        'GET /api/plugins/authority/ext-mgmt/capabilities': {
            version: '1.0.0',
            capabilities: { rebuildUpdate: true, depsFix: true, dedupClean: true, disableZone: true, gitBridge: true },
        },
    });
    const state = await detectCapabilityState();
    assert.equal(state.tier, 'authority');
    assert.deepEqual(can('rebuildUpdate', state), { allowed: false, reasonKey: 'cap.reason.needAdmin' });
    assert.deepEqual(can('disableZone', state), { allowed: false, reasonKey: 'cap.reason.needAdmin' });
});

test('tier：Authority 在位 + 管理员 → authority-admin；缺能力项 needAuthorityUpgrade、齐备项可用', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        ...BASE_ROUTES,
        'GET /api/plugins/authority/ext-mgmt/capabilities': {
            version: '1.0.0',
            capabilities: { rebuildUpdate: false, depsFix: true, dedupClean: true, disableZone: true, gitBridge: true },
        },
    });
    const state = await detectCapabilityState();
    assert.equal(state.tier, 'authority-admin');
    assert.deepEqual(can('rebuildUpdate', state), { allowed: false, reasonKey: 'cap.reason.needAuthorityUpgrade' });
    assert.deepEqual(can('depsFix', state), { allowed: true, reasonKey: null });
    assert.deepEqual(can('purgeZone', state), { allowed: true, reasonKey: null });
});

test('can()：settings 不可达但 discover 可达 → governToggle 给 hostSettings 理由（非宿主全灰）', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({
        'GET /csrf-token': { token: 't' },
        'GET /api/extensions/discover': [],
        // settings/get 缺席 → 404
    });
    const state = await detectCapabilityState();
    assert.deepEqual(can('governToggle', state), { allowed: false, reasonKey: 'cap.reason.hostSettings' });
    assert.deepEqual(can('install', state), { allowed: true, reasonKey: null });
});

test('can()：宿主整体不可达 → 宿主动作全部 hostUnreachable', async () => {
    resetCapabilityCache();
    global.fetch = stubFetch({});
    const state = await detectCapabilityState();
    assert.deepEqual(can('update', state), { allowed: false, reasonKey: 'cap.reason.hostUnreachable' });
    assert.deepEqual(can('move', state), { allowed: false, reasonKey: 'cap.reason.hostUnreachable' });
});

test('can()：未知动作 → unknownAction；缓存生效（force=false 不重新探测）', async () => {
    resetCapabilityCache();
    let calls = 0;
    global.fetch = async (...args) => {
        calls += 1;
        return stubFetch(BASE_ROUTES)(...args);
    };
    const first = await detectCapabilityState();
    const countAfterFirst = calls;
    const second = await detectCapabilityState();
    assert.equal(second, first);
    assert.equal(calls, countAfterFirst);
    assert.equal(can('nonexistent', first).reasonKey, 'cap.reason.unknownAction');
});
