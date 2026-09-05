import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

import { adapters, deviceFlowStart, deviceFlowPoll, getAdapter, detectTypeForHost, normalizeBaseUrl } from './auth/sites.js';
import { dirsForRequest, isAdminRequest } from './auth/identity.js';
import { agentForUrl, effectiveProxyMode, invalidateSettingsCache } from './git/proxy-http.js';
import { pluginDataDir } from './paths.js';
import { baseDirFor, installFromUrl } from './ops/install.js';
import { updateRepo, listBackups, recoverBackup } from './ops/update.js';
import { npmInstall } from './ops/deps.js';
import { diagnoseAll } from './ops/diagnose.js';
import { listDuplicates, removeLocalDuplicate, runAutoDedup } from './ops/dedup.js';
import { atomicWriteJson, dirNameFromUrl, httpError, readJsonOr, redactUrl, sanitizeDirName } from './util.js';

const DEVICE_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{ dirs: object, selfPluginDir: string, store: import('./auth/store.js').CredentialStore, registry?: string }} context
 * @returns {import('express').Router}
 */
export function createRouter(context) {
    const router = Router();
    const permits = new Map();
    /** @type {Map<string, object & { expiresAt: number }>} */
    const deviceFlows = new Map();
    const identity = context.identity || { mode: 'fallback' };

    // Lazy host-identity dispatch: resolves the real mode on first request,
    // then applies the host's user middleware (per-user dirs + admin flag).
    router.use((request, response, next) => {
        const proceed = () => {
            if (identity.mode === 'host' && identity.setUserData) {
                identity.setUserData(request, response, error => {
                    if (error) return next(error);
                    identity.requireLogin(request, response, next);
                });
                return;
            }
            next();
        };
        if (typeof identity.ensure === 'function') {
            identity.ensure().then(proceed).catch(next);
            return;
        }
        proceed();
    });

    /** True when force-override actions are restricted to admins. */
    function assertForceAllowed(request) {
        if (identity.mode === 'host' && !isAdminRequest(identity, request)) {
            throw httpError(403, '仅管理员可强制覆盖重复检测（当前登录用户非管理员）');
        }
    }

    /** Single-flight write permit per target path; busy → 409. */
    async function withPermit(key, fn) {
        if (permits.has(key)) {
            throw httpError(409, '该目录有操作正在进行中，请稍后再试');
        }
        const run = (async () => fn())();
        permits.set(key, run);
        try {
            return await run;
        } finally {
            permits.delete(key);
        }
    }

    function resolveTargetDir(target, name, dirs = context.dirs) {
        const clean = sanitizeDirName(name);
        if (!clean || clean.includes('..')) {
            throw httpError(400, '无效的扩展/插件名');
        }
        const base = baseDirFor(target, dirs);
        const dir = path.join(base, clean);
        if (path.resolve(dir) === path.resolve(context.selfPluginDir)) {
            throw httpError(400, '本插件由宿主自身的更新机制管理');
        }
        if (!fs.existsSync(dir)) {
            throw httpError(404, `目录不存在: ${clean}`);
        }
        return dir;
    }

    const wrap = handler => async (request, response) => {
        try {
            const result = await handler(request, response);
            if (result !== undefined) {
                response.json(result);
            }
        } catch (error) {
            const status = Number(error?.statusCode) || 500;
            if (status >= 500) {
                console.error('[st-git-improve]', error);
            }
            response.status(status).send(String(error?.message || error));
        }
    };

    router.get('/health', wrap(() => ({ ok: true, tavernRoot: context.tavernRoot })));

    // ---------- settings ----------
    router.get('/settings', wrap(() => ({
        proxy: effectiveProxyMode(),
        dedupGranularity: readDedupGranularity(),
        autoDedup: readJsonOr(path.join(pluginDataDir(), 'settings.json'), {}).autoDedup === true,
    })));

    router.post('/settings', wrap(async (request, response) => {
        const body = request.body || {};
        const settingsFile = path.join(pluginDataDir(), 'settings.json');
        const merged = readJsonOr(settingsFile, {});

        if (body.proxy !== undefined) {
            const proxy = String(body.proxy || 'direct').trim() || 'direct';
            if (proxy !== 'direct' && proxy !== 'env') {
                let parsed;
                try {
                    parsed = new URL(proxy);
                } catch {
                    throw httpError(400, '代理设置需为 direct、env 或 http(s):// 开头的代理地址');
                }
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    throw httpError(400, '代理地址仅支持 http/https 协议');
                }
            }
            merged.proxy = proxy;
        }

        if (body.dedupGranularity !== undefined) {
            const granularity = String(body.dedupGranularity);
            if (!['name', 'name+version'].includes(granularity)) {
                throw httpError(400, '去重颗粒度仅支持 name 或 name+version');
            }
            merged.dedupGranularity = granularity;
        }

        if (body.autoDedup !== undefined) {
            merged.autoDedup = body.autoDedup === true;
        }

        atomicWriteJson(settingsFile, merged);
        invalidateSettingsCache();
        return {
            proxy: effectiveProxyMode(),
            dedupGranularity: readDedupGranularity(),
            autoDedup: readJsonOr(settingsFile, {}).autoDedup === true,
        };
    }));

    // ---------- identity ----------
    router.get('/whoami', wrap(request => ({
        mode: identity.mode,
        authenticated: identity.mode === 'host' ? Boolean(request.user) : null,
        admin: identity.mode === 'host' ? isAdminRequest(identity, request) : null,
        handle: identity.mode === 'host' ? String(request.user?.profile?.handle || '') : '',
        canForce: identity.mode !== 'host' || isAdminRequest(identity, request),
    })));

    // ---------- credentials ----------
    router.get('/sites', wrap(() => ({ sites: context.store.listSites() })));

    router.post('/sites', wrap(async (request, response) => {
        const body = request.body || {};
        const method = String(body.method || 'pat');
        const type = String(body.type || '');

        if (method === 'userinfo') {
            const raw = String(body.url || '');
            let parsed;
            try {
                parsed = new URL(raw);
            } catch {
                throw httpError(400, 'URL 无法解析');
            }
            if (!parsed.username || !parsed.password) {
                throw httpError(400, 'URL 中未包含用户名/凭据段');
            }
            const host = parsed.host.toLowerCase();
            const detected = detectTypeForHost(host);
            const site = context.store.addSite({
                host,
                baseUrl: parsed.origin,
                type: detected || type || 'gitea',
                method: 'userinfo',
                username: decodeURIComponent(parsed.username),
                token: decodeURIComponent(parsed.password),
                note: body.note || '',
            });
            response.json({ site: context.store.sanitizeSite(site) });
            return;
        }

        if (method === 'password') {
            const adapter = getAdapter(type);
            if (!adapter.passwordExchange) {
                throw httpError(400, `${adapter.label} 不支持账号密码换 token，请使用 PAT`);
            }
            const baseUrl = normalizeBaseUrl(String(body.baseUrl || ''));
            const host = new URL(baseUrl).host.toLowerCase();
            const token = await adapter.exchangePassword({
                baseUrl,
                username: String(body.username || ''),
                password: String(body.password || ''),
            });
            const site = context.store.addSite({
                host,
                baseUrl,
                type,
                method: 'password',
                username: String(body.username || ''),
                token,
                note: body.note || '',
            });
            response.json({ site: context.store.sanitizeSite(site) });
            return;
        }

        // default: PAT
        const baseUrl = normalizeBaseUrl(String(body.baseUrl || body.url || ''));
        const host = new URL(baseUrl).host.toLowerCase();
        if (!String(body.token || '')) {
            throw httpError(400, '缺少 token');
        }
        const site = context.store.addSite({
            host,
            baseUrl,
            type: type || detectTypeForHost(host) || 'gitea',
            method: 'pat',
            username: String(body.username || ''),
            token: String(body.token),
            note: body.note || '',
        });
        response.json({ site: context.store.sanitizeSite(site) });
    }));

    router.delete('/sites/:id', wrap(async (request, response) => {
        const removed = context.store.removeSite(String(request.params.id));
        if (!removed) {
            throw httpError(404, '站点不存在');
        }
        response.json({ ok: true });
    }));

    router.post('/sites/:id/test', wrap(async (request, response) => {
        const site = context.store._load().sites.find(entry => entry.id === request.params.id);
        if (!site) {
            throw httpError(404, '站点不存在');
        }
        const adapter = getAdapter(site.type);
        const result = await adapter.testCredential({ baseUrl: site.baseUrl, token: site.token });
        response.json(result);
    }));

    // ---------- device flow ----------
    router.post('/device/start', wrap(async (request, response) => {
        const body = request.body || {};
        const adapter = getAdapter(String(body.type || ''));
        if (!adapter.deviceFlow) {
            throw httpError(400, `${adapter.label} 不支持设备码登录`);
        }
        const endpoints = adapter.deviceFlowEndpoints({ baseUrl: body.baseUrl });
        const state = await deviceFlowStart(endpoints);
        const flowId = `flow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        deviceFlows.set(flowId, { ...state, expiresAt: Date.now() + state.expiresIn * 1000 });
        response.json({
            flowId,
            userCode: state.userCode,
            verifyUrl: state.verifyUrl,
            verifyUrlComplete: state.verifyUrlComplete,
            interval: state.interval,
        });
    }));

    router.post('/device/poll', wrap(async (request, response) => {
        const flowId = String(request.body?.flowId || '');
        const state = deviceFlows.get(flowId);
        if (!state) {
            throw httpError(404, '设备码流程不存在或已过期，请重新发起');
        }
        if (Date.now() > state.expiresAt) {
            deviceFlows.delete(flowId);
            return { status: 'expired' };
        }
        const result = await deviceFlowPoll({ state });
        if (result.status === 'granted') {
            deviceFlows.delete(flowId);
            const body = request.body || {};
            const baseUrl = normalizeBaseUrl(String(body.baseUrl || ''));
            const host = new URL(baseUrl).host.toLowerCase();
            const site = context.store.addSite({
                host,
                baseUrl,
                type: String(body.type || ''),
                method: 'device',
                username: String(body.username || ''),
                token: result.token,
                note: body.note || '',
            });
            return { status: 'granted', site: context.store.sanitizeSite(site) };
        }
        if (result.status === 'expired') {
            deviceFlows.delete(flowId);
        }
        return result;
    }));

    // ---------- operations ----------
    router.post('/install', wrap(async (request, response) => {
        const body = request.body || {};
        const url = String(body.url || '');
        const target = String(body.target || 'extension');
        const name = dirNameFromUrl(url);
        const base = baseDirFor(target, context.dirs);
        const targetPath = path.join(base, sanitizeDirName(name));
        if (body.force === true) {
            assertForceAllowed(request);
        }
        const dirs = dirsForRequest(identity, request, context.dirs);
        return withPermit(targetPath, () => installFromUrl({
            url,
            branch: body.branch ? String(body.branch) : undefined,
            target,
            dirs,
            authResolver: context.store.authResolverForUrl(normalizeForAuth(url)),
            registry: context.registry,
            replace: body.replace === true,
            force: body.force === true,
            dedupGranularity: readDedupGranularity(),
            log: line => console.info(`[st-git-improve] ${line}`),
        }));
    }));

    router.post('/update', wrap(async (request, response) => {
        const body = request.body || {};
        const dirs = dirsForRequest(identity, request, context.dirs);
        const dir = resolveTargetDir(String(body.target || ''), String(body.name || ''), dirs);
        return withPermit(dir, () => updateRepo({
            dir,
            registry: context.registry,
            runDeps: String(body.target || '') === 'plugin',
            log: line => console.info(`[st-git-improve] ${line}`),
        }));
    }));

    router.post('/deps', wrap(async (request, response) => {
        const body = request.body || {};
        const dirs = dirsForRequest(identity, request, context.dirs);
        const dir = body.preset === 'tavern'
            ? context.tavernRoot
            : resolveTargetDir(String(body.target || ''), String(body.name || ''), dirs);
        return withPermit(dir, () => npmInstall({
            dir,
            rebuildLock: body.rebuildLock === true,
            registry: context.registry,
            log: line => console.info(`[st-git-improve] ${line}`),
        }));
    }));

    router.post('/recover', wrap(async (request, response) => {
        const body = request.body || {};
        const dirs = dirsForRequest(identity, request, context.dirs);
        const dir = resolveTargetDir(String(body.target || ''), String(body.name || ''), dirs);
        return withPermit(dir, () => recoverBackup({
            dir,
            backupRef: String(body.backupRef || ''),
        }));
    }));

    router.get('/backups', wrap(async (request, response) => {
        const dirs = dirsForRequest(identity, request, context.dirs);
        const dir = resolveTargetDir(String(request.query.target || ''), String(request.query.name || ''), dirs);
        return { backups: await listBackups({ dir }) };
    }));

    router.get('/diagnose', wrap(async (request, response) => {
        const remoteProbe = request.query.remote === '1';
        const dirs = dirsForRequest(identity, request, context.dirs);
        return { entries: await diagnoseAll({
            dirs,
            selfPluginDir: context.selfPluginDir,
            store: context.store,
            remoteProbe,
        }) };
    }));

    // ---------- dedup ----------
    router.get('/dedup', wrap(async (request, response) => {
        const dirs = dirsForRequest(identity, request, context.dirs);
        return { duplicates: await listDuplicates({ dirs }) };
    }));

    router.delete('/dedup', wrap(async (request, response) => {
        const body = request.body || {};
        const clean = sanitizeDirName(String(body.name || ''));
        if (!clean) {
            throw httpError(400, '无效的扩展名');
        }
        if (body.force === true) {
            assertForceAllowed(request);
        }
        const dirs = dirsForRequest(identity, request, context.dirs);
        const targetPath = path.join(dirs.localExtensionsDir, clean);
        return withPermit(targetPath, () => removeLocalDuplicate({
            name: clean,
            force: body.force === true,
            dirs,
        }));
    }));

    router.post('/dedup/auto', wrap(async (request, response) => {
        assertForceAllowed(request);
        const dirs = dirsForRequest(identity, request, context.dirs);
        return withPermit(dirs.localExtensionsDir, () => runAutoDedup({ dirs }));
    }));

    return router;
}

/** @param {string} url */
function normalizeForAuth(url) {
    return url;
}

/** Dedup granularity from settings.json ('name' | 'name+version'), default 'name'. */
function readDedupGranularity() {
    const data = readJsonOr(path.join(pluginDataDir(), 'settings.json'), {});
    return data.dedupGranularity === 'name+version' ? 'name+version' : 'name';
}
