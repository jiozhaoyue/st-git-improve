// 纯前端安装编排：浏览器内克隆 → 读 manifest → 交给宿主原生安装通道。
// 认证策略：仓库凭据从账号库取出，以 user:token@host 形式交给宿主自己的
// /api/extensions/install（服务端 git 克隆可识别内嵌凭据，私有仓库即可安装）。
// 额外能力：克隆结果可导出为 zip（buildZipBytes），供本地备份/手动上传。

import { parseRepoUrl } from './sites.js';
import { cloneToMemory } from './gitbrowser.js';
import { buildZip } from './zip.js';

/**
 * 由仓库地址 + 凭据构造内嵌认证的 https URL。
 * @param {string} repoUrl @param {{ username: string, password: string }} auth
 */
export function buildAuthedUrl(repoUrl, auth) {
    const { httpsUrl } = parseRepoUrl(repoUrl);
    if (!auth) return httpsUrl;
    const parsed = new URL(httpsUrl);
    const user = encodeURIComponent(auth.username || auth.password);
    const pass = encodeURIComponent(auth.password);
    return `${parsed.protocol}//${user}:${pass}@${parsed.host}${parsed.pathname}`;
}

/**
 * 纯前端安装：克隆（内存）→ 识别 manifest → 宿主原生安装。
 * @param {{ url: string, branch?: string, target?: 'extension'|'global', replace?: boolean,
 *          accounts: import('./accounts.js').AccountStore, onLog?: (line: string) => void }} options
 * @returns {Promise<{ name: string, oid: string, mode: 'host-native' | 'authed-url', note?: string }>}
 */
export async function pureInstall({ url, branch, target = 'extension', accounts, onLog }) {
    const log = onLog || (() => { });
    const repo = parseRepoUrl(url);
    const credential = await accounts.credentialsFor(url);
    const auth = credential?.auth || null;
    if (!auth) {
        log('该站点没有已保存账号 —— 按公开仓库尝试（私有仓库请先在「账号」页登录）');
    }

    const cloned = await cloneToMemory({
        url: repo.httpsUrl,
        branch: branch || undefined,
        auth,
        onLog: log,
    });

    const manifestText = cloned.textFile('manifest.json');
    let name = repo.repo;
    if (manifestText) {
        try {
            const manifest = JSON.parse(manifestText);
            if (manifest.display_name) name = String(manifest.display_name);
        } catch {
            log('manifest.json 不是合法 JSON —— 按仓库名继续');
        }
    }

    // 宿主原生安装：内嵌凭据 URL，服务端克隆。
    const authedUrl = buildAuthedUrl(url, auth);
    const { hostNativeInstall } = await import('./backend.js');
    log('交给宿主原生安装通道…');
    const result = await hostNativeInstall({
        authedUrl,
        global: target === 'global',
        branch: branch || undefined,
    });
    if (!result.ok) {
        const detail = result.data?.error || result.data?.raw || `HTTP ${result.status}`;
        throw new Error(`宿主安装失败: ${detail}`);
    }
    log('安装完成，刷新页面后生效');
    return { name, oid: cloned.oid, mode: 'host-native', note: result.data?.message || '', cloned };
}

/** 克隆结果打包为 zip 字节（跳过 .git）。 */
export function buildZipBytes(cloned) {
    const entries = [];
    for (const [path, data] of cloned.files) {
        if (path.startsWith('.git/')) continue;
        entries.push({ path, data });
    }
    return buildZip(entries);
}
