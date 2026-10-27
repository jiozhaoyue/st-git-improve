// 多账号存储：每个 git 站点可以逐个登录多个账号，凭据保存在浏览器侧
// （宿主设置/localStorage，见 storage.js），并可指定每个站点的默认账号。
// 纯逻辑、无 DOM 依赖 —— 存储适配器由外部注入，可直接单测。

// 版本参数：与 manifest.json version 同步（宿主 HTTP 缓存破坏），见 index.js 说明。
const V = '0.7.6';

const { getAdapter, parseRepoUrl, siteKeyOf, extractUserinfo, defaultBaseUrl, normalizeBaseUrl } =
    await import(`./sites.js?v=${V}`);

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function uid() {
    return `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyState() {
    return {
        version: 1,
        accounts: [],       // { id, type, baseUrl, username, token, method, note, createdAt, lastCheckedAt, lastCheckOk, lastLogin }
        defaults: {},       // siteKey → accountId
    };
}

export class AccountStore {
    /**
     * @param {{ load: () => Promise<any>, save: (state:any) => Promise<boolean> }} storage
     */
    constructor(storage) {
        this.storage = storage;
        /** @type {any} */
        this.state = emptyState();
        this.loaded = false;
    }

    async load() {
        const persisted = await this.storage.load().catch(() => null);
        if (persisted && Array.isArray(persisted.accounts)) {
            this.state = {
                version: 1,
                accounts: persisted.accounts,
                defaults: persisted.defaults && typeof persisted.defaults === 'object' ? persisted.defaults : {},
            };
        } else {
            this.state = emptyState();
        }
        this.loaded = true;
        return this.snapshot();
    }

    async save() {
        await this.storage.save(this.state);
        return this.snapshot();
    }

    snapshot() {
        return {
            accounts: this.state.accounts.map(a => ({ ...a })),
            defaults: { ...this.state.defaults },
        };
    }

    /** 站点下的全部账号（siteKey = type:baseUrl）。 */
    accountsFor(siteKey) {
        return this.state.accounts.filter(a => siteKeyOf(a.type, a.baseUrl) === siteKey);
    }

    findAccount(id) {
        return this.state.accounts.find(a => a.id === id) || null;
    }

    /**
     * 添加账号（一次一个）。同站点同用户名视为重复，除非 replaceExisting。
     * @param {{ type: string, baseUrl?: string, username?: string, token: string, method?: string, note?: string, makeDefault?: boolean, replaceExisting?: boolean }} input
     */
    async addAccount(input) {
        const type = String(input.type || '');
        const adapter = getAdapter(type);
        const baseUrl = adapter.requiresBaseUrl ? normalizeBaseUrl(input.baseUrl) : (input.baseUrl ? normalizeBaseUrl(input.baseUrl) : defaultBaseUrl(type));
        if (adapter.requiresBaseUrl && !baseUrl) throw new Error('该站点类型需要填写站点地址');
        const token = String(input.token || '').trim();
        if (!token) throw new Error('访问令牌 (PAT) 为空');
        const username = String(input.username || '').trim();
        const siteKey = siteKeyOf(type, baseUrl);
        const existing = this.accountsFor(siteKey).find(a => (a.username || '') === username);
        if (existing && !input.replaceExisting) {
            throw new Error(`该站点已存在同名账号「${username || '(匿名)'}」，请先删除或改用替换`);
        }
        if (existing) {
            // 替换：更新既有账号
            existing.token = token;
            existing.method = input.method || existing.method || 'pat';
            existing.note = input.note ?? existing.note;
            existing.lastCheckedAt = 0;
            existing.lastCheckOk = false;
            existing.lastLogin = '';
            if (input.makeDefault || this.state.defaults[siteKey] === existing.id) {
                this.state.defaults[siteKey] = existing.id;
            }
            await this.save();
            return { account: { ...existing }, siteKey };
        }
        const account = {
            id: uid(),
            type,
            baseUrl,
            username,
            token,
            method: input.method || 'pat',
            note: String(input.note || ''),
            createdAt: nowSec(),
            lastCheckedAt: 0,
            lastCheckOk: false,
            lastLogin: '',
        };
        this.state.accounts.push(account);
        // 第一个账号自动成为该站点默认；显式 makeDefault 覆盖。
        if (input.makeDefault || !this.state.defaults[siteKey]) {
            this.state.defaults[siteKey] = account.id;
        }
        await this.save();
        return { account: { ...account }, siteKey };
    }

    /** 从 userinfo 形式地址（https://user:token@host/...）提取并保存。 */
    async addFromUserinfoUrl(url, { makeDefault = true, replaceExisting = false } = {}) {
        const extracted = extractUserinfo(url);
        if (!extracted) throw new Error('地址中没有 user:token 部分');
        const type = extracted.type;
        if (!type) throw new Error(`无法识别站点类型（host: ${extracted.host}），请手动选择类型添加`);
        return this.addAccount({
            type,
            baseUrl: extracted.baseUrl,
            username: extracted.username,
            token: extracted.token,
            method: 'userinfo',
            makeDefault,
            replaceExisting,
        });
    }

    async setDefault(siteKey, accountId) {
        if (!this.findAccount(accountId)) throw new Error('账号不存在');
        this.state.defaults[siteKey] = accountId;
        await this.save();
        return this.snapshot();
    }

    async removeAccount(accountId) {
        const index = this.state.accounts.findIndex(a => a.id === accountId);
        if (index < 0) throw new Error('账号不存在');
        const [removed] = this.state.accounts.splice(index, 1);
        for (const [siteKey, id] of Object.entries(this.state.defaults)) {
            if (id === accountId) {
                const rest = this.accountsFor(siteKey);
                if (rest.length > 0) this.state.defaults[siteKey] = rest[0].id;
                else delete this.state.defaults[siteKey];
            }
        }
        await this.save();
        return { ...removed };
    }

    /** 验证凭据（浏览器直连站点 API）。返回 { ok, login, status } 或抛 blockedByBrowser。 */
    async testAccount(accountId) {
        const account = this.findAccount(accountId);
        if (!account) throw new Error('账号不存在');
        const adapter = getAdapter(account.type);
        const result = await adapter.testCredential({ baseUrl: account.baseUrl, token: account.token, username: account.username });
        account.lastCheckedAt = nowSec();
        account.lastCheckOk = result.ok === true;
        account.lastLogin = result.login || account.username || '';
        await this.save();
        return result;
    }

    /**
     * 给定仓库 URL，解析站点并返回默认账号的 git 凭据。
     * @returns {Promise<{ siteKey: string, account: any | null, auth: { username: string, password: string } | null }>}
     */
    async credentialsFor(repoUrl) {
        const { host } = parseRepoUrl(repoUrl);
        // host 匹配：优先精确 siteKey（type 由 host 推断）
        const inferredType = this._inferType(host);
        const siteKey = this._siteKeyByHost(host);
        if (!siteKey) {
            return { siteKey: '', account: null, auth: null };
        }
        const accounts = this.accountsFor(siteKey);
        if (accounts.length === 0) return { siteKey, account: null, auth: null };
        const defaultId = this.state.defaults[siteKey];
        const account = accounts.find(a => a.id === defaultId) || accounts[0];
        void inferredType;
        return {
            siteKey,
            account: { ...account, token: undefined },
            auth: { username: account.username || account.token, password: account.token },
        };
    }

    _inferType(host) {
        try {
            return getAdapter('github').detect(host) ? 'github'
                : getAdapter('gitlab').detect(host) ? 'gitlab'
                    : getAdapter('gitee').detect(host) ? 'gitee' : '';
        } catch {
            return '';
        }
    }

    _siteKeyByHost(host) {
        const keys = new Set(this.state.accounts.map(a => siteKeyOf(a.type, a.baseUrl)));
        // 精确匹配 type:host
        for (const type of ['github', 'gitlab', 'gitee']) {
            const candidate = `${type}:https://${host}`;
            if (keys.has(candidate)) return candidate;
        }
        // 自建站点：baseUrl 的 host 匹配
        for (const key of keys) {
            const base = key.slice(key.indexOf(':https://') + 1);
            try {
                if (new URL(base).host.toLowerCase() === host) return key;
            } catch { /* 忽略畸形 key */ }
        }
        return '';
    }
}

let shared = null;
/** 面板共享实例（惰性创建，storage 自动选通道）。 */
export async function getSharedStore() {
    if (!shared) {
        const { createStorage } = await import(`./storage.js?v=${V}`);
        shared = new AccountStore(createStorage());
        await shared.load();
    }
    return shared;
}

export function createStoreForTesting(storage) {
    return new AccountStore(storage);
}
