/**
 * Site adapters: one implementation per git hosting type. Each adapter knows
 * how to mint/validate tokens and (when supported) run the OAuth2 device flow
 * (RFC 8628). Credential entry paths: PAT, password exchange, device flow,
 * userinfo URL extraction (generic, in routes).
 */

const CLIENT_ID_ENV = {
    github: 'ST_GIT_IMPROVE_GITHUB_CLIENT_ID',
    gitlab: 'ST_GIT_IMPROVE_GITLAB_CLIENT_ID',
};

/** @param {string} baseUrl */
function trimBase(baseUrl) {
    return String(baseUrl || '').replace(/\/+$/, '');
}

/** @param {string} baseUrl */
export function normalizeBaseUrl(baseUrl) {
    const raw = trimBase(baseUrl);
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('站点地址仅支持 http/https');
    }
    return parsed.origin + (parsed.pathname.replace(/\/+$/, '') || '');
}

/** @param {string} name */
export function clientIdFor(name) {
    return String(process.env[CLIENT_ID_ENV[name]] || '');
}

/**
 * Generic RFC 8628 device-authorization helper.
 * @param {{ deviceCodeUrl: string, tokenUrl: string, clientId: string, scope?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ deviceCode: string, userCode: string, verifyUrl: string, verifyUrlComplete?: string, interval: number, expiresIn: number }>}
 */
export async function deviceFlowStart({ deviceCodeUrl, tokenUrl, clientId, scope, signal }) {
    if (!clientId) {
        const error = new Error('设备码流程未配置 OAuth client_id（见 README 环境变量说明）');
        // @ts-ignore
        error.statusCode = 400;
        throw error;
    }
    const body = new URLSearchParams({ client_id: clientId });
    if (scope) {
        body.set('scope', scope);
    }
    const response = await fetch(deviceCodeUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.device_code) {
        throw new Error(`设备码申请失败: ${payload.error_description || payload.error || response.status}`);
    }
    return {
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        verifyUrl: payload.verification_uri,
        verifyUrlComplete: payload.verification_uri_complete || '',
        interval: Number(payload.interval || 5),
        expiresIn: Number(payload.expires_in || 600),
        _tokenUrl: tokenUrl,
        _clientId: clientId,
    };
}

/**
 * One poll step. Returns {status:'pending'} until the user approves.
 * @param {{ state: { deviceCode: string, _tokenUrl: string, _clientId: string } }} options
 * @returns {Promise<{ status: 'pending' | 'granted' | 'expired', token?: string }>}
 */
export async function deviceFlowPoll({ state }) {
    const body = new URLSearchParams({
        client_id: state._clientId,
        device_code: state.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const response = await fetch(state._tokenUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.access_token) {
        return { status: 'granted', token: payload.access_token };
    }
    const err = String(payload.error || payload.error_description || '');
    if (err.includes('authorization_pending')) {
        return { status: 'pending' };
    }
    if (err.includes('slow_down')) {
        return { status: 'pending' };
    }
    if (err.includes('expired') || err.includes('expire')) {
        return { status: 'expired' };
    }
    if (err.includes('access_denied')) {
        return { status: 'expired' };
    }
    throw new Error(`设备码轮询失败: ${err || response.status}`);
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} [init]
 */
async function jsonRequest(url, init = {}) {
    const response = await fetch(url, {
        method: init.method || 'GET',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
        body: init.body,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

export const adapters = {
    gitea: {
        id: 'gitea',
        label: 'Gitea / Forgejo（含自建）',
        passwordExchange: true,
        deviceFlow: false,
        requiresBaseUrl: true,
        /** @param {string} host */
        detect(host) {
            return false; // self-hosted: type chosen explicitly by the user
        },
        /**
         * Mint a token with basic auth (Gitea/Forgejo API).
         * @param {{ baseUrl: string, username: string, password: string }} options
         */
        async exchangePassword({ baseUrl, username, password }) {
            const base = normalizeBaseUrl(baseUrl);
            const tokenName = `st-git-improve-${Date.now()}`;
            const { response, payload } = await jsonRequest(`${base}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
                method: 'POST',
                headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
                body: JSON.stringify({ name: tokenName, scopes: ['read:repository'] }),
            });
            if (!response.ok && response.status === 422) {
                // older Gitea without scopes support
                const retry = await jsonRequest(`${base}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
                    method: 'POST',
                    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
                    body: JSON.stringify({ name: `${tokenName}-${Math.floor(Math.random() * 1e6)}` }),
                });
                if (!retry.response.ok) {
                    throw new Error(`Gitea token 铸造失败: ${retry.response.status} ${JSON.stringify(retry.payload).slice(0, 200)}`);
                }
                return retry.payload.sha1;
            }
            if (!response.ok) {
                throw new Error(`Gitea token 铸造失败: ${response.status}（检查账号密码或权限）`);
            }
            return payload.sha1;
        },
        /** @param {{ baseUrl: string, token: string }} options */
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
        passwordExchange: false,
        deviceFlow: true,
        requiresBaseUrl: false,
        /** @param {string} host */
        detect(host) {
            return host === 'github.com' || host.endsWith('.github.com');
        },
        /** @param {{ baseUrl?: string }} [options] */
        deviceFlowEndpoints({ baseUrl } = {}) {
            return {
                deviceCodeUrl: 'https://github.com/login/device/code',
                tokenUrl: 'https://github.com/login/oauth/access_token',
                clientId: clientIdFor('github'),
                scope: 'repo',
            };
        },
        /** @param {{ token: string }} options */
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
        passwordExchange: false,
        deviceFlow: true,
        requiresBaseUrl: false,
        /** @param {string} host */
        detect(host) {
            return host === 'gitlab.com' || host.endsWith('.gitlab.com');
        },
        /** @param {{ baseUrl?: string }} [options] */
        deviceFlowEndpoints({ baseUrl } = {}) {
            const base = baseUrl ? normalizeBaseUrl(baseUrl) : 'https://gitlab.com';
            return {
                deviceCodeUrl: `${base}/oauth/device/authorize`,
                tokenUrl: `${base}/oauth/token`,
                clientId: clientIdFor('gitlab'),
                scope: 'read_repository read_api',
            };
        },
        /** @param {{ baseUrl?: string, token: string }} options */
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
        passwordExchange: false,
        deviceFlow: false,
        requiresBaseUrl: false,
        /** @param {string} host */
        detect(host) {
            return host === 'gitee.com' || host.endsWith('.gitee.com');
        },
        /** @param {{ token: string }} options */
        async testCredential({ token }) {
            const { response, payload } = await jsonRequest(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
            return { ok: response.ok, login: payload.login || '', status: response.status };
        },
    },
};

/** @param {string} type */
export function getAdapter(type) {
    const adapter = adapters[String(type || '')];
    if (!adapter) {
        throw new Error(`未知站点类型: ${type}`);
    }
    return adapter;
}

/** @param {string} host */
export function detectTypeForHost(host) {
    for (const adapter of Object.values(adapters)) {
        if (adapter.detect(host)) {
            return adapter.id;
        }
    }
    return '';
}
