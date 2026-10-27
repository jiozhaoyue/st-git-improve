// 纯前端 zip 写入器单测（store-only + central directory 解析校验）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, readZip, crc32 } from '../extension/src/core/zip.js';

const enc = new TextEncoder();

test('crc32 标准向量', () => {
    assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
});

test('buildZip/readZip 往返：多文件、中文文件名、空文件', () => {
    const entries = [
        { path: 'manifest.json', data: enc.encode('{"display_name":"测试"}') },
        { path: 'index.js', data: enc.encode('console.log("hi");\n') },
        { path: 'i18n/中文目录/条目.txt', data: enc.encode('内容') },
        { path: 'empty.bin', data: new Uint8Array(0) },
    ];
    const bytes = buildZip(entries);
    const parsed = readZip(bytes);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed.map(e => e.path), ['manifest.json', 'index.js', 'i18n/中文目录/条目.txt', 'empty.bin']);
    for (const entry of parsed) {
        assert.equal(entry.method, 0, '必须为 store 方法');
        const original = entries.find(e => e.path === entry.path).data;
        assert.equal(entry.size, original.length);
        assert.equal(entry.crc32, crc32(original));
        assert.deepEqual(entry.data, original);
    }
});

test('zip 结构头签名正确（PK\\x03\\x04 / PK\\x01\\x02 / PK\\x05\\x06）', () => {
    const bytes = buildZip([{ path: 'a.txt', data: enc.encode('x') }]);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(bytes[2], 0x03);
    assert.equal(bytes[3], 0x04);
    // 尾部 EOCD
    assert.deepEqual([...bytes.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);
});

test('readZip 拒绝非 zip 数据', () => {
    assert.throws(() => readZip(enc.encode('this is not a zip file at all........')), /EOCD/);
});

test('readZip 检出 CRC 篡改', () => {
    const bytes = buildZip([{ path: 'a.txt', data: enc.encode('payload') }]);
    // 破坏数据区第一个字节（local header 30 字节 + 文件名 5 字节 = 数据从 35 开始）
    const corrupted = bytes.slice();
    corrupted[35] = (corrupted[35] + 1) & 0xFF;
    assert.throws(() => readZip(corrupted), /CRC/);
});

test('buildZip 拒绝空路径', () => {
    assert.throws(() => buildZip([{ path: '', data: enc.encode('x') }]), /路径/);
});

test('路径反斜杠与开头斜杠被归一化', () => {
    const parsed = readZip(buildZip([{ path: '\\sub\\file.txt', data: enc.encode('x') }]));
    assert.equal(parsed[0].path, 'sub/file.txt');
});
