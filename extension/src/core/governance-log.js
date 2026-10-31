// 治理台账（决策 C-2 数据持久化铁律：事实源 = 宿主通用扩展数据位 extension_settings，
// 经 /api/settings/save 随服务端 settings.json 落盘；localStorage 仅作写失败兜底缓存，
// 永不为事实源）。封顶 200 条，最新在前。
//
// 通道实现沿用 storage.js 的既有模式（宿主设置直写 + localStorage 兜底 + 内存降级），
// 但使用独立的顶层键 st_git_improve_governance，与账号库（st_git_improve）互不覆写——
// 账号库的合并逻辑（mergeStates）只认 accounts/defaults/installs，共键会互相丢数据。
// 纯逻辑、无 DOM 依赖（L1-MR-6 三形态同构）；无 window 的环境自动落到内存适配器。

// 版本参数：与 manifest.json version 同步（宿主 HTTP 缓存破坏），见 index.js 说明。
const V = '0.9.2';

const KEY = 'st_git_improve_governance';
const MAX_ENTRIES = 200;

/** 合法动作白名单（台账只记治理类动作；扩展键位见 strings.js ledger.action.*）。 */
const ACTIONS = ['disable', 'enable', 'uninstall', 'dedupClean', 'move'];

let backendPromise = null;
async function backend() {
    if (!backendPromise) {
        backendPromise = import(`./backend.js?v=${V}`);
    }
    return backendPromise;
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ts = Number(raw.ts);
    const action = String(raw.action || '');
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (!ACTIONS.includes(action)) return null;
    return {
        ts,
        action,
        name: String(raw.name || ''),
        detail: String(raw.detail || ''),
    };
}

function normalizeState(raw) {
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return entries.map(normalizeEntry).filter(Boolean);
}

/** 双通道合并：按 ts+action+name 去重，按 ts 降序，封顶 MAX_ENTRIES（主通道字段优先）。 */
export function mergeEntries(primary, secondary) {
    const seen = new Set();
    const merged = [];
    for (const entry of [...primary, ...secondary]) {
        const normalized = normalizeEntry(entry);
        if (!normalized) continue;
        const key = `${normalized.ts}|${normalized.action}|${normalized.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(normalized);
    }
    merged.sort((a, b) => b.ts - a.ts);
    return merged.slice(0, MAX_ENTRIES);
}

async function readFromServer() {
    try {
        const { hostSettingsGet } = await backend();
        const { ok, data } = await hostSettingsGet();
        if (ok && data?.extension_settings && data.extension_settings[KEY] != null) {
            return normalizeState(data.extension_settings[KEY]);
        }
    } catch {
        /* 服务端读取不可用 */
    }
    return [];
}

async function writeToServer(entries) {
    try {
        const { hostSettingsGet, hostSettingsSave } = await backend();
        const { ok, data } = await hostSettingsGet();
        if (!ok || !data) return false;
        data.extension_settings = data.extension_settings || {};
        data.extension_settings[KEY] = { version: 1, entries };
        const save = await hostSettingsSave(data);
        return save.ok === true;
    } catch {
        return false;
    }
}

function localStorageAdapter() {
    return {
        name: 'localstorage',
        load() {
            try {
                const raw = window.localStorage.getItem(KEY);
                return raw ? normalizeState(JSON.parse(raw)) : [];
            } catch {
                return [];
            }
        },
        save(entries) {
            try {
                window.localStorage.setItem(KEY, JSON.stringify({ version: 1, entries }));
                return true;
            } catch {
                return false;
            }
        },
    };
}

function memoryAdapter() {
    let entries = [];
    return {
        name: 'memory',
        load() {
            return entries;
        },
        save(next) {
            entries = next;
            return true;
        },
    };
}

/**
 * 创建治理台账实例。
 * @returns {{ name: string, append: (action: string, name: string, detail?: string) => Promise<object>, list: (opts?: { limit?: number }) => Promise<object[]> }}
 */
export function createGovernanceLog() {
    const hasWindow = typeof window !== 'undefined';
    const local = hasWindow && typeof window.localStorage !== 'undefined' ? localStorageAdapter() : null;
    const memory = memoryAdapter();

    async function readAll() {
        // C-2：事实源在宿主设置；localStorage 读值仅用于「写失败暂存」的恢复合并。
        const [server, cached] = await Promise.all([
            readFromServer(),
            Promise.resolve(local ? local.load() : memory.load()),
        ]);
        return mergeEntries(server, cached);
    }

    async function writeAll(entries) {
        const viaServer = await writeToServer(entries);
        // localStorage 双写 = 写失败兜底缓存（服务端失败时暂存，恢复后由 readAll 合并回写）
        if (local) local.save(entries);
        else memory.save(entries);
        return viaServer;
    }

    return {
        name: 'governance-log',
        /**
         * 追加一条治理记录（封顶自动淘汰最旧）。
         * @param {'disable'|'enable'|'uninstall'|'dedupClean'|'move'} action
         * @param {string} name
         * @param {string} [detail]
         */
        async append(action, name, detail = '') {
            const entry = normalizeEntry({ ts: Date.now(), action, name, detail });
            if (!entry) throw new Error(`invalid governance log entry: action=${action}`);
            const current = await readAll();
            const entries = mergeEntries(current, [entry]);
            await writeAll(entries);
            return entry;
        },
        /** 最近记录（最新在前）。 */
        async list({ limit = 50 } = {}) {
            const entries = await readAll();
            return entries.slice(0, Math.max(1, Number(limit) || 50));
        },
    };
}
