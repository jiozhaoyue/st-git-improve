// 浏览器内存文件系统单测（isomorphic-git fs 子集语义）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemfs } from '../extension/src/core/memfs.js';

const enc = new TextEncoder();

test('mkdir/writeFile/readFile 基本闭环（utf8 与字节）', async () => {
    const fs = createMemfs();
    await fs.mkdir('/repo', { recursive: true });
    await fs.writeFile('/repo/a.txt', 'hello', {});
    assert.equal(await fs.readFile('/repo/a.txt', { encoding: 'utf8' }), 'hello');
    assert.equal(await fs.readFile('/repo/a.txt', 'utf8'), 'hello');
    const bytes = await fs.readFile('/repo/a.txt', {});
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual([...bytes], [...enc.encode('hello')]);
});

test('mkdir 非递归：EEXIST / ENOENT', async () => {
    const fs = createMemfs();
    await fs.mkdir('/a', { recursive: true });
    await assert.rejects(() => fs.mkdir('/a'), /EEXIST/);
    await assert.rejects(() => fs.mkdir('/x/y'), /ENOENT/);
});

test('readFile 缺失 → ENOENT；目录 → EISDIR', async () => {
    const fs = createMemfs();
    await fs.mkdir('/d', { recursive: true });
    await assert.rejects(() => fs.readFile('/d/nope'), /ENOENT/);
    await assert.rejects(() => fs.readFile('/d'), /EISDIR/);
});

test('readdir 只返回直接子项', async () => {
    const fs = createMemfs();
    fs.setFile('/root/a.txt', '1');
    fs.setFile('/root/sub/b.txt', '2');
    const names = await fs.readdir('/root');
    assert.deepEqual(names.sort(), ['a.txt', 'sub']);
    const sub = await fs.readdir('/root/sub');
    assert.deepEqual(sub, ['b.txt']);
});

test('stat 语义：目录/文件/符号链接', async () => {
    const fs = createMemfs();
    fs.setFile('/f.txt', 'x');
    await fs.symlink('/f.txt', '/link.txt');
    const dirStat = await fs.stat('/');
    assert.equal(dirStat.isDirectory(), true);
    const fileStat = await fs.lstat('/f.txt');
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.size, 1);
    const linkStat = await fs.stat('/link.txt');
    assert.equal(linkStat.isSymbolicLink(), true);
    assert.equal(await fs.readlink('/link.txt'), '/f.txt');
});

test('rmdir：非空目录拒绝，空目录可删', async () => {
    const fs = createMemfs();
    fs.setFile('/d/f.txt', 'x');
    await assert.rejects(() => fs.rmdir('/d'), /ENOTEMPTY/);
    await fs.unlink('/d/f.txt');
    await fs.rmdir('/d');
    await assert.rejects(() => fs.stat('/d'), /ENOENT/);
});

test('listFilesDeep：递归、跳过 .git、相对前缀', () => {
    const fs = createMemfs();
    fs.setFile('/repo/index.js', 'a');
    fs.setFile('/repo/.git/config', 'b');
    fs.setFile('/repo/lib/deep.js', 'c');
    const files = fs.listFilesDeep('/repo', ['.git']);
    assert.deepEqual(files.sort(), ['/repo/index.js', '/repo/lib/deep.js']);
});

test('fileData 同步读取；目录返回 null', () => {
    const fs = createMemfs();
    fs.setFile('/f.txt', 'x');
    assert.deepEqual([...fs.fileData('/f.txt')], [...enc.encode('x')]);
    assert.equal(fs.fileData('/'), null);
    assert.equal(fs.fileData('/missing'), null);
});

test('promises 别名与直接方法等价（isomorphic-git 双通道调用）', async () => {
    const fs = createMemfs();
    fs.setFile('/f.txt', 'x');
    assert.equal(await fs.promises.readFile('/f.txt', { encoding: 'utf8' }), 'x');
    assert.equal(typeof fs.promises.symlink, 'function');
    assert.equal(typeof fs.promises.readlink, 'function');
});
