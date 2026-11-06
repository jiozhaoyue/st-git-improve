// governance-log 纯逻辑单测：mergeEntries 合并去重/排序/封顶 + normalize 过滤（Node 无 window → 内存适配器路径）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeEntries } from '../extension/src/core/governance-log.js';

describe('governance-log: mergeEntries（台账合并）', () => {
    const entry = (ts, action, name, detail = '') => ({ ts, action, name, detail });

    it('按 ts+action+name 去重（同键主通道优先）', () => {
        const merged = mergeEntries(
            [entry(100, 'disable', 'a', 'primary')],
            [entry(100, 'disable', 'a', 'secondary')],
        );
        assert.equal(merged.length, 1);
        assert.equal(merged[0].detail, 'primary');
    });

    it('按 ts 降序（最新在前）', () => {
        const merged = mergeEntries(
            [entry(100, 'disable', 'a'), entry(300, 'enable', 'b'), entry(200, 'move', 'c')],
            [],
        );
        assert.deepEqual(merged.map(e => e.ts), [300, 200, 100]);
    });

    it('封顶 200 条（保留最新）', () => {
        const many = [];
        for (let i = 0; i < 250; i++) many.push(entry(i + 1, 'disable', `ext-${i}`));
        const merged = mergeEntries(many, []);
        assert.equal(merged.length, 200);
        assert.equal(merged[0].ts, 250);
        assert.equal(merged[199].ts, 51);
    });

    it('非法条目被过滤（坏 action / 无 ts / 非 object）', () => {
        const merged = mergeEntries(
            [
                { ts: 100, action: 'hack', name: 'x' },       // 非白名单动作
                { action: 'disable', name: 'y' },             // 无 ts
                { ts: 'abc', action: 'disable', name: 'z' },  // 非数字 ts
                null,
                'str',
                entry(50, 'enable', 'valid'),
            ],
            [],
        );
        assert.equal(merged.length, 1);
        assert.equal(merged[0].name, 'valid');
        // ts 非正数过滤
        assert.equal(mergeEntries([entry(0, 'disable', 'zero')], []).length, 0);
    });

    it('两通道合并互补（双写兜底语义）', () => {
        const primary = [entry(200, 'uninstall', 'only-primary'), entry(100, 'disable', 'both')];
        const secondary = [entry(100, 'disable', 'both'), entry(50, 'move', 'only-secondary')];
        const merged = mergeEntries(primary, secondary);
        assert.equal(merged.length, 3);
        assert.deepEqual(merged.map(e => e.name), ['only-primary', 'both', 'only-secondary']);
    });
});
