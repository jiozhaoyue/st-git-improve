// 多通道合并策略单测（账号不因通道分叉而丢失）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from '../extension/src/core/storage.js';

const acct = (id, type, baseUrl, username) => ({ id, type, baseUrl, username, token: `t-${id}` });

test('单通道为空时直接取另一通道', () => {
    const a = { version: 1, accounts: [acct('1', 'github', 'https://github.com', 'x')], defaults: { 'g': '1' } };
    assert.deepEqual(mergeStates(a, null), a);
    assert.deepEqual(mergeStates(null, a), a);
    assert.deepEqual(mergeStates(null, null), null);
});

test('两通道各有账号：按 type+baseUrl+username 去重合并', () => {
    const a = { version: 1, accounts: [acct('1', 'github', 'https://github.com', 'x')], defaults: {} };
    const b = {
        version: 1,
        accounts: [
            acct('1b', 'github', 'https://github.com', 'x'),  // 同身份 → 去重（主通道优先）
            acct('2', 'github', 'https://github.com', 'y'),   // 新账号 → 并入
        ],
        defaults: {},
    };
    const merged = mergeStates(a, b);
    assert.equal(merged.accounts.length, 2);
    assert.deepEqual(merged.accounts.map(x => x.id), ['1', '2']);
});

test('defaults 只保留指向存在账号的映射', () => {
    const a = { version: 1, accounts: [acct('1', 'github', 'https://github.com', 'x')], defaults: { 'github': '1', 'ghost': 'zzz' } };
    const b = { version: 1, accounts: [acct('2', 'gitee', 'https://gitee.com', 'y')], defaults: { 'gitee': '2' } };
    const merged = mergeStates(a, b);
    assert.deepEqual(merged.defaults, { 'github': '1', 'gitee': '2' });
    assert.equal(merged.defaults.ghost, undefined);
});

test('畸形输入不抛错', () => {
    const merged = mergeStates({ accounts: 'not-array' }, { accounts: [acct('1', 'github', '', 'x')] });
    assert.equal(merged.accounts.length, 1);
});
