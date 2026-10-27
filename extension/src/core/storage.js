// 持久化适配器（L0-9 宿主适配只进桥接层 / L0-11 适配器+降级）。
// 优先级：SillyTavern 宿主设置（存进服务端 settings.json，随用户档案走）
//        → localStorage（独立页/其他宿主兜底）→ 内存（测试与极端环境）。
//
// ST 通道采用双保险：上下文对象（同会话即时可见 + saveSettingsDebounced 原生保存）
// 与 /api/settings/get→save 直写（确定性落盘，实测 debounce 存在静默丢写的竞态）。

function stContext() {
    try {
        const st = window.SillyTavern;
        const context = st && typeof st.getContext === 'function' ? st.getContext() : null;
        if (context && context.extensionSettings && typeof context.saveSettingsDebounced === 'function') {
            return context;
        }
    } catch {
        /* 宿主上下文不可用 */
    }
    return null;
}

const KEY = 'st_git_improve';

async function readFromServer() {
    try {
        const { hostSettingsGet } = await import('./backend.js');
        const { ok, data } = await hostSettingsGet();
        if (ok && data?.extension_settings && data.extension_settings[KEY] != null) {
            return data.extension_settings[KEY];
        }
    } catch {
        /* 服务端读取不可用 */
    }
    return null;
}

async function writeToServer(state) {
    try {
        const { hostSettingsGet, hostSettingsSave } = await import('./backend.js');
        const { ok, data } = await hostSettingsGet();
        if (!ok || !data) return false;
        data.extension_settings = data.extension_settings || {};
        data.extension_settings[KEY] = state;
        const save = await hostSettingsSave(data);
        return save.ok === true;
    } catch {
        return false;
    }
}

function stAdapter() {
    return {
        name: 'sillytavern',
        async load() {
            const context = stContext();
            const inContext = context?.extensionSettings?.[KEY];
            if (inContext != null) return inContext;
            // 上下文没有（初始化竞态/跨会话）：回退读服务端
            return readFromServer();
        },
        async save(state) {
            let viaContext = false;
            const context = stContext();
            if (context) {
                context.extensionSettings[KEY] = state;
                try {
                    context.saveSettingsDebounced();
                    viaContext = true;
                } catch {
                    viaContext = false;
                }
            }
            // 直写服务端保证落盘（上下文 debounce 实测存在竞态）
            const viaServer = await writeToServer(state);
            return viaContext || viaServer;
        },
    };
}

function localStorageAdapter() {
    return {
        name: 'localstorage',
        async load() {
            try {
                const raw = window.localStorage.getItem(KEY);
                return raw ? JSON.parse(raw) : null;
            } catch {
                return null;
            }
        },
        async save(state) {
            try {
                window.localStorage.setItem(KEY, JSON.stringify(state));
                return true;
            } catch {
                return false;
            }
        },
    };
}

function memoryAdapter(seed = null) {
    let state = seed;
    return {
        name: 'memory',
        async load() {
            return state;
        },
        async save(next) {
            state = next;
            return true;
        },
    };
}

/**
 * 多通道状态合并（读取时防丢数据）：账号按 type+baseUrl+username 去重，
 * 主通道字段优先；defaults 取两通道中被引用账号存在的并集。
 */
export function mergeStates(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    const seen = new Set();
    const accounts = [];
    for (const account of [...(Array.isArray(a.accounts) ? a.accounts : []), ...(Array.isArray(b.accounts) ? b.accounts : [])]) {
        const key = `${account.type}|${account.baseUrl || ''}|${account.username || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        accounts.push(account);
    }
    const ids = new Set(accounts.map(x => x.id));
    const defaults = {};
    for (const [siteKey, id] of Object.entries({ ...(a.defaults || {}), ...(b.defaults || {}) })) {
        if (ids.has(id)) defaults[siteKey] = id;
    }
    // installs：按扩展名合并（主通道优先，次通道补缺）
    const installs = { ...(b && typeof b.installs === 'object' ? b.installs : {}), ...(a && typeof a.installs === 'object' ? a.installs : {}) };
    return { version: 1, accounts, defaults, installs };
}

/** 按环境可用性挑选存储适配器（多通道：第一可用者）。 */
export function createStorage() {
    const adapters = [];
    if (typeof window !== 'undefined') {
        if (stContext()) adapters.push(stAdapter());
        if (typeof window.localStorage !== 'undefined') adapters.push(localStorageAdapter());
    }
    if (adapters.length === 0) adapters.push(memoryAdapter());
    const primary = adapters[0];
    const fallback = adapters[1] || null;
    return {
        name: primary.name,
        /** 读取合并全部可用通道（按账号身份去重），保证任何单一通道的数据都不丢。 */
        async load() {
            const primaryValue = await primary.load().catch(() => null);
            if (!fallback) return primaryValue;
            const fallbackValue = await fallback.load().catch(() => null);
            return mergeStates(primaryValue, fallbackValue);
        },
        /** 双写：主通道失败时仍写次选，保证数据不丢。 */
        async save(state) {
            const results = [await primary.save(state).catch(() => false)];
            if (fallback) results.push(await fallback.save(state).catch(() => false));
            return results.some(Boolean);
        },
    };
}

/** 测试/独立环境直接指定适配器。 */
export function storageForTesting(seed = null) {
    return memoryAdapter(seed);
}
