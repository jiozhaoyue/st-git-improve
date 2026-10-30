// Live E2E against a Dev instance (ST on 8001, Luker on 8003) with this
// plugin installed and enableServerPlugins on. SAFETY: refuses any base URL
// whose port is not a Dev port — Real instances live on 8002/8004.
// Run: node test/e2e-live-dev.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const BASE = process.env.ST_GIT_IMPROVE_E2E_BASE || 'http://127.0.0.1:8001';
const port = new URL(BASE).port;
const DEV_PORTS = ['8001', '8003'];
if (!DEV_PORTS.includes(port)) {
    console.error(`REFUSED: live E2E only targets Dev instances on ports ${DEV_PORTS.join('/')} (got ${port}).`);
    process.exit(2);
}
const API = `${BASE}/api/plugins/st-git-improve`;
const DEV_ROOTS = {
    '8001': 'D:\\Repo\\Tavern-repo\\Instance\\Dev\\SillyTavern',
    '8003': 'D:\\Repo\\Tavern-repo\\Instance\\Dev\\Luker',
};
const DEV_ROOT = DEV_ROOTS[port];
const LOCAL_EXT = path.join(DEV_ROOT, 'data', 'default-user', 'extensions');
const PARKED_EXT = path.join(DEV_ROOT, 'data', 'default-user', 'extensions-disabled');

/** Recursive snapshot {relPath → size} for data-integrity comparison. */
function snapshot(dir, base = dir, out = new Map()) {
    if (!fs.existsSync(dir)) {
        return out;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            snapshot(child, base, out);
        } else if (entry.isFile()) {
            out.set(path.relative(base, child).replace(/\\/g, '/'), fs.statSync(child).size);
        }
    }
    return out;
}

let csrfToken = '';
/** Node fetch (undici) has no cookie jar — track the session cookie manually. */
const cookieJar = new Map();
// Luker 等宿主的会话只能由真实页面加载建立（裸 HTTP 不落 cookie，见交接文档廿七节）——
// 允许用 ST_GIT_IMPROVE_E2E_COOKIE 注入浏览器导出的会话（格式 "name=value; name2=v2"）。
if (process.env.ST_GIT_IMPROVE_E2E_COOKIE) {
    for (const pair of String(process.env.ST_GIT_IMPROVE_E2E_COOKIE).split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
            cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
    console.log('  ↷ 已注入 ST_GIT_IMPROVE_E2E_COOKIE 会话（来自浏览器导出）');
}
function takeCookies(response) {
    for (const cookie of response.headers.getSetCookie?.() || []) {
        const [pair] = cookie.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) {
            cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
}
const cookieHeader = () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');

async function fetchCsrf() {
    if (!csrfToken) {
        const response = await fetch(`${BASE}/csrf-token`, { headers: { Cookie: cookieHeader() } });
        takeCookies(response);
        csrfToken = String((await response.json())?.token || '');
        assert.ok(csrfToken, 'csrf token obtained from /csrf-token');
    }
    return csrfToken;
}

const call = async (verb, urlPath, body) => {
    const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    if (verb !== 'GET') {
        // Same contract the panel uses: mutating requests carry the CSRF token.
        // Must run BEFORE building the Cookie header — the token fetch may be
        // what puts the session cookies into the jar in the first place.
        headers['X-CSRF-Token'] = await fetchCsrf();
    }
    headers.Cookie = cookieHeader();
    if (process.env.STGI_DEBUG) {
        console.log(`  [dbg] ${verb} ${urlPath} jar=${cookieJar.size} ck=${cookieHeader().slice(0, 40)}… tok=${(headers['X-CSRF-Token'] || '').slice(0, 8)}`);
    }
    const response = await fetch(`${API}${urlPath}`, {
        method: verb,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    takeCookies(response);
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text.slice(0, 200) };
    }
    return { status: response.status, data };
};

/**
 * Node fetch aborts responses whose headers don't arrive within 300s; the
 * batch endpoints legitimately run for minutes against many real remotes.
 * This raw channel waits as long as the server takes.
 */
const callLong = (verb, urlPath, body) => new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const run = async () => {
        const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
        if (verb !== 'GET') {
            headers['X-CSRF-Token'] = await fetchCsrf();
        }
        headers.Cookie = cookieHeader();
        return headers;
    };
    run().then(headers => new Promise((resolveRequest, rejectRequest) => {
        // BASE 可能是 https（如 Luker 8003 自签）——按协议选传输模块；https 跳过自签校验
        const insecureAgent = API.startsWith('https') ? new https.Agent({ rejectUnauthorized: false }) : undefined;
        const transport = API.startsWith('https') ? https : http;
        const request = transport.request(`${API}${urlPath}`, { method: verb, headers, agent: insecureAgent }, response => {
            takeCookies(response);
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try {
                    data = text ? JSON.parse(text) : null;
                } catch {
                    data = { raw: text.slice(0, 200) };
                }
                resolveRequest({ status: response.statusCode, data });
            });
        });
        request.on('error', rejectRequest);
        if (payload) {
            request.write(payload);
        }
        request.end();
    })).then(resolve, reject);
});

/** @param {unknown} cond @param {string} message */
function expect(cond, message) {
    if (!cond) {
        throw new Error(`LIVE E2E FAIL: ${message}`);
    }
    console.log(`  ✔ ${message}`);
}

let exitCode = 1;
const results = [];
const step = (name, fn) => results.push({ name, fn });
let disabledTarget = '';

step('health', async () => {
    const { status, data } = await call('GET', '/health');
    assert.equal(status, 200);
    expect(data.ok === true, `health ok (tavernRoot=${data.tavernRoot})`);
});

step('whoami: host identity, authenticated', async () => {
    const { status, data } = await call('GET', '/whoami');
    assert.equal(status, 200);
    expect(data.mode === 'host', `identity mode = ${data.mode}`);
    expect(data.authenticated === true, 'session authenticated (single-user auto-login)');
});

step('governance overview lists scopes and totals', async () => {
    const { status, data } = await call('GET', '/governance');
    assert.equal(status, 200);
    expect(Array.isArray(data.entries) && data.entries.length > 0, `entries: ${data.entries.map(e => `${e.scope}/${e.name}`).join(', ')}`);
    expect(typeof data.totals.localBytes === 'number' && data.totals.localBytes > 0, `localBytes=${data.totals.localBytes}`);
    expect(typeof data.parkedDir === 'string' && data.parkedDir.endsWith('extensions-disabled'), `parkedDir=${data.parkedDir}`);
});

step('governance round-trip: disable → data intact → enable', async () => {
    // pick the first non-self local extension (may be none on a fresh instance)
    const { data: before } = await call('GET', '/governance');
    const target = before.entries.find(entry => entry.scope === 'local' && entry.name !== 'st-git-improve');
    if (!target) {
        console.log('  ↷ no user-installed extension to round-trip; skipped');
        return;
    }
    disabledTarget = target.name;
    const liveDir = path.join(LOCAL_EXT, target.name);
    const beforeSnap = snapshot(liveDir);
    const beforeBytes = target.bytes;

    const { status: dStatus, data: dData } = await call('POST', '/governance/disable', { name: target.name });
    assert.equal(dStatus, 200, JSON.stringify(dData));
    expect(fs.existsSync(path.join(PARKED_EXT, target.name, 'manifest.json')) || beforeSnap.size === 0,
        'parked copy present in extensions-disabled');
    expect(!fs.existsSync(liveDir), 'host extensions dir no longer contains it');

    const parkedSnap = snapshot(path.join(PARKED_EXT, target.name));
    expect(parkedSnap.size === beforeSnap.size, `file count intact (${parkedSnap.size} files)`);

    const { status: eStatus, data: eData } = await call('POST', '/governance/enable', { name: target.name });
    assert.equal(eStatus, 200, JSON.stringify(eData));
    const afterSnap = snapshot(liveDir);
    expect(afterSnap.size === beforeSnap.size &&
        [...beforeSnap].every(([rel, size]) => afterSnap.get(rel) === size),
        `content byte-identical after round-trip (${afterSnap.size} files)`);
    expect(Math.abs(eData.bytes - beforeBytes) < 8, 'reported bytes consistent');
});

step('batch disable-all / enable-all with panel skip', async () => {
    const { status: dStatus, data: dData } = await call('POST', '/governance/disable-all', {});
    assert.equal(dStatus, 200, JSON.stringify(dData));
    expect(!dData.disabled.includes('st-git-improve'), 'manager panel never batch-disabled');
    expect(fs.existsSync(path.join(LOCAL_EXT, 'st-git-improve', 'manifest.json')), 'panel still live after disable-all');
    const parkedNames = fs.existsSync(PARKED_EXT) ? fs.readdirSync(PARKED_EXT) : [];
    expect(dData.disabled.every(name => parkedNames.includes(name)), `batch parked: ${dData.disabled.join(', ') || '(none)'}`);

    const { status: eStatus, data: eData } = await call('POST', '/governance/enable-all', {});
    assert.equal(eStatus, 200, JSON.stringify(eData));
    expect(eData.enabled.every(name => fs.existsSync(path.join(LOCAL_EXT, name))), `batch restored: ${eData.enabled.join(', ') || '(none)'}`);
    const leftover = fs.existsSync(PARKED_EXT) ? fs.readdirSync(PARKED_EXT) : [];
    expect(leftover.length === 0, 'parking area empty after enable-all');
});

step('ledger recorded every action', async () => {
    const ledgerPath = path.join(DEV_ROOT, 'data', 'default-user', 'git-improve', 'governance.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const actions = ledger.actions.map(a => a.action);
    expect(actions.includes('disable') && actions.includes('enable'), `ledger actions: ${actions.slice(-6).join(', ')}`);
});

step('purge negative tests: no-confirm 400, unknown 404', async () => {
    const noConfirm = await call('DELETE', '/governance/parked', { name: 'whatever' });
    assert.equal(noConfirm.status, 400);
    expect(noConfirm.status === 400, 'purge without confirm rejected');
    const unknown = await call('DELETE', '/governance/parked', { name: 'definitely-not-here', confirm: true });
    assert.equal(unknown.status, 404);
    expect(unknown.status === 404, 'purge unknown name → 404');
});

step('update-all runs across scopes and categorizes results', async () => {
    const { status, data } = await callLong('POST', '/update-all', {});
    assert.equal(status, 200);
    const summary = `updated=${data.updated.length} upToDate=${data.upToDate.length} failed=${data.failed.length}`;
    expect(typeof summary === 'string', summary);
    expect(!data.failed.some(f => f.name === 'st-git-improve'), 'self plugin excluded from update-all');
    if (data.failed.length > 0) {
        console.log(`  ℹ failures: ${data.failed.map(f => `${f.name}: ${f.error.slice(0, 80)}`).join(' | ')}`);
    }
});

step('diagnose (with remote probe) returns entries', async () => {
    const { status, data } = await callLong('GET', '/diagnose?remote=1');
    assert.equal(status, 200);
    expect(Array.isArray(data.entries) && data.entries.length > 0, `diagnose entries: ${data.entries.length}`);
});

step('backups negative test: unknown extension 404', async () => {
    const { status } = await call('GET', '/backups?target=extension&name=definitely-not-here');
    assert.equal(status, 404);
    expect(status === 404, 'backups of unknown dir → 404');
});

try {
    console.log(`LIVE E2E against ${API}\n`);
    for (const { name, fn } of results) {
        console.log(`▶ ${name}`);
        await fn();
    }
    console.log('\nLIVE E2E ALL PASS ✔');
    exitCode = 0;
} catch (error) {
    console.error('\nLIVE E2E FAILED:', error?.message || error);
    exitCode = 1;
} finally {
    // safety net: if we parked something and died mid-test, bring it back
    if (disabledTarget && !fs.existsSync(path.join(LOCAL_EXT, disabledTarget)) &&
        fs.existsSync(path.join(PARKED_EXT, disabledTarget))) {
        console.log(`safety-net: restoring parked ${disabledTarget}`);
        await call('POST', '/governance/enable', { name: disabledTarget }).catch(() => {});
    }
    process.exit(exitCode);
}
