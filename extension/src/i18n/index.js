// i18n 取串器（决策 D6-7：自管字典，不依赖宿主 i18n API，跨宿主稳定）。
// t(key, params) 缺键：开发态 console.warn + 渲染裸键名（便于发现漏键）；
// params 以 {name} 占位替换。

import { strings } from './strings.js';

let warnMissing = true;

/** 单测/生产可关闭缺键告警。 */
export function setMissingKeyWarn(enabled) {
    warnMissing = Boolean(enabled);
}

export function has(key) {
    return Object.prototype.hasOwnProperty.call(strings, key);
}

export function t(key, params = null) {
    let text = strings[key];
    if (text === undefined) {
        if (warnMissing) {
            console.warn(`[st-git-improve i18n] 缺少文案键: ${key}`);
        }
        return key;
    }
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
        }
    }
    return text;
}
