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
