// selfupdate 纯逻辑单测：origin 解析、base64 UTF-8 解码、版本比较、检查流程（mock fetch）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    originRepoFromHome,
    decodeBase64Utf8,
    compareVersions,
    checkSelfUpdate,
} from '../extension/src/core/selfupdate.js';

function b64(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

function manifestResponse(manifest) {
    const body = { encoding: 'base64', content: b64(JSON.stringify(manifest)) };
    return { ok: true, status: 200, json: async () => body };
}

describe('selfupdate: originRepoFromHome', () => {
    it('解析 github 主页 URL（含 .git 后缀与子路径）', () => {
        assert.equal(originRepoFromHome('https://github.com/jiozhaoyue/st-git-improve'), 'jiozhaoyue/st-git-improve');
        assert.equal(originRepoFromHome('https://github.com/a/b.git'), 'a/b');
        assert.equal(originRepoFromHome('http://github.com/Owner/Repo/tree/main'), 'Owner/Repo');
    });

    it('非 github 形态返回 null', () => {
        assert.equal(originRepoFromHome('https://gitee.com/a/b'), null);
        assert.equal(originRepoFromHome(''), null);
        assert.equal(originRepoFromHome(undefined), null);
    });
});

describe('selfupdate: decodeBase64Utf8', () => {
    it('ASCII 与 UTF-8（中文）往返', () => {
        assert.equal(decodeBase64Utf8(b64('{"version":"0.8.5"}')), '{"version":"0.8.5"}');
        assert.equal(decodeBase64Utf8(b64('{"display_name":"Git 源管理"}')), '{"display_name":"Git 源管理"}');
    });

    it('容忍换行填充', () => {
        const wrapped = b64('hello world').replace(/(.{4})/g, '$1\n');
        assert.equal(decodeBase64Utf8(wrapped), 'hello world');
    });
});

describe('selfupdate: compareVersions', () => {
    it('三段比较语义', () => {
        assert.equal(compareVersions('0.8.5', '0.8.4'), 1);
        assert.equal(compareVersions('0.8.4', '0.8.5'), -1);
        assert.equal(compareVersions('0.8.4', '0.8.4'), 0);
        assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
        assert.equal(compareVersions('', '0.8.4'), -1);
    });
});

describe('selfupdate: checkSelfUpdate（mock fetch，无网络）', () => {
    const CURRENT = '0.8.5';

    it('远端同版本 → ok 且 upToDate', async () => {
        const calls = [];
        const f = async url => { calls.push(url); return manifestResponse({ version: CURRENT }); };
        const result = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'jiozhaoyue/st-git-improve', fetchImpl: f });
        assert.equal(result.ok, true);
        assert.equal(result.upToDate, true);
        assert.equal(result.latest, CURRENT);
        assert.match(calls[0], /api\.github\.com\/repos\/jiozhaoyue\/st-git-improve\/contents\/extension\/manifest\.json/);
    });

    it('远端更新 → upToDate=false 且 note 提示有新版本', async () => {
        const f = async () => manifestResponse({ version: '0.9.0' });
        const result = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'a/b', fetchImpl: f });
        assert.equal(result.upToDate, false);
        assert.equal(result.note, '有新版本');
        assert.equal(result.url, 'https://github.com/a/b');
    });

    it('404 / 403 / 网络异常 → ok=false 带可读 note', async () => {
        const r404 = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'a/b', fetchImpl: async () => ({ ok: false, status: 404 }) });
        assert.equal(r404.ok, false);
        assert.match(r404.note, /404/);
        const r403 = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'a/b', fetchImpl: async () => ({ ok: false, status: 403 }) });
        assert.match(r403.note, /限流/);
        const rNet = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'a/b', fetchImpl: async () => { throw new Error('offline'); } });
        assert.match(rNet.note, /offline/);
    });

    it('响应形态异常（非 base64 / 坏 JSON / 无版本号）→ ok=false', async () => {
        const bad1 = await checkSelfUpdate({
            currentVersion: CURRENT, repo: 'a/b',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ encoding: 'none', content: 'x' }) }),
        });
        assert.match(bad1.note, /形态异常/);
        const bad2 = await checkSelfUpdate({
            currentVersion: CURRENT, repo: 'a/b',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ encoding: 'base64', content: b64('not-json') }) }),
        });
        assert.match(bad2.note, /解析失败/);
        const bad3 = await checkSelfUpdate({
            currentVersion: CURRENT, repo: 'a/b',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ encoding: 'base64', content: b64('{"display_name":"x"}') }) }),
        });
        assert.match(bad3.note, /无版本号/);
    });

    it('仓库标识非法 → 直接拒绝', async () => {
        const result = await checkSelfUpdate({ currentVersion: CURRENT, repo: 'not a repo', fetchImpl: async () => { throw new Error('不应被调用'); } });
        assert.equal(result.ok, false);
        assert.match(result.note, /仓库标识无效/);
    });
});
