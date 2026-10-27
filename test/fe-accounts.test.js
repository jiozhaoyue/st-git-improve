// 多账号存储单测（内存存储，无网络无 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, createStoreForTesting } from '../extension/src/core/accounts.js';
import { storageForTesting } from '../extension/src/core/storage.js';
import { siteKeyOf } from '../extension/src/core/sites.js';

async function freshStore(seed = null) {
    const store = createStoreForTesting(storageForTesting(seed));
    await store.load();
    return store;
}

test('添加账号：首个账号自动成为站点默认', async () => {
    const store = await freshStore();
    const { account, siteKey } = await store.addAccount({
        type: 'github',
        username: 'octocat',
        token: 'ghp_token1',
    });
    assert.equal(account.username, 'octocat');
    assert.equal(siteKey, siteKeyOf('github', 'https://github.com'));
    assert.equal(store.snapshot().defaults[siteKey], account.id);
    // token 不应出现在 snapshot 之外……实际上 snapshot 是给 UI 的，token 保留在 state
    const saved = store.snapshot().accounts[0];
    assert.equal(saved.token, 'ghp_token1', 'UI 层需要 token（推送服务端/克隆），不上屏即可');
});

test('同站点多账号：同名拒绝、异名共存、makeDefault 切换', async () => {
    const store = await freshStore();
    const first = await store.addAccount({ type: 'github', username: 'a', token: 't1' });
    const second = await store.addAccount({ type: 'github', username: 'b', token: 't2' });
    assert.equal(store.accountsFor(first.siteKey).length, 2);
    await assert.rejects(() => store.addAccount({ type: 'github', username: 'a', token: 't3' }), /同名/);
    await store.addAccount({ type: 'github', username: 'a', token: 't3', replaceExisting: true });
    const replaced = store.accountsFor(first.siteKey).find(x => x.username === 'a');
    assert.equal(replaced.token, 't3');
    await store.setDefault(first.siteKey, second.account.id);
    const credential = await store.credentialsFor('https://github.com/a/repo.git');
    assert.equal(credential.account.username, 'b');
    assert.equal(credential.auth.username, 'b');
    assert.equal(credential.auth.password, 't2');
});

test('credentialsFor：未知站点返回 null auth；自建站点按 host 匹配', async () => {
    const store = await freshStore();
    const { account } = await store.addAccount({ type: 'gitea', baseUrl: 'https://git.example.com', username: 'ops', token: 'gt' });
    void account;
    const unknown = await store.credentialsFor('https://gitlab.com/a/b.git');
    assert.equal(unknown.auth, null);
    const known = await store.credentialsFor('https://git.example.com/ops/repo.git');
    assert.equal(known.account.username, 'ops');
    assert.equal(known.auth.password, 'gt');
});

test('删除账号：默认映射顺延到剩余账号', async () => {
    const store = await freshStore();
    const a = await store.addAccount({ type: 'github', username: 'a', token: 't1' });
    const b = await store.addAccount({ type: 'github', username: 'b', token: 't2' });
    await store.removeAccount(b.account.id);
    assert.equal(store.snapshot().defaults[a.siteKey], a.account.id, '删除默认后顺延到剩余账号');
    await store.removeAccount(a.account.id);
    assert.equal(store.snapshot().defaults[a.siteKey], undefined);
});

test('持久化往返：storage 中的状态可被新实例恢复', async () => {
    const storage = storageForTesting();
    const store1 = createStoreForTesting(storage);
    await store1.load();
    await store1.addAccount({ type: 'gitlab', username: 'gl', token: 'gl-token' });
    const store2 = createStoreForTesting(storage);
    await store2.load();
    assert.equal(store2.snapshot().accounts.length, 1);
    assert.equal(store2.snapshot().accounts[0].username, 'gl');
    assert.equal(store2.snapshot().accounts[0].token, 'gl-token');
});

test('损坏的持久化数据：回退到空状态不抛错', async () => {
    const storage = { name: 'broken', async load() { return { foo: 'bar' }; }, async save() { return true; } };
    const store = new AccountStore(storage);
    await store.load();
    assert.deepEqual(store.snapshot().accounts, []);
});

test('addFromUserinfoUrl：从地址提取并保存账号', async () => {
    const store = await freshStore();
    await store.addFromUserinfoUrl('https://octocat:ghp_x@github.com/octocat/repo.git');
    const [account] = store.snapshot().accounts;
    assert.equal(account.username, 'octocat');
    assert.equal(account.token, 'ghp_x');
    assert.equal(account.type, 'github');
    assert.equal(account.method, 'userinfo');
});

test('PAT 为空与缺站点地址被拒绝', async () => {
    const store = await freshStore();
    await assert.rejects(() => store.addAccount({ type: 'github', token: '' }), /为空/);
    await assert.rejects(() => store.addAccount({ type: 'gitea', token: 'x' }), /站点地址/);
    await assert.rejects(() => store.addAccount({ type: 'nope', token: 'x' }), /未知站点类型/);
});
