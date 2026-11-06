// 站点 API 远端状态（决策 D3-1 #8 分支列举纯前端化 / D5-4 扫描三维之「远端状态」）。
// 分支列举与最新提交查询直连站点 API：公开仓库无需凭据；私有仓库由调用方注入
// 该站点默认账号的 token（auth = { username, password: token }，来自账号库）。
//
// CORS 事实：GitHub / GitLab / Gitee 官方 API 均允许浏览器跨域；自建 Gitea 视实例
// CORS 配置而定——失败一律返回 { ok:false, reasonKey }，UI 显示「—」不阻塞主流程
// （L0-11 适配器 + 静默降级）。
// 文案纪律（R-15）：面向用户的 note 一律 i18n 键（reasonKey），由面板层 t() 渲染。
// 纯逻辑、无 DOM 依赖（L1-MR-6）；fetch 可注入以便单测。

// 版本参数：与 manifest.json version 同步（宿主 HTTP 缓存破坏），见 index.js 说明。
const V = '0.9.3';

const { parseRepoUrl } = await import(`./sites.js?v=${V}`);

const REQUEST_TIMEOUT_MS = 8000;

async function requestJson(url, { headers = {}, fetchImpl } = {}) {
    const f = fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await f(url, {
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        return { status: response.status, ok: response.ok, data };
    } catch {
        return { status: 0, ok: false, data: null, network: true };
    } finally {
        clearTimeout(timer);
    }
}

function authHeaders(type, auth) {
    if (!auth?.password) return {};
    const token = String(auth.password);
    if (type === 'github' || type === 'gitlab') return { Authorization: `Bearer ${token}` };
    if (type === 'gitea') return { Authorization: `token ${token}` };
    return {}; // gitee 走 query 参数 access_token
}

/** gitee 的 token 走 query 参数（官方 API v5 惯例）。 */
function giteeTokenQuery(auth) {
    return auth?.password ? `access_token=${encodeURIComponent(String(auth.password))}` : '';
}

function failure(status, network) {
    if (network) return { ok: false, status: 0, reasonKey: 'remote.err.network' };
    if (status === 404) return { ok: false, status, reasonKey: 'remote.err.notFound' };
    if (status === 403) return { ok: false, status, reasonKey: 'remote.err.rateLimit' };
    return { ok: false, status, reasonKey: 'remote.err.http' };
}

/** 单站点端点（type 已知时；返回 { url, headers } 或 { fail: reasonKey }）。 */
function endpointFor(type, repo, path, { auth, query = '' } = {}) {
    const origin = new URL(repo.httpsUrl).origin;
    if (type === 'github') {
        return { url: `https://api.github.com/repos/${repo.owner}/${repo.repo}${path}${query}`, headers: { 'User-Agent': 'st-git-improve', ...authHeaders('github', auth) } };
    }
    if (type === 'gitlab') {
        const project = encodeURIComponent(`${repo.owner}/${repo.repo}`);
        return { url: `${origin}/api/v4/projects/${project}${path}${query}`, headers: authHeaders('gitlab', auth) };
    }
    if (type === 'gitea') {
        return { url: `${origin}/api/v1/repos/${repo.owner}/${repo.repo}${path}${query}`, headers: authHeaders('gitea', auth) };
    }
    if (type === 'gitee') {
        const tokenQuery = giteeTokenQuery(auth);
        const joiner = query || tokenQuery ? '?' : '';
        const parts = [query.replace(/^\?/, ''), tokenQuery].filter(Boolean).join('&');
        return { url: `https://gitee.com/api/v5/repos/${repo.owner}/${repo.repo}${path}${joiner}${parts}`, headers: {} };
    }
    return { fail: 'remote.err.unsupportedSite' };
}

/**
 * 候选端点序列：host 可识别（github/gitlab.com/gitee.com）→ 单端点；
 * 自建站点（host 无法判型，实测 parseRepoUrl 对自建一律返回空 type）→
 * 依次探测 gitea / gitlab 两种 API 形态（404 才换下一个——401/403/网络错误直接上报）。
 */
function endpointCandidates(repo, path, opts = {}) {
    if (repo.type) return [endpointFor(repo.type, repo, path, opts)];
    return [endpointFor('gitea', repo, path, opts), endpointFor('gitlab', repo, path, opts)];
}

/**
 * 依次尝试候选端点；ok 即用，否则按「未知 host 且 404 → 换下一形态」规则收敛，
 * 返回 { result } 或 { failure }（failure.reasonKey 供 UI 降级显示）。
 */
async function tryEndpoints(candidates, { fetchImpl } = {}) {
    let last = null;
    for (const ep of candidates) {
        if (ep.fail) return { failure: { ok: false, status: 0, reasonKey: ep.fail } };
        const result = await requestJson(ep.url, { headers: ep.headers, fetchImpl });
        if (result.ok) return { result };
        last = failure(result.status, result.network);
        if (!(candidates.length > 1 && result.status === 404)) break;
    }
    return { failure: last };
}

/**
 * 列举远端分支（安装入口的分支下拉；D3-1 #8）。
 * @param {string} repoUrl
 * @param {{ auth?: { username: string, password: string } | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, branches: string[], reasonKey: string | null }>}
 */
export async function fetchBranches(repoUrl, { auth = null, fetchImpl } = {}) {
    let repo;
    try {
        repo = parseRepoUrl(repoUrl);
    } catch {
        return { ok: false, branches: [], reasonKey: 'remote.err.badUrl' };
    }
    const tried = await tryEndpoints(
        endpointCandidates(repo, '/branches', { auth, query: repo.type === 'github' ? '?per_page=100' : '' }),
        { fetchImpl },
    );
    if (tried.failure) return { ok: false, branches: [], reasonKey: tried.failure.reasonKey };
    const result = tried.result;
    if (!Array.isArray(result.data)) {
        return { ok: false, branches: [], reasonKey: 'remote.err.badPayload' };
    }
    const branches = result.data.map(item => String(item?.name || '')).filter(Boolean);
    return { ok: true, branches, reasonKey: null };
}

/**
 * 查询远端最新提交（默认分支或指定分支的 HEAD sha）。
 * @returns {Promise<{ ok: boolean, sha: string, reasonKey: string | null }>}
 */
export async function fetchRemoteHead(repoUrl, { branch = '', auth = null, fetchImpl } = {}) {
    let repo;
    try {
        repo = parseRepoUrl(repoUrl);
    } catch {
        return { ok: false, sha: '', reasonKey: 'remote.err.badUrl' };
    }
    // 各站点 HEAD 端点构造（path / query 参数名有差异）
    const headCandidate = type => {
        if (type === 'github') return endpointFor('github', repo, '/commits', { auth, query: `?per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}` });
        if (type === 'gitlab') return endpointFor('gitlab', repo, '/repository/commits', { auth, query: `?per_page=1${branch ? `&ref_name=${encodeURIComponent(branch)}` : ''}` });
        if (type === 'gitea') return endpointFor('gitea', repo, '/commits', { auth, query: `?limit=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}` });
        if (type === 'gitee') return endpointFor('gitee', repo, '/commits', { auth, query: `?per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}` });
        return { fail: 'remote.err.unsupportedSite' };
    };
    const candidates = repo.type ? [headCandidate(repo.type)] : [headCandidate('gitea'), headCandidate('gitlab')];
    const tried = await tryEndpoints(candidates, { fetchImpl });
    if (tried.failure) return { ok: false, sha: '', reasonKey: tried.failure.reasonKey };
    // 各站点统一按数组返回（per_page=1）；单对象形态（部分自建 Gitea）也兼容
    const first = Array.isArray(tried.result.data) ? tried.result.data[0] : tried.result.data;
    const sha = String(first?.sha || first?.id || '');
    if (!sha) {
        return { ok: false, sha: '', reasonKey: 'remote.err.badPayload' };
    }
    return { ok: true, sha, reasonKey: null };
}

/**
 * 仓库摘要（安装前快速识别：描述 / 默认分支 / 最近推送 / 星标；D3-1 #8 站点 API 同族）。
 * @param {string} repoUrl
 * @param {{ auth?: { username: string, password: string } | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, description: string, defaultBranch: string, pushedAt: string, stars: number | null, reasonKey: string | null }>}
 */
export async function fetchRepoInfo(repoUrl, { auth = null, fetchImpl } = {}) {
    const empty = { ok: false, description: '', defaultBranch: '', pushedAt: '', stars: null, reasonKey: 'remote.err.badUrl', status: 0 };
    let repo;
    try {
        repo = parseRepoUrl(repoUrl);
    } catch {
        return empty;
    }
    const tried = await tryEndpoints(endpointCandidates(repo, '', { auth }), { fetchImpl });
    if (tried.failure) return { ...empty, reasonKey: tried.failure.reasonKey, status: tried.failure.status ?? 0 };
    const d = tried.result.data;
    if (!d || typeof d !== 'object') {
        return { ...empty, reasonKey: 'remote.err.badPayload' };
    }
    const starsRaw = d.stargazers_count ?? d.star_count;
    return {
        ok: true,
        description: String(d.description || ''),
        defaultBranch: String(d.default_branch || ''),
        pushedAt: String(d.pushed_at || d.last_activity_at || d.updated_at || ''),
        stars: Number.isFinite(Number(starsRaw)) ? Number(starsRaw) : null,
        reasonKey: null,
        status: tried.result.status,
    };
}

/**
 * 远端状态三维检查（D5-4）：对比安装时登记的 oid 与远端 HEAD。
 * @param {{ url: string, branch?: string, oid?: string, installedAt?: number }} origin 来源登记
 * @returns {Promise<{ ok: boolean, state: 'newer'|'same'|'unknown', sha: string, reasonKey: string | null }>}
 */
export async function checkRemoteUpdate(origin, { auth = null, fetchImpl } = {}) {
    if (!origin?.url) {
        return { ok: false, state: 'unknown', sha: '', reasonKey: 'remote.note.noUrl' };
    }
    if (!origin.oid) {
        return { ok: true, state: 'unknown', sha: '', reasonKey: 'remote.note.noOid' };
    }
    const head = await fetchRemoteHead(origin.url, { branch: origin.branch || '', auth, fetchImpl });
    if (!head.ok) {
        return { ok: false, state: 'unknown', sha: '', reasonKey: head.reasonKey };
    }
    // 安装时记录的是克隆时刻完整 sha；前 10 位一致视为「已是最新」（远端强推/改写也归入「有新版本」）
    const recorded = String(origin.oid).slice(0, 10);
    const state = head.sha.startsWith(recorded) ? 'same' : 'newer';
    return { ok: true, state, sha: head.sha, reasonKey: null };
}
