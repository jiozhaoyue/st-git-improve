// 纯前端站点适配器：与 plugin/auth/sites.js 语义一致，但全部请求直接从浏览器发出。
// 注意：自建站点（Gitea/GitLab 自建）可能没有 CORS 头 —— 验证失败会明确标注
// 「CORS 拦截/未验证」，凭据仍然保存，实际可用性以 git 操作结果为准。

/** @param {string} baseUrl */
export function normalizeBaseUrl(baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('站点地址为空');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('站点地址不是合法 URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('站点地址仅支持 http/https');
    }
    return parsed.origin + (parsed.pathname.replace(/\/+$/, '') || '');
}

export const SITE_TYPES = [
    { id: 'gitea', label: 'Gitea / Forgejo（含自建）', needsBase: true },
    { id: 'github', label: 'GitHub', needsBase: false },
    { id: 'gitlab', label: 'GitLab（留空 = gitlab.com，自建请填地址）', needsBase: true },
    { id: 'gitee', label: 'Gitee', needsBase: false },
];

const DEFAULT_BASE = {
    github: 'https://github.com',
    gitlab: 'https://gitlab.com',
    gitee: 'https://gitee.com',
};

/** 站点类型默认 baseUrl（needsBase=false 的类型）。 */
export function defaultBaseUrl(type) {
    return DEFAULT_BASE[type] || '';
}

async function jsonRequest(url, init = {}) {
    let response;
    try {
        response = await fetch(url, {
            method: init.method || 'GET',
            headers: { Accept: 'application/json', ...init.headers },
            body: init.body,
        });
    } catch (error) {
        // 浏览器直连被 CORS/网络拦截：调用方据此区分「验证不了」与「凭据错误」。
        const wrapped = new Error(`浏览器直连失败（CORS 或网络）: ${error.message || error}`);
        // @ts-ignore
        wrapped.blockedByBrowser = true;
        throw wrapped;
    }
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

export const adapters = {
    gitea: {
        id: 'gitea',
        label: 'Gitea / Forgejo（含自建）',
        requiresBaseUrl: true,
        detect(host) {
            return false; // 自建站点类型必须由用户显式选择
        },
        async testCredential({ baseUrl, token }) {
            const base = normalizeBaseUrl(baseUrl);
            const { response, payload } = await jsonRequest(`${base}/api/v1/user`, {
                headers: { Authorization: `token ${token}` },
            });
            return { ok: response.ok, login: payload.login || '', status: response.status };
        },
    },
    github: {
        id: 'github',
        label: 'GitHub',
        requiresBaseUrl: false,
        detect(host) {
            return host === 'github.com' || host.endsWith('.github.com');
        },
        async testCredential({ token }) {
            const { response, payload } = await jsonRequest('https://api.github.com/user', {
                headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'st-git-improve' },
            });
            return { ok: response.ok, login: payload.login || '', status: response.status };
        },
    },
    gitlab: {
        id: 'gitlab',
        label: 'GitLab（gitlab.com / 自建）',
        requiresBaseUrl: false,
        detect(host) {
            return host === 'gitlab.com' || host.endsWith('.gitlab.com');
        },
        async testCredential({ baseUrl, token }) {
            const base = baseUrl ? normalizeBaseUrl(baseUrl) : 'https://gitlab.com';
            const { response, payload } = await jsonRequest(`${base}/api/v4/user`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return { ok: response.ok, login: payload.username || '', status: response.status };
        },
    },
    gitee: {
        id: 'gitee',
        label: 'Gitee',
        requiresBaseUrl: false,
        detect(host) {
            return host === 'gitee.com' || host.endsWith('.gitee.com');
        },
        async testCredential({ token }) {
            const { response, payload } = await jsonRequest(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
            return { ok: response.ok, login: payload.login || '', status: response.status };
        },
    },
};

export function getAdapter(type) {
    const adapter = adapters[String(type || '')];
    if (!adapter) throw new Error(`未知站点类型: ${type}`);
    return adapter;
}

/** @param {string} host */
export function detectTypeForHost(host) {
    for (const adapter of Object.values(adapters)) {
        if (adapter.detect(host)) return adapter.id;
    }
    return '';
}

/**
 * 解析仓库 URL：返回 { type, baseUrl, host, owner, repo, httpsUrl }。
 * 支持 https://host/owner/repo(.git) 与 https://user:token@host/owner/repo 形式。
 */
export function parseRepoUrl(repoUrl) {
    const raw = String(repoUrl || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
        // 覆盖 scp 语法（git@host:a/b）与 ssh:// 等浏览器不支持的形态
        throw new Error('仓库地址仅支持 http/https（浏览器无法使用 ssh 协议）');
    }
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('仓库地址不是合法 URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('仓库地址仅支持 http/https（浏览器无法使用 ssh 协议）');
    }
    const host = parsed.host.toLowerCase();
    const segments = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length < 2) throw new Error('仓库地址缺少 owner/repo 部分');
    const owner = segments[0];
    const repo = segments[1];
    // gitlab 子组：/group/sub/repo —— repo 始终取最后两段中的 repo
    const type = detectTypeForHost(host);
    const httpsUrl = `${parsed.protocol}//${parsed.host}/${segments.join('/')}.git`;
    return { type, host, owner, repo, segments, httpsUrl };
}

/**
 * 站点 key（同 type + baseUrl 视为同一站点）。
 * @param {string} type @param {string} baseUrl
 */
export function siteKeyOf(type, baseUrl) {
    const base = type === 'github' || type === 'gitee' || type === 'gitlab'
        ? DEFAULT_BASE[type]
        : normalizeBaseUrl(baseUrl);
    return `${type}:${base.toLowerCase()}`;
}

/**
 * 从 userinfo 形式地址（https://user:token@host/...）提取凭据。
 * @returns {{ username: string, token: string, baseUrl: string, type: string } | null}
 */
export function extractUserinfo(url) {
    try {
        const parsed = new URL(String(url || '').trim());
        if (!parsed.username && !parsed.password) return null;
        return {
            username: decodeURIComponent(parsed.username || ''),
            token: decodeURIComponent(parsed.password || ''),
            baseUrl: `${parsed.protocol}//${parsed.host}`,
            type: detectTypeForHost(parsed.host.toLowerCase()),
        };
    } catch {
        return null;
    }
}
