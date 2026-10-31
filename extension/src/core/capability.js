// 能力态探测（design.md §1；决策 D8-1 逐能力探测 / D8-2 宿主 admin 标志 / D9-1 逐项灰化 / D3-3 三态徽标）。
// 三维：宿主原生通道 × Authority 逐能力 × 管理员身份 → 统一能力态对象，驱动徽标与灰化。
// 纯逻辑模块（L1-MR-6 三形态同构）：无 DOM 依赖，Node 测试环境可直接单测。
// 文案纪律（R-15）：面向用户的 reason 一律 i18n 键（键位清单见文件尾注释），禁止硬编码文案。

import { getCsrfToken } from './backend.js';

const AUTHORITY_API = '/api/plugins/authority/ext-mgmt';
const PROBE_TIMEOUT_MS = 4000;

/** Authority 五类管理能力（D2-4 / design.md §5 契约草案 v0 的能力清单端点）。 */
export const AUTHORITY_CAPABILITIES = ['rebuildUpdate', 'depsFix', 'dedupClean', 'disableZone', 'gitBridge'];

async function probeJson(url, { method = 'GET', body, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {};
        if (body !== undefined) {
            method = method || 'POST';
            headers['Content-Type'] = 'application/json';
        }
        if (method && method !== 'GET') {
            headers['X-CSRF-Token'] = await getCsrfToken();
        }
        const response = await fetch(url, {
            method: method || 'GET',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        return { ok: response.ok, status: response.status, data };
    } catch {
        return { ok: false, status: 0, data: null };
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------- 宿主原生通道（D9-1）

let hostCache = null;

/**
 * 宿主通道探测。install/delete/move 与 discover 同族（宿主扩展 API），
 * 写操作无法安全逐端点探测 → 随 discover 可达性推断；settings 单独探测（治理开关依赖）。
 * 返回 { reachable, discover, settings, install, remove, move, reasonKey }。
 */
export async function detectHostChannel({ force = false } = {}) {
    if (hostCache && !force) return hostCache;
    const state = {
        reachable: false,
        discover: false,
        settings: false,
        install: false,
        remove: false,
        move: false,
        reasonKey: null,
    };
    const discover = await probeJson('/api/extensions/discover');
    if (!discover.ok) {
        state.reasonKey = 'cap.reason.hostUnreachable';
        hostCache = state;
        return state;
    }
    state.reachable = true;
    state.discover = true;
    state.install = true;
    state.remove = true;
    state.move = true;
    const settings = await probeJson('/api/settings/get', { method: 'POST', body: {} });
    state.settings = settings.ok;
    hostCache = state;
    return state;
}

// ---------------------------------------------------------------- Authority（D8-1 逐能力探测）

let authorityCache = null;

/**
 * Authority 逐能力探测：能力清单端点（design.md §5 契约草案 v0）。
 * 不在位 / 旧版缺能力 → 仅对应能力 false，不影响其余（降级粒度最细）。
 * 返回 { present, version, capabilities: { rebuildUpdate, depsFix, dedupClean, disableZone, gitBridge } }。
 */
export async function detectAuthority({ force = false } = {}) {
    if (authorityCache && !force) return authorityCache;
    const state = { present: false, version: null, capabilities: {} };
    const res = await probeJson(`${AUTHORITY_API}/capabilities`);
    if (res.ok && res.data && typeof res.data.capabilities === 'object' && res.data.capabilities) {
        state.present = true;
        state.version = res.data.version || null;
        for (const cap of AUTHORITY_CAPABILITIES) {
            state.capabilities[cap] = res.data.capabilities[cap] === true;
        }
    } else {
        // 不在位时也补全五能力为 false——消费方（can/灰化）直接读 capabilities[cap]，不判 undefined
        for (const cap of AUTHORITY_CAPABILITIES) {
            state.capabilities[cap] = false;
        }
    }
    authorityCache = state;
    return state;
}

// ---------------------------------------------------------------- 管理员判定（D8-2）

let adminCache = null;

/**
 * 管理员判定：宿主 admin 标志（多用户模式）；单用户（enable_accounts=false）或
 * users/me 不可达（降级模式）视为管理员。无自建门禁。
 * 返回 { admin, reasonKey }。
 */
export async function detectAdmin({ force = false } = {}) {
    if (adminCache && !force) return adminCache;
    const me = await probeJson('/api/users/me');
    if (!me.ok) {
        adminCache = { admin: true, reasonKey: 'cap.reason.adminDegraded' };
        return adminCache;
    }
    if (me.data?.admin === true) {
        adminCache = { admin: true, reasonKey: 'cap.reason.adminHostFlag' };
        return adminCache;
    }
    const settings = await probeJson('/api/settings/get', { method: 'POST', body: {} });
    const enableAccounts = settings.ok ? settings.data?.enable_accounts : null;
    if (enableAccounts === false) {
        adminCache = { admin: true, reasonKey: 'cap.reason.adminSingleUser' };
        return adminCache;
    }
    adminCache = { admin: me.data?.admin === true, reasonKey: 'cap.reason.needAdmin' };
    return adminCache;
}

// ---------------------------------------------------------------- 统一能力态 + 三态徽标（D3-3）

let stateCache = null;

/**
 * 统一能力态：
 * {
 *   host, authority, admin,
 *   tier: 'pure' | 'authority' | 'authority-admin',   // 三态徽标
 *   probeAt: <epoch ms>
 * }
 */
export async function detectCapabilityState({ force = false } = {}) {
    if (stateCache && !force) return stateCache;
    const [host, authority, admin] = await Promise.all([
        detectHostChannel({ force }),
        detectAuthority({ force }),
        detectAdmin({ force }),
    ]);
    let tier = 'pure';
    if (authority.present) tier = admin.admin ? 'authority-admin' : 'authority';
    stateCache = { host, authority, admin, tier, probeAt: Date.now() };
    return stateCache;
}

// ---------------------------------------------------------------- 动作裁决（D3-4 灰化 + D9-1 逐项降级）

/** 动作 → 所需能力的映射表（灰化 tooltip 用 reasonKey 全部为 i18n 键）。 */
export const ACTION_REQUIREMENTS = {
    // 宿主原生通道
    install: { kind: 'host', flag: 'install' },
    update: { kind: 'host', flag: 'install' },
    remove: { kind: 'host', flag: 'remove' },
    move: { kind: 'host', flag: 'move' },
    governToggle: { kind: 'host', flag: 'settings' },
    // 纯前端管理动作
    dedupCleanBasic: { kind: 'host', flag: 'remove' }, // 显式确认清理（无改动守卫降级形态）
    // Authority 管理动作（仅管理员）
    rebuildUpdate: { kind: 'authority', cap: 'rebuildUpdate' },
    depsFix: { kind: 'authority', cap: 'depsFix' },
    dedupClean: { kind: 'authority', cap: 'dedupClean' },
    disableZone: { kind: 'authority', cap: 'disableZone' },
    purgeZone: { kind: 'authority', cap: 'disableZone' },
    gitBridge: { kind: 'authority', cap: 'gitBridge' },
};

/**
 * 裁决某动作当前是否可用。
 * 返回 { allowed, reasonKey }——reasonKey 供灰化 tooltip（D3-4：常显灰化引导）。
 */
export function can(action, state = stateCache) {
    const req = ACTION_REQUIREMENTS[action];
    if (!req || !state) return { allowed: false, reasonKey: 'cap.reason.unknownAction' };
    if (req.kind === 'host') {
        if (!state.host[req.flag]) {
            // settings 不可达但 discover 可达：治理开关不可用，理由应指向设置通道而非整个宿主通道
            if (req.flag === 'settings' && state.host.reachable) {
                return { allowed: false, reasonKey: 'cap.reason.hostSettings' };
            }
            return { allowed: false, reasonKey: state.host.reasonKey || 'cap.reason.hostUnreachable' };
        }
        return { allowed: true, reasonKey: null };
    }
    // Authority 动作：需在位 + 具备该能力 + 管理员（D2-4 仅管理员）
    if (!state.authority.present) {
        return { allowed: false, reasonKey: 'cap.reason.needAuthority' };
    }
    if (!state.admin.admin) {
        return { allowed: false, reasonKey: 'cap.reason.needAdmin' };
    }
    if (!state.authority.capabilities[req.cap]) {
        return { allowed: false, reasonKey: 'cap.reason.needAuthorityUpgrade' };
    }
    return { allowed: true, reasonKey: null };
}

/** 清空全部探测缓存（单测用）。 */
export function resetCapabilityCache() {
    hostCache = null;
    authorityCache = null;
    adminCache = null;
    stateCache = null;
}

/**
 * i18n 键位清单（1.2 字典需覆盖）：
 * cap.reason.hostUnreachable / cap.reason.needAuthority / cap.reason.needAuthorityUpgrade /
 * cap.reason.needAdmin / cap.reason.adminDegraded / cap.reason.adminHostFlag /
 * cap.reason.adminSingleUser / cap.reason.unknownAction
 * 徽标三态：cap.tier.pure / cap.tier.authority / cap.tier.authorityAdmin
 */
