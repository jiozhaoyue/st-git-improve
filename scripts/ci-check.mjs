// CI 自查脚本（prd AC-3 / 决策 D6-4 C-1 落地机制；design.md §7 范式核查清单）。
// 零依赖 Node 脚本；发版前必须跑，任何一项非零即退出码 1。
//   npm run check
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = p => readFileSync(join(root, p), 'utf8');

let failed = false;
const fail = (name, detail) => {
    failed = true;
    console.error(`✗ ${name}\n${detail}`);
};
const ok = (name, detail) => console.log(`✓ ${name}${detail ? `（${detail}）` : ''}`);

// ---- 1. 裸选择器 = 0（L1-MR-3 / C-1） ----
const css = read('extension/style.css');
const bareSelectors = [...css.matchAll(/^\.((?!stgi)[A-Za-z][\w-]*)/gm)].map(m => m[1]);
if (bareSelectors.length > 0) fail('裸选择器（非 .stgi- 前缀）', bareSelectors.join(', '));
else ok('裸选择器 = 0');

// ---- 2. 硬编码色值：非 var 回退且无豁免注释 = 0（D6-2） ----
const cssLines = css.split('\n');
const hardcoded = [];
cssLines.forEach((line, i) => {
    if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) return;
    const context = `${line}\n${cssLines[i - 1] ?? ''}`;
    if (/var\(--SmartTheme/.test(line) || /豁免/.test(context)) return;
    hardcoded.push(`  L${i + 1}: ${line.trim().slice(0, 90)}`);
});
if (hardcoded.length > 0) fail('硬编码色值（无 var 回退且无豁免注释）', hardcoded.join('\n'));
else ok('硬编码色值 = 0（var 回退或已豁免）');

// ---- 3. data-act 静态重复 = 0（C-1 功能元素唯一性） ----
// 只统计开标签内的属性匹配（querySelector('[data-act=…]') 选择器不算渲染元素）
const indexJs = read('extension/index.js');
const acts = [...indexJs.matchAll(/<[a-zA-Z]+[^>]*\bdata-act="([^"]+)"/g)].map(m => m[1]);
const dupActs = [...new Set(acts.filter((v, i) => acts.indexOf(v) !== i))];
if (dupActs.length > 0) fail('data-act 静态重复渲染', dupActs.join(', '));
else ok(`data-act 无重复渲染（${new Set(acts).size} 个动作）`);

// ---- 4. i18n 键完整性：代码引用键 ⊆ 字典键（R-15 / D6-7） ----
const stringsSrc = read('extension/src/i18n/strings.js');
const dictKeys = new Set([...stringsSrc.matchAll(/'([A-Za-z][\w.]*)'\s*:/g)].map(m => m[1]));
// 引用面 = index.js 的 t('…') + 全部 src/core|src/i18n 模块中出现的 'key' 字面量（capability.js 输出键名等）
const srcFiles = ['extension/index.js',
    ...readdirSync(join(root, 'extension/src/core')).map(f => `extension/src/core/${f}`),
    'extension/src/i18n/index.js'];
const usedKeys = new Set();
for (const file of srcFiles) {
    const src = read(file);
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z][\w.]*)'/g)) usedKeys.add(m[1]);
    for (const m of src.matchAll(/'(cap\.[\w.]+|remote\.[\w.]+|ledger\.action\.[\w]+)'/g)) usedKeys.add(m[1]);
}
// 动态键：t(`ledger.action.${action}`) → 取 ${ 之前的静态前缀，要求字典存在以该前缀开头的键，
// 并把这些键计入已引用（否则死键检查会误报）
const dynamicPrefixes = [...indexJs.matchAll(/\bt\(\s*`([^`$]*?)\$\{/g)].map(m => m[1]);
for (const prefix of dynamicPrefixes) {
    const covered = [...dictKeys].filter(k => k.startsWith(prefix));
    if (covered.length === 0) fail('动态键前缀无字典覆盖', prefix);
    for (const k of covered) usedKeys.add(k);
}
const missingKeys = [...usedKeys].filter(k => !dictKeys.has(k));
if (missingKeys.length > 0) fail('i18n 引用键不在字典', missingKeys.join(', '));
else ok(`i18n 引用键全部命中字典（引用 ${usedKeys.size} / 字典 ${dictKeys.size}）`);

// ---- 5. i18n 死键：字典中不再被引用的键（报警不拦截，仅供清理） ----
const allSrc = srcFiles.map(f => read(f)).join('\n');
const deadKeys = [...dictKeys].filter(k => !usedKeys.has(k) && !allSrc.includes(`'${k}'`) && !allSrc.includes(`"${k}"`));
if (deadKeys.length > 0) console.warn(`⚠ i18n 死键（不拦截，供清理）: ${deadKeys.join(', ')}`);

// ---- 6. 硬编码中文文案（R-15）：index.js 非注释行中的中文字符串字面量 = 0（近似口径） ----
const zhLines = indexJs.split('\n')
    .map((line, i) => ({ line: line.replace(/\/\/.*$/, ''), i: i + 1 }))
    .filter(({ line }) => /["'`][^"'`]*[\u4e00-\u9fff]+[^"'`]*["'`]/.test(line) && !/console\.(log|warn|error)/.test(line));
if (zhLines.length > 0) fail('硬编码中文文案（应走 t()）', zhLines.map(({ line, i }) => `  L${i}: ${line.trim().slice(0, 90)}`).join('\n'));
else ok('硬编码中文文案 = 0（近似口径：字符串字面量含中文且非 console）');

console.log(failed ? '\n✗ CI 自查未通过' : '\n✓ CI 自查全部通过');
process.exit(failed ? 1 : 0);
