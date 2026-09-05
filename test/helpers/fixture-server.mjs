// Shared test fixture: a bare git repo served over smart-HTTP by `git
// http-backend` (parent process only; the code under test never spawns git).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} projectRoot
 * @returns {Promise<{ server: http.Server, port: number, close: () => void }>}
 */
export function startGitHttpBackend(projectRoot) {
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

/**
 * Create a bare fixture repo with one commit on main and a feature branch.
 * @param {string} fixtureRoot
 * @returns {{ repoDir: string }}
 */
export function createBareRepo(fixtureRoot) {
    const repoDir = path.join(fixtureRoot, 'hello.git');
    fs.mkdirSync(repoDir, { recursive: true });
    const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    run(['init', '--bare', '--initial-branch=main', '.'], repoDir);

    const workDir = path.join(fixtureRoot, 'work');
    fs.mkdirSync(workDir);
    run(['init', '--initial-branch=main', '.'], workDir);
    run(['config', 'user.email', 'fixture@local'], workDir);
    run(['config', 'user.name', 'fixture'], workDir);
    fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify({ display_name: 'Hello', version: '1.0.0', author: 'fixture', js: 'index.js' }));
    fs.writeFileSync(path.join(workDir, 'index.js'), '// hello extension\n');
    fs.writeFileSync(path.join(workDir, 'README'), 'st-git-improve fixture\n');
    run(['add', '.'], workDir);
    run(['commit', '-m', 'fixture commit'], workDir);
    run(['push', repoDir, 'main'], workDir);
    run(['branch', 'feature', 'main'], repoDir);
    return { repoDir };
}

/** Push a new commit to the bare repo (simulates upstream update). */
export function pushNewCommit(bareRepoDir, workDir, message, content) {
    const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    run(['fetch', 'origin'], workDir);
    run(['reset', '--hard', 'origin/main'], workDir);
    fs.writeFileSync(path.join(workDir, 'README'), content);
    run(['add', '.'], workDir);
    run(['commit', '-m', message], workDir);
    run(['push', bareRepoDir, 'main'], workDir);
}

/** Fresh worktree clone of the bare repo for authoring upstream commits. */
export function makeWorkClone(fixtureRoot, bareRepoDir) {
    const workDir = fs.mkdtempSync(path.join(fixtureRoot, 'upstream-'));
    execFileSync('git', ['clone', bareRepoDir, '.'], { cwd: workDir, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.email', 'fixture@local'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: workDir });
    return workDir;
}

/** Push a manifest version change to the bare repo (simulates upstream release). */
export function pushManifestVersion(bareRepoDir, workDir, newVersion) {
    const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    run(['fetch', 'origin'], workDir);
    run(['reset', '--hard', 'origin/main'], workDir);
    const manifestPath = path.join(workDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
    run(['add', '.'], workDir);
    run(['commit', '-m', `version ${newVersion}`], workDir);
    run(['push', bareRepoDir, 'main'], workDir);
}

export function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'stgi-e2e-'));
}
