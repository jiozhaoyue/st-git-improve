// 浏览器内存文件系统：实现 isomorphic-git 需要的 fs 子集。
// clone/checkout 把工作区与 .git 对象写入内存，随后可列举文件、读出内容打包。
// 约定：全部路径为绝对路径（以 / 开头），目录与文件都存进扁平 Map。

function normalize(path) {
    const parts = String(path).split('/');
    const out = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return '/' + out.join('/');
}

const parentOf = (path) => {
    const normalized = normalize(path);
    const cut = normalized.lastIndexOf('/');
    return cut <= 0 ? '/' : normalized.slice(0, cut);
};
const baseOf = (path) => normalize(path).split('/').pop();

export class MemoryFsError extends Error {
    constructor(code, path) {
        super(`${code}: ${path}`);
        this.code = code;
        this.path = path;
    }
}

export function createMemfs() {
    /** @type {Map<string, { type: 'dir' | 'file', data: Uint8Array, mtime: number }>} */
    const nodes = new Map();
    nodes.set('/', { type: 'dir', data: new Uint8Array(0), mtime: Date.now() });

    const ensureDir = (path) => {
        const normalized = normalize(path);
        const existing = nodes.get(normalized);
        if (existing && existing.type === 'dir') return normalized;
        if (existing) throw new MemoryFsError('ENOTDIR', normalized);
        const parent = parentOf(normalized);
        ensureDir(parent);
        nodes.set(normalized, { type: 'dir', data: new Uint8Array(0), mtime: Date.now() });
        return normalized;
    };

    const assertFile = (path) => {
        const normalized = normalize(path);
        const node = nodes.get(normalized);
        if (!node) throw new MemoryFsError('ENOENT', normalized);
        if (node.type !== 'file') throw new MemoryFsError('EISDIR', normalized);
        return { node, normalized };
    };

    const decode = (data, encoding) => {
        if (!encoding || encoding === 'buffer' || encoding === 'binary') return data;
        if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(data);
        throw new Error(`memfs 不支持的编码: ${encoding}`);
    };

    const api = {
        // isomorphic-git 可能直接调用这些方法，也可能走 fs.promises.* —— 两个入口都提供。
        async mkdir(path, options = {}) {
            const normalized = normalize(path);
            if (options.recursive) {
                ensureDir(normalized);
                return undefined;
            }
            if (nodes.has(normalized)) throw new MemoryFsError('EEXIST', normalized);
            const parent = nodes.get(parentOf(normalized));
            if (!parent || parent.type !== 'dir') throw new MemoryFsError('ENOENT', normalized);
            nodes.set(normalized, { type: 'dir', data: new Uint8Array(0), mtime: Date.now() });
            return undefined;
        },
        async writeFile(path, data, options = {}) {
            const normalized = normalize(path);
            const parent = nodes.get(parentOf(normalized));
            if (!parent || parent.type !== 'dir') throw new MemoryFsError('ENOENT', normalized);
            const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
            nodes.set(normalized, { type: 'file', data: bytes, mtime: Date.now() });
            return undefined;
        },
        async readFile(path, options = {}) {
            const encoding = typeof options === 'string' ? options : (options?.encoding ?? null);
            const { node } = assertFile(path);
            return decode(node.data, encoding);
        },
        async unlink(path) {
            const { normalized } = assertFile(path);
            nodes.delete(normalized);
        },
        async readdir(path) {
            const normalized = normalize(path);
            const node = nodes.get(normalized);
            if (!node) throw new MemoryFsError('ENOENT', normalized);
            if (node.type !== 'dir') throw new MemoryFsError('ENOTDIR', normalized);
            const prefix = normalized === '/' ? '/' : `${normalized}/`;
            const names = new Set();
            for (const key of nodes.keys()) {
                if (key === normalized || !key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                if (rest.includes('/')) continue; // 只返回直接子项
                names.add(rest);
            }
            return [...names];
        },
        async stat(path) {
            return api._stat(path);
        },
        async lstat(path) {
            return api._stat(path);
        },
        async rmdir(path) {
            const normalized = normalize(path);
            const node = nodes.get(normalized);
            if (!node) throw new MemoryFsError('ENOENT', normalized);
            if (node.type !== 'dir') throw new MemoryFsError('ENOTDIR', normalized);
            const hasChildren = [...nodes.keys()].some(key => key !== normalized && key.startsWith(normalized === '/' ? '/' : `${normalized}/`));
            if (hasChildren) throw new MemoryFsError('ENOTEMPTY', normalized);
            nodes.delete(normalized);
        },
        /** 最小 symlink 支持：保存目标字符串；zip 打包时按普通文件处理。 */
        async symlink(target, path) {
            const normalized = normalize(path);
            const parent = nodes.get(parentOf(normalized));
            if (!parent || parent.type !== 'dir') throw new MemoryFsError('ENOENT', normalized);
            nodes.set(normalized, { type: 'link', target: String(target), data: new TextEncoder().encode(String(target)), mtime: Date.now() });
            return undefined;
        },
        async readlink(path) {
            const node = nodes.get(normalize(path));
            if (!node) throw new MemoryFsError('ENOENT', path);
            if (node.type !== 'link') throw new MemoryFsError('EINVAL', path);
            return node.target;
        },
        // 便捷接口（isomorphic-git 之外的面板逻辑使用）
        exists(path) {
            return nodes.has(normalize(path));
        },
        setFile(path, data) {
            const normalized = normalize(path);
            ensureDir(parentOf(normalized));
            nodes.set(normalized, {
                type: 'file',
                data: data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)),
                mtime: Date.now(),
            });
        },
        /** 同步读取文件字节（克隆结果汇总用）；不存在返回 null。 */
        fileData(path) {
            const node = nodes.get(normalize(path));
            if (!node) return null;
            if (node.type === 'file' || node.type === 'link') return node.data;
            return null;
        },
        /** 递归列举目录下的全部文件（返回绝对路径，跳过 skipName 指定的名字，如 .git）。 */
        listFilesDeep(dirPath = '/', skipNames = []) {
            const out = [];
            const walk = (dir) => {
                for (const name of api.readdirSyncLike(dir)) {
                    const full = (dir === '/' ? '' : dir) + '/' + name;
                    if (skipNames.includes(name)) continue;
                    const node = nodes.get(full);
                    if (node?.type === 'dir') walk(full);
                    else if (node?.type === 'file') out.push(full);
                }
            };
            walk(normalize(dirPath));
            return out;
        },
        /** readdir 的同步版本（仅内部遍历用，不对 isomorphic-git 暴露）。 */
        readdirSyncLike(path) {
            const normalized = normalize(path);
            const prefix = normalized === '/' ? '/' : `${normalized}/`;
            const names = [];
            for (const key of nodes.keys()) {
                if (key === normalized || !key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                if (rest.includes('/')) continue;
                names.push(rest);
            }
            return names;
        },
        _stat(path) {
            const node = nodes.get(normalize(path));
            if (!node) throw new MemoryFsError('ENOENT', path);
            const isLink = node.type === 'link';
            return {
                isDirectory: () => node.type === 'dir',
                isFile: () => node.type === 'file' || isLink,
                isSymbolicLink: () => isLink,
                size: node.data.length,
                mode: node.type === 'dir' ? 0o40755 : isLink ? 0o120777 : 0o100644,
                mtimeMs: node.mtime,
                ctimeMs: node.mtime,
            };
        },
    };
    api.promises = api;
    return api;
}
