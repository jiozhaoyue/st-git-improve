// Integration check: pure-JS git client in a child process whose PATH contains
// no git binary. The fixture server runs `git http-backend` in the PARENT
// process (test machines may have git; the tavern user's machine may not).
// Hermetic: no external network required.
//
// Run: npm run test:integration

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Tiny smart-HTTP server backed by `git http-backend` CGI (fixture only).
 * @param {string} projectRoot
 * @returns {Promise<{ server: http.Server, port: number, close: () => void }>}
 */
function startGitHttpBackend(projectRoot) {
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('error', () => response.destroy());
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const cgi = spawn('git', ['http-backend'], {
                env: {
                    ...process.env,
                    GIT_PROJECT_ROOT: projectRoot,
                    GIT_HTTP_EXPORT_ALL: '1',
                    REQUEST_METHOD: request.method,
                    PATH_INFO: decodeURIComponent(url.pathname),
                    QUERY_STRING: url.searchParams.toString(),
                    CONTENT_TYPE: request.headers['content-type'] || '',
                    CONTENT_LENGTH: String(body.length),
                    GATEWAY_INTERFACE: 'CGI/1.1',
                    SERVER_PROTOCOL: 'HTTP/1.1',
                    REMOTE_ADDR: '127.0.0.1',
                },
            });
            let headerBuffer = Buffer.alloc(0);
            let headerDone = false;
            cgi.stderr.on('data', data => console.error('[http-backend]', String(data).trim()));
            cgi.on('error', error => {
                console.error('[http-backend spawn]', error.message);
                response.statusCode = 500;
                response.end();
            });
            cgi.stdout.on('data', chunk => {
                if (headerDone) {
                    response.write(chunk);
                    return;
                }
                headerBuffer = Buffer.concat([headerBuffer, chunk]);
                const idx = headerBuffer.indexOf('\r\n\r\n');
                if (idx === -1) return;
                headerDone = true;
                const headerText = headerBuffer.slice(0, idx).toString('utf8');
                const rest = headerBuffer.slice(idx + 4);
                let status = 200;
                for (const line of headerText.split('\r\n')) {
                    const sep = line.indexOf(':');
                    if (sep === -1) continue;
                    const key = line.slice(0, sep).trim().toLowerCase();
                    const value = line.slice(sep + 1).trim();
                    if (key === 'status') {
                        status = Number(value.split(' ')[0]);
                    } else {
                        response.setHeader(key, value);
                    }
                }
                response.statusCode = status;
                if (rest.length > 0) {
                    response.write(rest);
                }
            });
            cgi.stdout.on('end', () => response.end());
            cgi.on('close', () => {
                if (!response.writableEnded) {
                    response.end();
                }
            });
            if (body.length > 0) {
                cgi.stdin.write(body);
            }
            cgi.stdin.end();
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port, close: () => server.close() });
        });
    });
}

async function createFixtureRepo() {
    const { execFileSync } = await import('node:child_process');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-fixture-'));
    const repoDir = path.join(fixtureRoot, 'hello.git');
    fs.mkdirSync(repoDir, { recursive: true });
    const run = (args, cwd = repoDir) =>
        execFileSync('git', args, { cwd, encoding: 'utf8' });
    run(['init', '--bare', '--initial-branch=main', '.']);
    // worktree to author a commit, then push into the bare repo
    const workDir = path.join(fixtureRoot, 'work');
    fs.mkdirSync(workDir);
    run(['init', '--initial-branch=main', '.'], workDir);
    run(['config', 'user.email', 'fixture@local'], workDir);
    run(['config', 'user.name', 'fixture'], workDir);
    fs.writeFileSync(path.join(workDir, 'README'), 'st-git-improve fixture\n');
    run(['add', '.'], workDir);
    run(['commit', '-m', 'fixture commit'], workDir);
    run(['push', repoDir, 'main'], workDir);
    run(['branch', 'feature', 'main'], repoDir);
    return { fixtureRoot, repoDir };
}

const childScript = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as engine from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'plugin', 'git', 'engine.js')).href)};

const base = process.env.STGI_BASE_URL;
const dir = fs.mkdtempSync(path.join(process.env.STGI_TMP, 'stgi-int-'));
try {
    const url = base + '/hello.git';
    await engine.clone({ url, dir });
    if (!fs.existsSync(path.join(dir, 'README'))) throw new Error('README missing after clone');
    const refs = await engine.listRemoteBranches({ url });
    if (!refs.some(r => r.ref === 'refs/heads/main')) throw new Error('main ref missing from advertisement');
    const oid = await engine.resolveHead({ dir });
    if (!/^[a-f0-9]{40}$/i.test(oid)) throw new Error('bad HEAD oid: ' + oid);

    // update semantics against the fixture: make no-op update return upToDate
    const branch = await engine.currentBranch({ dir });
    const remoteOid = (await engine.listRemoteBranches({ url })).find(r => r.ref === 'refs/heads/' + branch).oid;
    if (remoteOid !== oid) throw new Error('expected up-to-date clone');

    console.log('OK ' + oid.slice(0, 7));
} finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
`;

const { fixtureRoot, repoDir } = await createFixtureRepo();
const { server, port, close } = await startGitHttpBackend(fixtureRoot);

// Minimal, proxy-free environment for the child: PATH has no git binary, and
// HTTP(S)_PROXY vars are stripped — isomorphic-git's node http client honors
// them, and a stale local proxy would otherwise black-hole localhost requests.
const nodeBinDir = path.dirname(process.execPath);
const env = {
    PATH: nodeBinDir,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    STGI_TMP: os.tmpdir(),
    STGI_BASE_URL: `http://127.0.0.1:${port}`,
};

const probe = spawnSyncSafe('git', ['--version'], env);
if (!probe.error && probe.status === 0) {
    console.error('FAIL: git binary is still reachable in the restricted PATH env');
    cleanup(server, fixtureRoot);
    process.exit(1);
}
console.log('restricted env has no git binary ✔');

// The child talks to THIS process's HTTP server, so the parent event loop must
// stay free: async spawn, never spawnSync, while the fixture server is up.
const childFile = path.join(fixtureRoot, 'child-script.mjs');
fs.writeFileSync(childFile, childScript);
const child = spawn(process.execPath, [childFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
let childErr = '';
child.stdout.on('data', data => {
    childOut += String(data);
    process.stdout.write(data);
});
child.stderr.on('data', data => {
    childErr += String(data);
    process.stderr.write(data);
});
const childExit = await Promise.race([
    new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal }))),
    new Promise(resolve => setTimeout(() => resolve({ code: -1, signal: 'TIMEOUT' }), 120000)),
]);
child.kill();

const ok = childExit.code === 0 && childOut.includes('OK ');
cleanup(server, fixtureRoot);
console.log(ok ? 'integration OK ✔' : `integration FAILED ✘ (exit ${childExit.code} ${childExit.signal})`);
process.exit(ok ? 0 : 1);

function spawnSyncSafe(command, args, env) {
    try {
        return spawnSync(command, args, { env, encoding: 'utf8', shell: process.platform === 'win32' });
    } catch {
        return { error: true };
    }
}

function cleanup(server, fixtureRoot) {
    try { server.close(); } catch { /* ignore */ }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
}
