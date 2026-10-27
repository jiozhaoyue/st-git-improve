// 后端适配层（L0-11：适配器 + 特性检测 + 静默降级）。
// 探测服务端插件是否在位；为各标签页提供统一操作入口：
//   - 服务端在位 → 插件通道（备份/去重/依赖修复等完整语义）
//   - 纯前端     → 浏览器克隆 + 宿主原生安装通道（无服务端插件也能装私有仓库）

const API = '/api/plugins/st-git-improve';
const PROBE_TIMEOUT_MS = 4000;

let csrfCache = null;
export async function getCsrfToken() {
    if (!csrfCache) {
        const response = await fetch('/csrf-token');
        const data = await response.json().catch(() => ({}));
        csrfCache = String(data?.token || '');
    }
    return csrfCache;
}

/** 服务端插件通道（失败即抛错，与旧版面板语义一致）。 */
export async function pluginApi(path, options = {}) {
    const init = { headers: {}, ...options };
    if (init.body !== undefined) {
        init.method = init.method || 'POST';
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(init.body);
    }
    if (init.method && init.method !== 'GET') {
        init.headers['X-CSRF-Token'] = await getCsrfToken();
    }
    const response = await fetch(`${API}${path}`, init);
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!response.ok) {
        throw new Error(data?.error || text || `${response.status} ${response.statusText}`);
    }
    return data;
}

let modeCache = null;

/** 探测运行模式：'server'（服务端插件在位）| 'pure'（纯前端）。 */
export async function detectMode({ force = false } = {}) {
    if (modeCache && !force) return modeCache;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const response = await fetch(`${API}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
            const data = await response.json().catch(() => ({}));
            modeCache = { mode: 'server', info: data };
            return modeCache;
        }
    } catch {
        /* 服务端不在 */
    }
    modeCache = { mode: 'pure', info: null };
    return modeCache;
}

// ---------------------------------------------------------------- 宿主原生通道

async function hostApi(path, options = {}) {
    const init = { headers: {}, ...options };
    if (init.body !== undefined && !(init.body instanceof FormData)) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(init.body);
    }
    if ((init.method || (init.body ? 'POST' : 'GET')) !== 'GET') {
        init.method = init.method || (init.body ? 'POST' : 'GET');
        init.headers['X-CSRF-Token'] = await getCsrfToken();
    }
    const response = await fetch(path, init);
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text.slice(0, 300) };
    }
    return { status: response.status, ok: response.ok, data };
}

/** 宿主原生安装（ST/Luker 的 /api/extensions/install）：token 内嵌 URL，服务端克隆。 */
export async function hostNativeInstall({ authedUrl, global: isGlobal, branch }) {
    const body = { url: authedUrl, global: Boolean(isGlobal) };
    if (branch) body.branch = branch;
    const result = await hostApi('/api/extensions/install', { body });
    return result;
}

/** 宿主原生扩展发现（诊断降级用）。 */
export async function hostDiscover() {
    const result = await hostApi('/api/extensions/discover', { method: 'POST', body: {} });
    return result;
}

/** 宿主原生设置读取（治理降级用）。 */
export async function hostSettingsGet() {
    const result = await hostApi('/api/settings/get', { body: {} });
    return result;
}

/**
 * 纯前端扩展治理：切换宿主设置中的 disabledExtensions。
 * 返回 { ok, disabled, note }；宿主设置不可达时 ok=false。
 */
export async function hostToggleExtensionDisabled(name, disable) {
    const settings = await hostSettingsGet();
    if (!settings.ok || !settings.data) {
        return { ok: false, note: `宿主设置不可达（HTTP ${settings.status}）` };
    }
    const data = settings.data;
    // 兼容两种形态：disabledExtensions 为数组，或对象（按用户句柄分桶）。
    let container = data.disabledExtensions;
    if (Array.isArray(container)) {
        const set = new Set(container);
        if (disable) set.add(name); else set.delete(name);
        data.disabledExtensions = [...set];
    } else if (container && typeof container === 'object') {
        for (const key of Object.keys(container)) {
            const bucket = container[key];
            if (!Array.isArray(bucket)) continue;
            const set = new Set(bucket);
            const had = set.has(name);
            if (disable && had) continue;
            if (!disable && !had) continue;
            if (disable) set.add(name); else set.delete(name);
            bucket.length = 0;
            bucket.push(...set);
        }
    } else {
        return { ok: false, note: '设置中没有 disabledExtensions 字段（宿主版本不兼容？）' };
    }
    const save = await hostApi('/api/settings/save', { body: data });
    if (!save.ok) {
        return { ok: false, note: `保存设置失败（HTTP ${save.status}）` };
    }
    return { ok: true, disabled: disable };
}

// ---------------------------------------------------------------- 统一操作门面

export function getBackend() {
    return {
        mode: modeCache?.mode || 'pure',
        info: modeCache?.info || null,
        pluginApi,
        hostNativeInstall,
        hostDiscover,
        hostSettingsGet,
        hostToggleExtensionDisabled,
    };
}
