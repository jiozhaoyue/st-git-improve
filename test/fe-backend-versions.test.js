// 版本比较单测（面板回退守卫用）
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../extension/src/core/backend.js';

test('compareVersions 三段比较', () => {
    assert.equal(compareVersions('0.6.2', '0.8.0'), -1);
    assert.equal(compareVersions('0.8.0', '0.8.0'), 0);
    assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
    assert.equal(compareVersions('0.8', '0.8.0'), 0);
    assert.equal(compareVersions('', '0.8.0'), -1);
});
