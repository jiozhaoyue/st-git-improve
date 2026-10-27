// 持久化适配器（L0-9 宿主适配只进桥接层 / L0-11 适配器+降级）。
// 优先级：SillyTavern 宿主设置（存进服务端 settings.json，随用户档案走）
//        → localStorage（独立页/其他宿主兜底）→ 内存（测试与极端环境）。

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

function stAdapter() {
    return {
        name: 'sillytavern',
        async load() {
            const context = stContext();
            if (!context) return null;
            return context.extensionSettings[KEY] ?? null;
        },
        async save(state) {
            const context = stContext();
            if (!context) return false;
            context.extensionSettings[KEY] = state;
            try {
                context.saveSettingsDebounced();
                return true;
            } catch {
                return false;
            }
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
        /** load 返回 null 时回退到次选适配器。 */
        async load() {
            const value = await primary.load().catch(() => null);
            if (value != null || !fallback) return value;
            return fallback.load().catch(() => null);
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
