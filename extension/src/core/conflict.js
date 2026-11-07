// git 更新失败错误分类器（纯逻辑，无 DOM 依赖；L1-MR-6 三形态同构，Node 可单测）。
//
// 背景（2026-11-07 实测场景）：扩展目录被手动覆盖更新后残留未跟踪文件（旧版本文件
// 拷进 git 仓但没进索引）；上游把这些路径提交后，宿主原生更新通道（服务端 git pull）
// 以 "untracked working tree files would be overwritten" 拒绝合并。
//
// 事实源说明：宿主 /api/extensions/update 失败时响应体就是 git 错误原文（随仓
// ST 前端源 standalone/scripts/extensions.js updateExtension 核对：非 200 时把响应
// 文本直接 toast），与后端日志同源——解析响应即可覆盖「读日志」诉求；宿主无公开的
// 服务端日志读取端点，不臆造。

/** 分类结果 kind（conflict.kinds 供消费方/测试对照）。 */
export const kinds = {
    NONE: 'none',                     // 无错误文本
    UNTRACKED_CONFLICT: 'untracked-conflict', // 未跟踪文件挡道 merge/checkout
    LOCAL_CHANGES: 'local-changes',   // 已跟踪文件的本地改动与上游冲突
    DIVERGED: 'diverged',             // 分叉/非快进/未完结合并
    NETWORK: 'network',               // 认证/网络/远端不可达
    OTHER: 'other',                   // 有错误文本但不属已知形态
};

// 头行模式：git 在这些行后按 TAB 缩进逐行列出冲突文件清单。
const UNTRACKED_HEADER = /untracked working tree files would be overwritten by (?:merge|checkout|switch)/i;
const LOCAL_CHANGES_HEADER = /local changes to the following files would be overwritten by (?:merge|checkout|switch)/i;

// 无清单头行的补充特征（仅凭一句提示语出现的场景）。
const UNTRACKED_HINT = /please (?:move|remove)(?: or (?:move|remove))? them before you (?:merge|switch|checkout)/i;
const LOCAL_CHANGES_HINT = /please commit your changes or stash them before you (?:merge|switch|checkout)/i;

const DIVERGED_PATTERN = /divergent branches|not concluded? your merge|not possible to fast-forward|non-fast-forward|fetch first/i;
const NETWORK_PATTERN = /authentication failed|could not resolve host|connection timed out|couldn'?t find remote ref|connection refused|ssl certificate problem|port \d+.*timed out/i;

/**
 * 从缩进的清单行提取文件路径（去 TAB/引号包裹）。
 * git 清单行形如 "\tpath/to/file.js"，路径含特殊字符时整体带双引号。
 */
function parseFileLine(line) {
    let path = line.replace(/^[\t ]+/, '').trimEnd();
    if (path.startsWith('"') && path.endsWith('"')) {
        try {
            // git 对非 ASCII/特殊字符路径做 C 风格转义；按原样解引即可满足展示用途
            path = JSON.parse(path);
        } catch {
            path = path.slice(1, -1);
        }
    }
    return path;
}

/**
 * 修复卡清单预览摘要（纯逻辑）：小清单平铺；大清单（2188 文件量级实测）平铺前 N 行
 * 全是噪音——按目录聚合统计更有行动价值（一眼看清冲突波及面）。
 * 文案纪律（R-15）：本函数只产出数据行，面向用户的提示语由 UI 层 i18n 拼接。
 * @param {string[]} files 挡道文件路径全集
 * @param {{ flatLimit?: number, dirGroups?: number }} [options]
 * @returns {{ lines: string[], total: number, grouped: boolean, dirCount: number }}
 *   grouped=false 时 lines 即逐条路径；grouped=true 时 lines 为「目录 —— N 个文件」统计行。
 */
export function summarizeFileList(files, { flatLimit = 50, dirGroups = 12 } = {}) {
    const list = Array.isArray(files) ? files : [];
    if (list.length <= flatLimit) {
        return { lines: [...list], total: list.length, grouped: false, dirCount: 0 };
    }
    const byDir = new Map();
    for (const f of list) {
        const path = String(f || '');
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(根目录)';
        byDir.set(dir, (byDir.get(dir) || 0) + 1);
    }
    const groups = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, dirGroups);
    const lines = groups.map(([dir, count]) => `${dir} —— ${count} 个文件`);
    return { lines, total: list.length, grouped: true, dirCount: byDir.size };
}

/**
 * 分类 git 错误文本，识别「未跟踪文件挡道更新」等形态并抽取冲突文件清单。
 * @param {string} text git 的 stderr/错误原文（可为空）
 * @returns {{ kind: string, files: string[], header: string }}
 *   kind 见 kinds；files = 该形态下列出的文件路径（无清单形态为空数组）；
 *   header = 命中的头行原文（供日志/台账留证）。
 */
export function classifyGitError(text) {
    const raw = String(text || '');
    if (!raw.trim()) return { kind: kinds.NONE, files: [], header: '' };
    const lines = raw.replace(/\r\n/g, '\n').split('\n');

    // ① 头行识别（两类清单头可同时出现——git 会一次列完；**未跟踪优先**：
    //    其修复语义「删旧重装」同样覆盖本地改动场景，故分两趟扫描而非首行即断）
    let header = '';
    let kind = '';
    const findHeader = (pattern, kindValue) => {
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                kind = kindValue;
                header = lines[i].trim();
                return true;
            }
        }
        return false;
    };
    const matched = findHeader(UNTRACKED_HEADER, kinds.UNTRACKED_CONFLICT)
        || findHeader(LOCAL_CHANGES_HEADER, kinds.LOCAL_CHANGES);

    // ② 清单抽取：**每个头行**之后各收集一段连续 TAB 行（两段间被提示语隔开），
    //    按 git 原始输出顺序拼接并去重；kind 判定的「未跟踪优先」不影响清单顺序
    const files = [];
    const seen = new Set();
    const collectFrom = start => {
        for (let i = start; i < lines.length; i++) {
            if (!/^[\t]/.test(lines[i])) break;
            const path = parseFileLine(lines[i]);
            if (path && !seen.has(path)) {
                seen.add(path);
                files.push(path);
            }
        }
    };
    if (matched) {
        const headerIndices = [];
        for (let i = 0; i < lines.length; i++) {
            if (UNTRACKED_HEADER.test(lines[i]) || LOCAL_CHANGES_HEADER.test(lines[i])) {
                headerIndices.push(i);
            }
        }
        headerIndices.sort((a, b) => a - b);
        for (const idx of headerIndices) collectFrom(idx + 1);
        return { kind, files, header };
    }

    // ③ 无清单形态：按提示语与特征正则归类
    if (UNTRACKED_HINT.test(raw)) return { kind: kinds.UNTRACKED_CONFLICT, files: [], header: raw.trim().split('\n')[0] };
    if (LOCAL_CHANGES_HINT.test(raw)) return { kind: kinds.LOCAL_CHANGES, files: [], header: raw.trim().split('\n')[0] };
    if (DIVERGED_PATTERN.test(raw)) return { kind: kinds.DIVERGED, files: [], header: raw.trim().split('\n')[0] };
    if (NETWORK_PATTERN.test(raw)) return { kind: kinds.NETWORK, files: [], header: raw.trim().split('\n')[0] };
    return { kind: kinds.OTHER, files: [], header: raw.trim().split('\n')[0] };
}
