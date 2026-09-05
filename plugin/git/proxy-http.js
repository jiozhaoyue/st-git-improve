import path from 'node:path';

import httpProxyAgent from 'http-proxy-agent';
import httpsProxyAgent from 'https-proxy-agent';
import { request as stockRequest } from 'isomorphic-git/http/node';

import { readJsonOr } from '../util.js';
import { pluginDataDir } from '../paths.js';

/**
 * Explicit proxy switch for all git HTTP traffic.
 *
 * Resolution order (first wins):
 *   1. ST_GIT_IMPROVE_PROXY env var
 *   2. settings.json "proxy" value (UI 设置页写入)
 *   3. 'direct' (default — zero environment dependence)
 *
 * Modes:
 *   - 'direct'  no proxy, connect directly
 *   - 'env'     follow HTTP(S)_PROXY / ALL_PROXY (+ NO_PROXY, loopback exempt)
 *   - '<url>'   custom proxy URL — applied to ALL targets, including loopback
 */

const SETTINGS_TTL_MS = 1000;
const settingsFile = () => path.join(pluginDataDir(), 'settings.json');

let settingsCache = { value: null, expiresAt: 0 };

/** @returns {{ proxy: string }} */
function readSettings() {
    const now = Date.now();
    if (settingsCache.value && now < settingsCache.expiresAt) {
        return settingsCache.value;
    }
    const data = readJsonOr(settingsFile(), {});
    const value = { proxy: typeof data.proxy === 'string' ? data.proxy : '' };
    settingsCache = { value, expiresAt: now + SETTINGS_TTL_MS };
    return value;
}

/** Invalidate cached settings after a write. */
export function invalidateSettingsCache() {
    settingsCache = { value: null, expiresAt: 0 };
}

/**
 * Effective proxy mode string ('direct' | 'env' | '<proxy-url>').
 * @returns {string}
 */
export function effectiveProxyMode() {
    const fromEnv = String(process.env.ST_GIT_IMPROVE_PROXY || '').trim();
    if (fromEnv) {
        return fromEnv;
    }
    const fromSettings = readSettings().proxy.trim();
    if (fromSettings) {
        return fromSettings;
    }
    return 'direct';
}

/** @param {string} host */
function isLoopbackHost(host) {
    const bare = String(host || '').toLowerCase();
    return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '[::1]';
}

/**
 * Proxy URL from environment for a target protocol, honoring NO_PROXY.
 * @param {URL} targetUrl
 */
function envProxyFor(targetUrl) {
    const isHttps = targetUrl.protocol === 'https:';
    const candidate = isHttps
        ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy)
        : (process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
    if (!candidate) {
        return '';
    }
    const targetHost = targetUrl.hostname.toLowerCase();
    if (isLoopbackHost(targetHost)) {
        return '';
    }
    const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
    for (const entry of noProxy) {
        if (entry === '*' || targetHost === entry || targetHost.endsWith(entry.startsWith('.') ? entry : `.${entry}`)) {
            return '';
        }
    }
    return candidate;
}

/**
 * Build the agent for a git HTTP request, or undefined for direct.
 * @param {string} url
 * @returns {import('http').Agent | undefined}
 */
export function agentForUrl(url) {
    const mode = effectiveProxyMode();
    if (mode === 'direct' || !mode) {
        return undefined;
    }

    let target;
    try {
        target = new URL(url);
    } catch {
        return undefined;
    }

    let proxyUrl = '';
    if (mode === 'env') {
        proxyUrl = envProxyFor(target);
    } else {
        // explicit URL mode: applies to every target, loopback included
        proxyUrl = mode;
    }
    if (!proxyUrl) {
        return undefined;
    }

    return target.protocol === 'https:'
        ? new httpsProxyAgent.HttpsProxyAgent(proxyUrl)
        : new httpProxyAgent.HttpProxyAgent(proxyUrl);
}

/**
 * isomorphic-git HttpClient that injects the proxy agent per request.
 * Delegates the actual wire work to the stock node http client.
 * @returns {{ request: (options: object) => Promise<object> }}
 */
export function createHttpClient() {
    return {
        async request(gitRequest) {
            const agent = agentForUrl(gitRequest.url);
            return stockRequest({ ...gitRequest, agent });
        },
    };
}
