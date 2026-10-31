// 确认流文案契约单测（prd AC-2 / 决策 D9-3：不可恢复才强确认）。
// 契约：每个强确认动作必须有「正文 + 后果危险说明」成对键；危险说明必须含「不可恢复」或等效措辞。
// 真实 DOM 交互流（弹窗出现/确认按钮路径）归阶段三 E2E 治理闭环（D10-2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { strings } from '../extension/src/i18n/strings.js';

// D9-3 强确认白名单：卸载 / 删重复副本 / 更新（删旧重装）。
// 停用/启用/迁移为可逆操作——必须没有强确认键（防止确认疲劳回归）。
const STRONG_CONFIRM_PAIRS = [
    ['confirm.updateText', 'confirm.updateDanger'],
    ['confirm.uninstallText', 'confirm.uninstallDanger'],
    ['confirm.dedupText', 'confirm.dedupDanger'],
];

test('强确认键成对存在且非空（D9-3 后果说明）', () => {
    for (const [textKey, dangerKey] of STRONG_CONFIRM_PAIRS) {
        assert.ok(strings[textKey], `缺少 ${textKey}`);
        assert.ok(strings[dangerKey], `缺少 ${dangerKey}`);
        assert.ok(strings[textKey].length > 5, `${textKey} 文案过短`);
        assert.ok(strings[dangerKey].length > 5, `${dangerKey} 文案过短`);
    }
});

test('危险说明必含「不可恢复」等效措辞（红字语义）', () => {
    for (const [, dangerKey] of STRONG_CONFIRM_PAIRS) {
        assert.match(
            strings[dangerKey],
            /不可恢复|无法恢复|不能恢复/,
            `${dangerKey} 必须明确警示不可恢复`,
        );
    }
});

test('可逆操作（停用/启用/迁移）没有强确认键——确认强度与后果对齐', () => {
    // 若未来为可逆操作加了 confirm.* 键，说明确认基线被破坏（D9-3 违规），此测试应失败并引起审查
    const reversibleConfirmKeys = Object.keys(strings).filter(k =>
        /^confirm\./.test(k) && /enable|disable|move|toggle/i.test(k));
    assert.deepEqual(reversibleConfirmKeys, [],
        `可逆操作不应有强确认键，发现: ${reversibleConfirmKeys.join(', ')}`);
});

test('强确认正文含 {name} 占位（对象可辨识）', () => {
    for (const [textKey] of STRONG_CONFIRM_PAIRS) {
        assert.ok(strings[textKey].includes('{name}') || strings[textKey].includes('{'),
            `${textKey} 应含占位符以指明操作对象`);
    }
});
