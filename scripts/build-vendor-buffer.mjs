// 从 node_modules 的 buffer / base64-js / ieee754（isomorphic-git 的既有依赖）
// 机械拼接出一个 buffer.umd.min.js（暴露全局 Buffer）。不安装任何新包。
// 重新生成：node scripts/build-vendor-buffer.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, 'node_modules', p), 'utf8');

function wrapCjs(name, source, requireMap) {
    // 把 require('x') 文本替换为注入的局部名（仅处理精确已知依赖）。
    let code = source;
    for (const [spec, local] of Object.entries(requireMap)) {
        const patterns = [`require('${spec}')`, `require("${spec}")`, `require('${spec}.js')`, `require("${spec}.js")`];
        for (const pattern of patterns) {
            code = code.split(pattern).join(local);
        }
    }
    if (/require\s*\(/.test(code)) {
        throw new Error(`${name} 仍有未映射的 require 调用，检查其依赖列表`);
    }
    return `const ${localName(name)} = (function(){ const module = { exports: {} }; const exports = module.exports;\n${code}\nreturn module.exports;})();`;
}

function localName(name) {
    return `__${name.replace(/[^a-z0-9]/gi, '_')}`;
}

const base64js = wrapCjs('base64-js', read('base64-js/index.js'), {});
const ieee754 = wrapCjs('ieee754', read('ieee754/index.js'), {});
const buffer = wrapCjs('buffer', read('buffer/index.js'), {
    'base64-js': localName('base64-js'),
    'ieee754': localName('ieee754'),
});

const banner = `/*! buffer.umd.min.js —— 由 scripts/build-vendor-buffer.mjs 从 node_modules 拼接生成（勿手改）。
 * 来源: buffer@${JSON.parse(readFileSync(join(root, 'node_modules/buffer/package.json'), 'utf8')).version} + base64-js + ieee754（MIT，作者 Feross Aboukhadijeh 等）。
 * 用途: 为浏览器中的 isomorphic-git 提供 Buffer 全局。 */
(function(global){\n`;
const footer = `\nglobal.Buffer = ${localName('buffer')}.Buffer;
if (typeof global.SlowBuffer === 'undefined' && ${localName('buffer')}.SlowBuffer) global.SlowBuffer = ${localName('buffer')}.SlowBuffer;
})(typeof self !== 'undefined' ? self : globalThis);\n`;

const outDir = join(root, 'extension', 'vendor');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'buffer.umd.min.js');
writeFileSync(out, banner + [base64js, ieee754, buffer].join('\n') + footer);
console.log(`written: ${out} (${(banner.length + base64js.length + ieee754.length + buffer.length + footer.length)} bytes)`);
