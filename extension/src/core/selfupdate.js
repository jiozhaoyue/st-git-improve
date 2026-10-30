// 面板自身更新检查（纯逻辑，无 DOM 依赖；fetch 可注入以便单测）。
// 仓库为公开仓时 api.github.com 允许浏览器跨域（实测契约，见交接文档第三节）；
// 速率限制 60 次/时/IP，对手动检查足够。

/**
 * 从 GitHub 仓库主页 URL 解析 owner/repo。
 * @param {string} homePage 如 https://github.com/jiozhaoyue/st-git-improve
 * @returns {string|null} "owner/repo"；非 GitHub 形态返回 null
 */
export function originRepoFromHome(homePage) {
    const m = String(homePage || '').match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if (!m) return null;
    const repo = m[2].replace(/\.git$/i, '');
    return `${m[1]}/${repo}`;
}

/** base64 → UTF-8 字符串（contents API 返回 base64 内容）。 */
export function decodeBase64Utf8(b64) {
    const bytes = Uint8Array.from(atob(String(b64 || '').replace(/\s/g, '')), c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 简单三段版本比较：a<b → -1，相等 → 0，a>b → 1（与 backend.compareVersions 同规则）。
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/**
 * 检查面板自身是否有新版本（读 origin 仓库的 extension/manifest.json）。
 * @param {{ currentVersion: string, repo: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ ok: boolean, upToDate?: boolean, latest?: string, current: string, url?: string, note?: string }>}}
 */
export async function checkSelfUpdate({ currentVersion, repo, fetchImpl }) {
    const f = fetchImpl || fetch;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return { ok: false, current: currentVersion, note: '仓库标识无效（应为 owner/repo）' };
    }
    const url = `https://api.github.com/repos/${repo}/contents/extension/manifest.json?t=${Date.now()}`;
    let response;
    try {
        response = await f(url, { headers: { Accept: 'application/vnd.github+json' } });
    } catch (error) {
        return { ok: false, current: currentVersion, note: `网络请求失败：${error.message || error}` };
    }
    if (response.status === 404) {
        return { ok: false, current: currentVersion, note: 'origin 仓库不存在或 manifest 路径不符（404）' };
    }
    if (response.status === 403) {
        return { ok: false, current: currentVersion, note: 'GitHub API 限流（403）——稍后再试' };
    }
    if (!response.ok) {
        return { ok: false, current: currentVersion, note: `GitHub API HTTP ${response.status}` };
    }
    let payload;
    try {
        payload = await response.json();
    } catch {
        return { ok: false, current: currentVersion, note: '响应不是合法 JSON' };
    }
    if (payload?.encoding !== 'base64' || typeof payload.content !== 'string') {
        return { ok: false, current: currentVersion, note: 'contents API 响应形态异常' };
    }
    let manifest;
    try {
        manifest = JSON.parse(decodeBase64Utf8(payload.content));
    } catch {
        return { ok: false, current: currentVersion, note: '远端 manifest 解析失败' };
    }
    const latest = String(manifest?.version || '');
    if (!latest) {
        return { ok: false, current: currentVersion, note: '远端 manifest 无版本号' };
    }
    const compare = compareVersions(latest, currentVersion);
    return {
        ok: true,
        upToDate: compare <= 0,
        latest,
        current: currentVersion,
        url: `https://github.com/${repo}`,
        note: compare > 0 ? '有新版本' : '已是最新',
    };
}
