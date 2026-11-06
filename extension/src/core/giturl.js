// 仓库地址分类（纯逻辑，无 DOM 依赖；与插件引擎 plugin/git/engine.js 的
// isSystemGitUrl 判定保持同一套规则——镜像而非复用，因为纯前端模式下
// 引擎代码不可达）。三形态同构（L1-MR-6）：Node 测试 / 浏览器面板均可导入。

/**
 * 判断 URL 是否需要系统 git 通道（isomorphic-git 只支持 http/https）。
 * 接受 ssh://、scp 语法（git@host:path）、git:// 与 file://。
 * @param {string} url
 */
export function isSystemGitUrl(url) {
    const raw = String(url || '').trim();
    if (/^file:\/\//i.test(raw)) return true;
    if (/^ssh:\/\//i.test(raw)) return true;
    if (/^git:\/\//i.test(raw)) return true;
    return /^[^@/]+@[^:/]+:.+$/.test(raw) && !/^https?:\/\//i.test(raw);
}

/**
 * @typedef {Object} UrlClass
 * @property {'ssh'|'file'|'git'|'https'|'http'|'unknown'} proto 传输协议
 * @property {'system'|'browser'|'unknown'} channel 克隆通道：
 *   system=系统 git（SSH/file 桥），browser=isomorphic-git 浏览器内克隆
 * @property {string} label 通道中文名
 * @property {boolean} installable 该地址在「服务端插件」语义下可否直接安装
 */

/**
 * 把仓库地址分类为协议 + 通道。判定规则与引擎一致；未知形态返回 unknown。
 * @param {string} url
 * @returns {UrlClass}
 */
export function classifyUrl(url) {
    const raw = String(url || '').trim();
    if (/^file:\/\//i.test(raw)) {
        return { proto: 'file', channel: 'system', label: '系统 git（file）', installable: true };
    }
    if (/^ssh:\/\//i.test(raw)) {
        return { proto: 'ssh', channel: 'system', label: '系统 git（SSH）', installable: true };
    }
    if (/^git:\/\//i.test(raw)) {
        return { proto: 'git', channel: 'system', label: '系统 git（git://）', installable: true };
    }
    if (/^[^@/]+@[^:/]+:.+$/.test(raw)) {
        // scp 语法（git@host:path）——排除 http(s) 用户信息形态
        return { proto: 'ssh', channel: 'system', label: '系统 git（SSH/scp）', installable: true };
    }
    if (/^https:\/\//i.test(raw)) {
        return { proto: 'https', channel: 'browser', label: 'HTTP(S) 克隆', installable: true };
    }
    if (/^http:\/\//i.test(raw)) {
        return { proto: 'http', channel: 'browser', label: 'HTTP(S) 克隆', installable: true };
    }
    return { proto: 'unknown', channel: 'unknown', label: '无法识别', installable: false };
}

/**
 * 归一化仓库输入（安装入口容错增强）：
 * - `owner/repo` 简写 → https://github.com/owner/repo
 * - `gh:owner/repo` / `github:owner/repo` → https://github.com/owner/repo
 *   `gitee:owner/repo` → https://gitee.com/owner/repo
 *   `gitlab:owner/repo` → https://gitlab.com/owner/repo
 * - GitHub/Gitee 仓库页面 URL（/tree/...、/blob/... 等）→ 仓库根 https URL
 *   （GitLab 子组路径有歧义，页面 URL 归一化不处理 gitlab.com）
 * 只对「无协议头的短写」与「已知托管站的页面 URL」做转换；scp/ssh 形态含 @，不进这里。
 * @param {string} input
 * @returns {{ url: string, changed: boolean, note: string }} changed=false 时 note 为空串
 */
export function normalizeRepoInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return { url: raw, changed: false, note: '' };

    // 前缀短写（gh:/gitee:/gitlab:/github: 后接 owner/repo；排除带 @ 与协议头的形态）
    const prefix = /^(gh|github|gitee|gitlab):([^/\s].*)$/i.exec(raw);
    if (prefix && !raw.includes('@') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        const host = { gh: 'github.com', github: 'github.com', gitee: 'gitee.com', gitlab: 'gitlab.com' }[prefix[1].toLowerCase()];
        const path = prefix[2].trim().replace(/\/+$/, '');
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) {
            const url = `https://${host}/${path}`;
            return { url, changed: true, note: `已识别为 ${host} 仓库：${url}` };
        }
    }

    // 裸 owner/repo（无协议头、无 @）→ GitHub
    if (!raw.includes('://') && !raw.includes('@') && /^[\w.-]+\/[\w.-]+$/.test(raw)) {
        const url = `https://github.com/${raw}`;
        return { url, changed: true, note: `已识别为 GitHub 仓库：${url}` };
    }

    // 无协议的 host/path 形态（如 github.com/a/b、git.example.com/a/b）→ 补 https://
    if (!raw.includes('://') && !raw.includes('@') && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/\S+$/i.test(raw)) {
        const url = `https://${raw}`;
        return { url, changed: true, note: `已补全协议：${url}` };
    }

    // 已知托管站的仓库页面 URL → 仓库根
    if (/^https?:\/\//i.test(raw)) {
        try {
            const parsed = new URL(raw);
            const host = parsed.host.toLowerCase();
            const known = host === 'github.com' || host === 'gitee.com'
                || host.endsWith('.github.com') || host.endsWith('.gitee.com');
            if (known) {
                const segments = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
                    .replace(/\.git$/, '').split('/').filter(Boolean);
                if (segments.length >= 3) {
                    const url = `${parsed.protocol}//${parsed.host}/${segments[0]}/${segments[1]}`;
                    return { url, changed: true, note: `已从仓库页面地址提取仓库根：${url}` };
                }
            }
        } catch { /* 非法 URL 原样返回 */ }
    }

    return { url: raw, changed: false, note: '' };
}

/**
 * 克隆地址 → 仓库网页地址（「↗ 主页」链接用）。
 * https://host/owner/repo(.git) → 去 .git；git@host:owner/repo(.git) → https://host/owner/repo。
 * 解析失败返回 null。
 * @param {string} url
 * @returns {string | null}
 */
export function repoWebUrlFromClone(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(raw);
    if (scp) {
        const path = scp[2].replace(/\.git$/, '').replace(/\/+$/, '');
        return /^[\w.-]+\/[\w.-]+$/.test(path) ? `https://${scp[1]}/${path}` : null;
    }
    if (!/^https?:\/\//i.test(raw)) return null;
    try {
        const parsed = new URL(raw);
        const segments = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
            .replace(/\.git$/, '').split('/').filter(Boolean);
        if (segments.length < 2) return null;
        return `${parsed.protocol}//${parsed.host}/${segments[0]}/${segments[1]}`;
    } catch {
        return null;
    }
}

/**
 * 面向安装页的通道提示文案（按运行模式合成）。
 * @param {string} url 仓库地址
 * @param {{ mode: 'server'|'pure', systemGitAvailable?: boolean }} ctx 运行上下文
 * @returns {{ text: string, level: 'ok'|'warn'|'error'|'info' }}
 */
export function channelHint(url, ctx) {
    const raw = String(url || '').trim();
    if (!raw) {
        return { text: '', level: 'info' };
    }
    const cls = classifyUrl(raw);
    const server = ctx?.mode === 'server';
    if (cls.channel === 'system') {
        if (!server) {
            return {
                text: `${cls.label}——纯前端模式不可用：浏览器无法执行系统 git。请改用 http(s) 地址，或安装服务端插件以启用 SSH/file 桥。`,
                level: 'error',
            };
        }
        if (ctx.systemGitAvailable === false) {
            return {
                text: `${cls.label}——本机未检测到可用的系统 git，安装将失败。请先安装 git 或改用 http(s) 地址。`,
                level: 'error',
            };
        }
        return {
            text: `${cls.label}——走系统 git 通道（SSH 凭据用你自己的 ssh-agent / askpass，不进凭据存储）。`,
            level: ctx.systemGitAvailable === true ? 'ok' : 'info',
        };
    }
    if (cls.channel === 'browser') {
        if (server) {
            return {
                text: `${cls.label}——服务端插件通道（isomorphic-git，站点凭据自动认证）。`,
                level: 'ok',
            };
        }
        return {
            text: `${cls.label}——浏览器内克隆（isomorphic-git，凭据来自「账号」页），成功后交宿主原生安装。`,
            level: 'ok',
        };
    }
    return { text: '无法识别的仓库地址——支持 http(s)、ssh://、git@host:path（scp）、file://。', level: 'warn' };
}
