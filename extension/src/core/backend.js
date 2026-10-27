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

/** 简单三段版本比较：a < b → -1，相等 → 0，a > b → 1。非法段按 0 处理。 */
export function compareVersions(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

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

/** 宿主原生扩展发现（诊断/治理列表用）。
 * 实测契约（ST 1.19）：GET /api/extensions/discover（无 body、无需 CSRF）返回
 * [{ type: 'local'|'global'|'system', name: 'third-party/<名称>', ... }]；POST 形态不存在（404）。
 * 映射：只保留 local/global，剥掉 third-party/ 前缀，scope 记录安装范围。 */
export async function hostDiscover() {
    const result = await hostApi('/api/extensions/discover');
    if (result.ok && Array.isArray(result.data)) {
        const entries = result.data
            .filter(e => e && (e.type === 'local' || e.type === 'global'))
            .map(e => ({
                ...e,
                name: String(e.name || '').replace(/^third-party\//, ''),
                scope: e.type,
            }));
        return { ...result, entries };
    }
    return { ...result, entries: [] };
}

/** 宿主原生设置读取（治理降级用）。返回解析后的完整 settings 对象。 */
export async function hostSettingsGet() {
    const result = await hostApi('/api/settings/get', { body: {} });
    if (result.ok && result.data?.settings != null) {
        // 实测 ST 1.19：返回 { settings: "<整份设置的 JSON 字符串>" }
        let settings = result.data.settings;
        if (typeof settings === 'string') {
            try {
                settings = JSON.parse(settings);
            } catch {
                return { ok: false, status: 'settings-parse-failed', data: null };
            }
        }
        return { ok: true, status: result.status, data: settings };
    }
    return result;
}

/** 宿主原生设置整体保存（fetch-mutate-post 持久性直写；宿主 UI 同款通道）。
 * 实测契约（ST 1.19）：GET /api/settings/get 返回 { settings: "<JSON 字符串>" }，
 * 而 POST /api/settings/save 的请求体是**裸 settings 对象**（无包裹）。 */
export async function hostSettingsSave(settingsPayload) {
    const result = await hostApi('/api/settings/save', { body: settingsPayload });
    return result;
}

/**
 * 纯前端扩展治理：切换宿主设置中的禁用清单。
 * 实测契约（ST 1.19）：宿主读取 `extension_settings.disabledExtensions`（数组，
 * 条目形如 'third-party/<name>'），在清单内的扩展重载后不加载（仅拉 manifest）。
 * 返回 { ok, disabled, note }；宿主设置不可达时 ok=false。
 */
export async function hostToggleExtensionDisabled(name, disable) {
    const settings = await hostSettingsGet();
    if (!settings.ok || !settings.data) {
        return { ok: false, note: `宿主设置不可达（HTTP ${settings.status}）` };
    }
    const data = settings.data;
    data.extension_settings = data.extension_settings || {};
    const prefixed = `third-party/${name}`;
    // 主键位：extension_settings.disabledExtensions；兼容旧形态（根级字段/对象分桶）。
    let container = data.extension_settings.disabledExtensions;
    if (container == null) {
        const root = data.disabledExtensions;
        container = Array.isArray(root) ? [...root] : (root && typeof root === 'object')
            ? [...new Set(Object.values(root).flat().filter(x => typeof x === 'string'))]
            : [];
    }
    if (!Array.isArray(container)) container = [];
    const set = new Set(container);
    if (disable) set.add(prefixed); else set.delete(prefixed);
    data.extension_settings.disabledExtensions = [...set];
    const save = await hostSettingsSave(data);
    if (!save.ok) {
        return { ok: false, note: `保存设置失败（HTTP ${save.status}）` };
    }
    return { ok: true, disabled: disable };
}

/** 宿主原生扩展删除（更新流程用：删旧目录后重装）。
 * 实测契约（ST 1.19）：POST /api/extensions/delete，body { extensionName: '<不带前缀>' }，
 * 成功 200 "Extension has been deleted at ..."；目录不存在 404。 */
export async function hostDeleteExtension(name) {
    const result = await hostApi('/api/extensions/delete', {
        body: { extensionName: String(name || '').replace(/^third-party\//, '') },
    });
    if (result.ok || result.status === 404) return { ok: true, status: result.status };
    return { ok: false, note: result.data?.raw || result.data?.error || `HTTP ${result.status}` };
}

// ---------------------------------------------------------------- 统一操作门面

/** 宿主原生扩展迁移（local ↔ global）。
 * 实测契约（ST 1.19）：POST /api/extensions/move，body
 * { extensionName: '<不带 third-party/ 前缀>', source: 'local'|'global', destination: 'local'|'global' }，
 * 成功返回 204（无 body）。 */
export async function hostMoveExtension(name, source, destination) {
    const result = await hostApi('/api/extensions/move', {
        body: { extensionName: String(name || '').replace(/^third-party\//, ''), source, destination },
    });
    if (result.status === 204) return { ok: true };
    return { ok: result.ok, note: result.data?.error || result.data?.raw || `HTTP ${result.status}` };
}

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
