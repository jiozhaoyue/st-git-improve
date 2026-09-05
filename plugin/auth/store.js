import crypto from 'node:crypto';

import { atomicWriteJson, readJsonOr, redactUrl } from '../util.js';

/**
 * Site credential record:
 * { id, host, baseUrl, type, method, username?, token?, note?, createdAt }
 *  - type:    github | gitlab | gitea | forgejo | gitee
 *  - method:  pat | password | device | userinfo
 * Token is stored at rest in the user's local data directory only; it is never
 * written into URLs or .git/config.
 */

const FILE_NAME = 'credentials.json';

export class CredentialStore {
    /** @param {string} filePath */
    constructor(filePath) {
        this.filePath = filePath;
    }

    _load() {
        const data = readJsonOr(this.filePath, { version: 1, sites: [] });
        if (!Array.isArray(data.sites)) {
            data.sites = [];
        }
        return data;
    }

    /** @param {object} data */
    _save(data) {
        atomicWriteJson(this.filePath, data);
    }

    /**
     * @param {object} site partial record, host required
     * @returns {object} the saved record (token included server-side only)
     */
    addSite(site) {
        if (!site || typeof site.host !== 'string' || !site.host) {
            throw new Error('host is required');
        }
        const data = this._load();
        const record = {
            id: crypto.randomUUID(),
            host: site.host.toLowerCase(),
            baseUrl: redactUrl(site.baseUrl || `https://${site.host}`),
            type: String(site.type || 'gitea'),
            method: String(site.method || 'pat'),
            username: site.username ? String(site.username) : '',
            token: site.token ? String(site.token) : '',
            note: site.note ? String(site.note) : '',
            createdAt: new Date().toISOString(),
        };
        // One credential per host+username pair; replace existing entry.
        data.sites = data.sites.filter(existing =>
            !(existing.host === record.host && existing.username === record.username));
        data.sites.push(record);
        this._save(data);
        return record;
    }

    /** @param {string} id @param {string} token */
    updateToken(id, token) {
        const data = this._load();
        const site = data.sites.find(entry => entry.id === id);
        if (!site) {
            throw new Error('site not found');
        }
        site.token = String(token);
        this._save(data);
        return site;
    }

    /** @param {string} id */
    removeSite(id) {
        const data = this._load();
        const before = data.sites.length;
        data.sites = data.sites.filter(entry => entry.id !== id);
        this._save(data);
        return data.sites.length < before;
    }

    /** @returns {Array<object>} sanitized list (no tokens) */
    listSites() {
        return this._load().sites.map(site => this.sanitizeSite(site));
    }

    /** @param {object} site */
    sanitizeSite(site) {
        const { token, ...rest } = site;
        return { ...rest, hasToken: Boolean(token) };
    }

    /**
     * Find the first credential whose host matches the URL's host.
     * @param {string} url
     * @returns {object | undefined} full record with token (internal use)
     */
    findForUrl(url) {
        let host = '';
        try {
            host = new URL(String(url)).host.toLowerCase();
        } catch {
            return undefined;
        }
        return this._load().sites.find(site => site.host === host && site.token);
    }

    /**
     * Build an AuthResolver for isomorphic-git: basic auth with the token as
     * password. Token stays in memory only.
     * @param {string} url
     * @returns {(() => ({ username: string, password: string }) | undefined)}
     */
    authResolverForUrl(url) {
        return () => {
            const site = this.findForUrl(url);
            if (!site) {
                return undefined;
            }
            const username = defaultAuthUsername(site);
            return { username, password: site.token };
        };
    }
}

/**
 * Username conventions per host type for HTTP basic auth with tokens.
 * @param {object} site
 * @returns {string}
 */
export function defaultAuthUsername(site) {
    if (site.username) {
        return site.username;
    }
    switch (site.type) {
        case 'github':
            return 'x-access-token';
        case 'gitlab':
        case 'gitee':
            return 'oauth2';
        default:
            return 'oauth2';
    }
}

export { redactUrl };
