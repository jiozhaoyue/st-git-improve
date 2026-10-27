// vendor UMD 加载器：以 <script> 注入方式加载（无构建依赖，L1-MR-11）。
// isomorphic-git UMD 自包含（Buffer 已打包），加载后暴露全局 git。

const loaded = new Map();

function scriptUrl(relative) {
    // 相对 import.meta.url 解析，兼容宿主以任意路径安装扩展。
    return new URL(relative, import.meta.url).href;
}

export function loadScript(src) {
    if (loaded.has(src)) return loaded.get(src);
    const promise = new Promise((resolve, reject) => {
        const element = document.createElement('script');
        element.src = src;
        element.async = false;
        element.onload = () => resolve(src);
        element.onerror = () => {
            loaded.delete(src);
            element.remove();
            reject(new Error(`vendor 脚本加载失败: ${src}`));
        };
        document.head.append(element);
    });
    loaded.set(src, promise);
    return promise;
}

let gitPromise = null;

/** 惰性加载 buffer + isomorphic-git UMD（Buffer 必须先于 git 存在），返回全局 git。 */
export function loadGit() {
    if (!gitPromise) {
        gitPromise = (async () => {
            if (typeof window === 'undefined') {
                throw new Error('gitbrowser 仅可在浏览器环境使用');
            }
            if (!window.Buffer) {
                await loadScript(scriptUrl('../../vendor/buffer.umd.min.js'));
            }
            if (!window.git) {
                await loadScript(scriptUrl('../../vendor/isomorphic-git.umd.min.js'));
            }
            if (!window.git) {
                throw new Error('isomorphic-git 加载后仍不可用');
            }
            return window.git;
        })();
    }
    return gitPromise;
}
