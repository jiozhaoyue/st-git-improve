// 路由级测试共享助手：用最小上下文挂载 createRouter 并起临时 HTTP 服务。
import path from 'node:path';
import express from 'express';

import { createRouter } from '../../plugin/routes.js';

/**
 * @param {string} fixtureRoot 临时根目录（dirs 全指到这里）
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export async function startRouteApp(fixtureRoot) {
    const app = express();
    app.use('/api/plugins/st-git-improve', createRouter({
        dirs: {
            localExtensionsDir: path.join(fixtureRoot, 'ext'),
            globalExtensionsDir: path.join(fixtureRoot, 'global'),
            pluginsDir: path.join(fixtureRoot, 'plugins'),
            selfPluginDir: path.join(fixtureRoot, 'self'),
        },
        selfPluginDir: path.join(fixtureRoot, 'self'),
        tavernRoot: fixtureRoot,
        store: { authResolverForUrl: () => undefined },
        identity: { mode: 'fallback' },
        panelVersions: { bundled: '9.9.9', installed: '' },
    }));
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}/api/plugins/st-git-improve`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
