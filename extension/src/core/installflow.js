// 纯前端安装编排：浏览器内克隆 → 读 manifest → 交给宿主原生安装通道。
// 认证策略：仓库凭据从账号库取出，以 user:token@host 形式交给宿主自己的
// /api/extensions/install（服务端 git 克隆可识别内嵌凭据，私有仓库即可安装）。
// 额外能力：克隆结果可导出为 zip（buildZipBytes），供本地备份/手动上传。

// 版本参数：与 manifest.json version 同步（宿主 HTTP 缓存破坏），见 index.js 说明。
const V = '0.8.3';

const { parseRepoUrl } = await import(`./sites.js?v=${V}`);
const { cloneToMemory } = await import(`./gitbrowser.js?v=${V}`);
const { buildZip } = await import(`./zip.js?v=${V}`);

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
 * 预检：仓库存在性 + 凭据可用性（走各站点 API，主流站点的 API 支持 CORS）。
 * 失败（含 CORS/网络）一律静默放行 —— 预检只是提前给出清晰错误，不拦截安装。
 * @returns {Promise<{ ok: boolean | null, status?: number, login?: string, note: string }>}
 */
export async function preflightAccessible(repoUrl, auth) {
    let repo;
    try {
        repo = parseRepoUrl(repoUrl);
    } catch (error) {
        return { ok: false, note: error.message || String(error) };
    }
    try {
        let url;
        let headers = {};
        if (repo.type === 'github') {
            url = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
            if (auth) headers = { Authorization: `Bearer ${auth.password}`, 'User-Agent': 'st-git-improve' };
        } else if (repo.type === 'gitlab') {
            const base = repo.host === 'gitlab.com' ? 'https://gitlab.com' : `${repo.httpsUrl.split('/').slice(0, 3).join('/')}`;
            url = `${base}/api/v4/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`;
            if (auth) headers = { Authorization: `Bearer ${auth.password}` };
        } else if (repo.type === 'gitea') {
            const base = repo.httpsUrl.split('/').slice(0, 3).join('/');
            url = `${base}/api/v1/repos/${repo.owner}/${repo.repo}`;
            if (auth) headers = { Authorization: `token ${auth.password}` };
        } else if (repo.type === 'gitee') {
            url = `https://gitee.com/api/v5/repos/${repo.owner}/${repo.repo}`;
        } else {
            return { ok: null, note: '未知站点类型，跳过预检' };
        }
        const response = await fetch(url, { headers, Accept: 'application/json' });
        if (response.ok) {
            return { ok: true, status: response.status, note: '仓库可达' };
        }
        if (response.status === 401) {
            return { ok: false, status: 401, note: '凭据无效（401）——请到「账号」页更新该站点凭据' };
        }
        if (response.status === 404) {
            return {
                ok: false,
                status: 404,
                note: auth
                    ? '仓库不存在或该账号无权访问（404）——确认仓库地址与账号权限'
                    : '仓库不存在或为私有仓库（404）——私有仓库请先在「账号」页登录该站点',
            };
        }
        return { ok: null, status: response.status, note: `预检 HTTP ${response.status}（不阻断）` };
    } catch {
        return { ok: null, note: '预检不可达（CORS/网络），跳过 —— 以实际安装结果为准' };
    }
}

/**
 * 纯前端安装：预检 → 宿主原生安装（内嵌凭据 URL，服务端克隆）。
 * 浏览器内克隆（isomorphic-git）仅作增强：成功时提供 manifest 识别与 zip 导出；
 * 因 GitHub 等 git 端点不发 CORS 头，克隆失败**不阻断安装**（L0-11 降级）。
 * @param {{ url: string, branch?: string, target?: 'extension'|'global', replace?: boolean,
 *          accounts: import('./accounts.js').AccountStore, onLog?: (line: string) => void }} options
 * @returns {Promise<{ name: string, oid: string, mode: 'host-native', note?: string, cloned?: object }>}
 */
export async function pureInstall({ url, branch, target = 'extension', replace = false, accounts, onLog }) {
    const log = onLog || (() => { });
    const repo = parseRepoUrl(url);
    const credential = await accounts.credentialsFor(url);
    const auth = credential?.auth || null;
    if (!auth) {
        log('该站点没有已保存账号 —— 按公开仓库尝试（私有仓库请先在「账号」页登录）');
    }

    // 预检（API 支持 CORS，可提前给出清晰错误）
    const preflight = await preflightAccessible(url, auth);
    log(`预检: ${preflight.note}`);
    if (preflight.ok === false) {
        throw new Error(preflight.note);
    }

    // 增强路径：浏览器内克隆（失败不阻断）
    let cloned;
    try {
        cloned = await cloneToMemory({
            url: repo.httpsUrl,
            branch: branch || undefined,
            auth,
            onLog: log,
        });
    } catch (error) {
        log(`浏览器内克隆不可用（${String(error.message || error).slice(0, 120)}）——安装不受影响`);
    }

    let name = repo.repo;
    if (cloned?.textFile) {
        const manifestText = cloned.textFile('manifest.json');
        if (manifestText) {
            try {
                const manifest = JSON.parse(manifestText);
                if (manifest.display_name) name = String(manifest.display_name);
            } catch {
                log('manifest.json 不是合法 JSON —— 按仓库名继续');
            }
        }
    }

    // 主路径：宿主原生安装（服务端克隆，无 CORS 约束）
    const authedUrl = buildAuthedUrl(url, auth);
    const { hostNativeInstall, hostDeleteExtension } = await import(`./backend.js?v=${V}`);
    log('交给宿主原生安装通道…');
    let result = await hostNativeInstall({
        authedUrl,
        global: target === 'global',
        branch: branch || undefined,
    });
    // 更新语义：目录已存在且调用方允许 replace 时，删除旧目录后重装一次。
    // 实测：宿主安装端点不支持覆盖（409 Directory already exists），
    // /api/extensions/delete 可删除本地扩展目录（扩展目录内的本地改动不会备份）。
    if (!result.ok && replace && /already exists/i.test(String(result.data?.raw || result.data?.error || ''))) {
        log('目录已存在 —— 按「更新」流程：删除旧目录（本地改动不备份）后重装…');
        const deleted = await hostDeleteExtension(repo.repo);
        if (!deleted.ok) {
            throw new Error(`删除旧版失败: ${deleted.note}`);
        }
        result = await hostNativeInstall({
            authedUrl,
            global: target === 'global',
            branch: branch || undefined,
        });
    }
    if (!result.ok) {
        const detail = result.data?.error || result.data?.raw || `HTTP ${result.status}`;
        throw new Error(`宿主安装失败: ${detail}`);
    }
    log('安装完成，刷新页面后生效');
    // 来源登记：诊断页据此提供「更新」（以登记的 url/branch 重跑本流程）
    try {
        await accounts.recordInstall(name, { url, branch: branch || '', target, oid: cloned?.oid || '' });
    } catch { /* 登记失败不影响安装结果 */ }
    return { name, oid: cloned?.oid || '', mode: 'host-native', note: result.data?.message || '', cloned };
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
