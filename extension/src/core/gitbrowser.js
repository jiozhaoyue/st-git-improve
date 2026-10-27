// 浏览器 git 引擎：isomorphic-git（fetch 传输）+ 内存 fs。
// 支持 GitHub / GitLab / Gitea(smart http) 的 http(s) 克隆，凭据经 onAuth 注入。
// UMD 构建不导出内置 http 客户端 —— 按官方文档定义的 HTTP 客户端接口用 fetch 实现。

import { createMemfs } from './memfs.js';
import { loadGit } from './vendor-loader.js';

/** 把 WHATWG ReadableStream 适配为 async 可迭代（规避跨 realm 的 instanceof 检查）。 */
async function* streamChunks(body) {
    const reader = body.getReader();
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock?.();
    }
}

/**
 * isomorphic-git HTTP 客户端接口的 fetch 实现。
 * 文档：https://isomorphic-git.org/docs/en/http_client —— request 收发流式 body。
 */
export const fetchHttp = {
    async request({ url, method = 'GET', headers = {}, body = null, signal }) {
        const init = { method, headers, signal };
        if (body != null) init.body = body;
        const response = await fetch(url, init);
        // isomorphic-git 以普通对象方括号访问 header（如 headers["content-type"]），
        // 同时保留 get() 以兼容按 Headers 读取的路径。
        const plainHeaders = Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
        plainHeaders.get = name => response.headers.get(name);
        return {
            url: response.url,
            method,
            statusCode: response.status,
            statusMessage: response.statusText,
            headers: plainHeaders,
            body: response.body ? streamChunks(response.body) : null,
        };
    },
};

/**
 * 克隆仓库到内存。
 * @param {{ url: string, branch?: string, auth?: { username: string, password: string } | null,
 *          depth?: number, onProgress?: (info: any) => void, onLog?: (line: string) => void,
 *          signal?: AbortSignal }} options
 * @returns {Promise<{ files: Map<string, Uint8Array>, textFile: (path: string) => string | null, oid: string, branch: string }>}
 */
export async function cloneToMemory({ url, branch, auth, depth = 1, onProgress, onLog, signal }) {
    const git = await loadGit();
    const fs = createMemfs();
    const dir = '/repo';
    const log = onLog || (() => { });
    log(`克隆 ${url}${branch ? `（分支 ${branch}）` : ''}`);
    const cloneOptions = {
        fs,
        http: fetchHttp,
        dir,
        url,
        depth,
        singleBranch: true,
        noTags: true,
        onProgress,
        onAuth: () => (auth ? { username: auth.username, password: auth.password } : {}),
        onAuthFailure: () => {
            const error = new Error('认证失败：请在「账号」页确认该站点的凭据有效（私有仓库需要 PAT）');
            // @ts-ignore
            error.authFailure = true;
            throw error;
        },
    };
    if (branch) cloneOptions.ref = branch;
    if (signal) cloneOptions.signal = signal;
    await git.clone(cloneOptions);

    // 汇总工作区文件（跳过 .git），相对路径 → 字节。
    const files = new Map();
    for (const abs of fs.listFilesDeep(dir, ['.git'])) {
        const rel = abs.slice(dir.length + 1);
        files.set(rel, fs.fileData(abs));
    }
    let resolvedBranch = branch || '';
    if (!resolvedBranch) {
        resolvedBranch = await git.currentBranch({ fs, dir, fullname: false }).catch(() => '') || '';
    }
    const commits = await git.log({ fs, dir, depth: 1 }).catch(() => []);
    const oid = commits[0]?.oid || '';
    log(`克隆完成：${files.size} 个文件${oid ? `，HEAD ${oid.slice(0, 7)}` : ''}`);
    const textFile = (path) => {
        const data = files.get(path);
        return data ? new TextDecoder().decode(data) : null;
    };
    return { files, textFile, oid, branch: resolvedBranch };
}

/** 从克隆结果读取文本文件；不存在返回 null。 */
export function readText(result, path) {
    return result.textFile(path);
}
