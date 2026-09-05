// ST Git Improve — supplementary front-end panel.
// Adds an "Git 源管理" entry to the Extensions menu. Does not modify any
// native extension-management behavior.

const API = '/api/plugins/st-git-improve';

const SITE_TYPES = [
    { id: 'gitea', label: 'Gitea / Forgejo（含自建）', needsBase: true },
    { id: 'github', label: 'GitHub', needsBase: false },
    { id: 'gitlab', label: 'GitLab', needsBase: false },
    { id: 'gitee', label: 'Gitee', needsBase: false },
];

function toast(msg, kind = 'info') {
    const toastr = window.toastr;
    if (toastr) {
        toastr[kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'](msg, 'Git 源管理');
    } else {
        console.log(`[st-git-improve] ${kind}: ${msg}`);
    }
}

async function api(path, options = {}) {
    const init = { headers: {}, ...options };
    if (init.body !== undefined) {
        init.method = init.method || 'POST';
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(init.body);
    }
    const response = await fetch(`${API}${path}`, init);
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!response.ok) {
        throw new Error(data?.error || text || `${response.status} ${response.statusText}`);
    }
    return data;
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---------------------------------------------------------------- tabs

function tabSites(root) {
    const section = el(`
        <div>
            <div class="stgi-note">为需要登录的 git 站点保存凭据。凭据只存本机（酒馆数据目录），不会写入任何仓库地址。</div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <select data-role="type" style="flex:0 0 200px">
                        ${SITE_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
                    </select>
                    <input data-role="baseUrl" placeholder="站点地址，如 https://git.example.com" style="display:none" />
                    <input data-role="username" placeholder="用户名（可选）" />
                </div>
                <div class="stgi-row" data-role="patRow">
                    <input data-role="token" placeholder="访问令牌 (PAT)" type="password" />
                    <button class="stgi-btn primary" data-role="savePat">保存 PAT</button>
                </div>
                <div class="stgi-row" data-role="passwordRow">
                    <input data-role="password" placeholder="账号密码（自动换取 token，仅 Gitea/Forgejo）" type="password" />
                    <button class="stgi-btn" data-role="savePassword">登录并保存</button>
                </div>
                <div class="stgi-row" data-role="deviceRow">
                    <button class="stgi-btn" data-role="deviceStart">设备码登录（GitHub / GitLab）</button>
                    <span data-role="deviceHint" class="stgi-note"></span>
                </div>
                <div class="stgi-row" data-role="userinfoRow">
                    <input data-role="userinfoUrl" placeholder="或直接粘贴 https://user:token@host/... 形式的地址，自动提取" />
                    <button class="stgi-btn" data-role="saveUserinfo">提取保存</button>
                </div>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>站点</th><th>类型</th><th>方式</th><th>状态</th><th>操作</th></tr>
            </thead><tbody data-role="siteRows"></tbody></table>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    const typeSelect = q('type');

    function refreshBaseVisibility() {
        const type = SITE_TYPES.find(t => t.id === typeSelect.value);
        q('baseUrl').style.display = type?.needsBase ? '' : 'none';
    }
    typeSelect.addEventListener('change', refreshBaseVisibility);
    refreshBaseVisibility();

    async function reload() {
        const { sites } = await api('/sites');
        const rows = q('siteRows');
        rows.innerHTML = '';
        for (const site of sites) {
            const row = el(`<tr>
                <td>${esc(site.host)}<div class="stgi-note">${esc(site.note || '')}</div></td>
                <td>${esc(site.type)}</td>
                <td>${esc(site.method)}</td>
                <td>${site.hasToken ? '<span class="stgi-badge good">已保存</span>' : '<span class="stgi-badge bad">无 token</span>'}</td>
                <td>
                    <button class="stgi-btn" data-act="test">测试</button>
                    <button class="stgi-btn" data-act="del">删除</button>
                </td>
            </tr>`);
            row.querySelector('[data-act="test"]').addEventListener('click', async () => {
                toast('测试中…');
                try {
                    const result = await api(`/sites/${site.id}/test`, { body: {} });
                    toast(result.ok ? `有效（${result.login || 'ok'}）` : `无效（HTTP ${result.status}）`, result.ok ? 'success' : 'error');
                } catch (error) {
                    toast(String(error.message || error), 'error');
                }
            });
            row.querySelector('[data-act="del"]').addEventListener('click', async () => {
                await api(`/sites/${site.id}`, { method: 'DELETE' });
                toast('已删除', 'success');
                reload();
            });
            rows.append(row);
        }
    }

    function currentBase() {
        const type = SITE_TYPES.find(t => t.id === typeSelect.value);
        return {
            type: typeSelect.value,
            baseUrl: q('baseUrl').value.trim() || (type?.needsBase ? '' : `https://${typeSelect.value === 'github' ? 'github.com' : typeSelect.value === 'gitlab' ? 'gitlab.com' : 'gitee.com'}`),
            username: q('username').value.trim(),
        };
    }

    q('savePat').addEventListener('click', async () => {
        const base = currentBase();
        try {
            await api('/sites', { body: { ...base, method: 'pat', token: q('token').value.trim() } });
            toast('已保存', 'success');
            q('token').value = '';
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('savePassword').addEventListener('click', async () => {
        const base = currentBase();
        try {
            await api('/sites', { body: { ...base, method: 'password', password: q('password').value } });
            toast('登录成功，token 已保存', 'success');
            q('password').value = '';
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('saveUserinfo').addEventListener('click', async () => {
        try {
            await api('/sites', { body: { method: 'userinfo', url: q('userinfoUrl').value.trim(), note: q('username').value.trim() } });
            toast('已提取并保存', 'success');
            q('userinfoUrl').value = '';
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    let polling = false;
    q('deviceStart').addEventListener('click', async () => {
        if (polling) return;
        const base = currentBase();
        try {
            const flow = await api('/device/start', { body: { type: base.type, baseUrl: base.baseUrl, username: base.username } });
            window.open(flow.verifyUrlComplete || flow.verifyUrl, '_blank');
            q('deviceHint').textContent = `请在浏览器输入代码: ${flow.userCode}`;
            polling = true;
            const pollOnce = async () => {
                if (!polling) return;
                try {
                    const result = await api('/device/poll', { body: { flowId: flow.flowId, type: base.type, baseUrl: base.baseUrl, username: base.username } });
                    if (result.status === 'granted') {
                        toast('登录成功，token 已保存', 'success');
                        polling = false;
                        q('deviceHint').textContent = '';
                        reload();
                        return;
                    }
                    if (result.status === 'expired') {
                        toast('设备码已过期', 'error');
                        polling = false;
                        q('deviceHint').textContent = '';
                        return;
                    }
                } catch (error) {
                    toast(String(error.message || error), 'error');
                    polling = false;
                    q('deviceHint').textContent = '';
                    return;
                }
                setTimeout(pollOnce, Math.max(2, flow.interval) * 1000);
            };
            setTimeout(pollOnce, Math.max(2, flow.interval) * 1000);
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    reload();
    return section;
}

function tabInstall(root) {
    const section = el(`
        <div>
            <div class="stgi-note">安装私有/任意 http(s) git 仓库。目标站点已在「站点凭据」中保存登录时自动认证。前端扩展装到当前用户，服务端插件装到 plugins/。</div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <input data-role="url" placeholder="仓库地址 https://..." style="flex:3 1 260px" />
                    <input data-role="branch" placeholder="分支（可选）" style="flex:0 1 120px" />
                    <select data-role="target" style="flex:0 0 150px">
                        <option value="extension">用户扩展</option>
                        <option value="global">全局扩展</option>
                        <option value="plugin">服务端插件</option>
                    </select>
                </div>
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="replace" /> 目录已存在时替换重装</label>
                </div>
                <details>
                    <summary class="stgi-note" style="cursor:pointer">高级选项</summary>
                    <div class="stgi-row">
                        <label><input type="checkbox" data-role="force" /> 强制本地安装（覆盖重复检测；全局已有同名/同版本扩展时仍要装本地副本）</label>
                    </div>
                </details>
                <div class="stgi-row">
                    <button class="stgi-btn primary" data-role="go">安装</button>
                </div>
                <div class="stgi-log" data-role="log" style="display:none"></div>
            </div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    q('go').addEventListener('click', async () => {
        const button = q('go');
        button.disabled = true;
        const log = q('log');
        log.style.display = '';
        log.textContent = '安装中…';
        try {
            const result = await api('/install', {
                body: {
                    url: q('url').value.trim(),
                    branch: q('branch').value.trim() || undefined,
                    target: q('target').value,
                    replace: q('replace').checked,
                    force: q('force').checked,
                },
            });
            log.textContent = `安装完成: ${result.name}\n提交: ${(result.oid || '').slice(0, 7)}`;
            toast('安装完成，刷新页面后生效', 'success');
        } catch (error) {
            log.textContent = `失败: ${error.message || error}`;
            toast(String(error.message || error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    const whoami = await getWhoami();
    if (whoami.canForce === false) {
        q('force').closest('.stgi-row').style.display = 'none';
        q('force').closest('details').insertAdjacentHTML('beforeend',
            '<div class="stgi-note">当前登录用户非管理员：重复检测始终生效，强制覆盖不可用。</div>');
    }
    return section;
}

async function tabDiagnose(root) {
    const section = el(`
        <div>
            <div class="stgi-note">扫描已装扩展与服务端插件。更新时本地改动会自动备份；依赖修复可对插件目录或酒馆本体重跑 npm install。</div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="reload">扫描（含远端检查）</button>
                <label><input type="checkbox" data-role="tavern" /> 显示本体依赖修复</label>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>名称</th><th>类型</th><th>状态</th><th>操作</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
            <div class="stgi-section" data-role="tavernDeps" style="display:none">
                <div class="stgi-note">酒馆本体依赖（package.json / package-lock.json 损坏或 registry 不可达导致的启动失败，可在此修复）</div>
                <div class="stgi-row">
                    <button class="stgi-btn" data-role="fixTavern">重跑 npm install</button>
                    <button class="stgi-btn" data-role="fixTavernLock">lock 重建（删 lock+node_modules）</button>
                </div>
            </div>
            <div class="stgi-section" data-role="dedupSection">
                <div class="stgi-note">重复检测：本地与全局同名扩展（本地会遮蔽全局版，浪费服务器空间；数据包导入后建议扫描一次）</div>
                <div class="stgi-row">
                    <button class="stgi-btn" data-role="scanDedup">扫描重复项</button>
                </div>
                <table class="stgi-table" data-role="dedupTable" style="display:none"><thead>
                    <tr><th>扩展</th><th>本地版本 → 全局版本</th><th>本地占用</th><th>操作</th></tr>
                </thead><tbody data-role="dedupRows"></tbody></table>
            </div>
            <div class="stgi-log" data-role="log" style="display:none"></div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);

    async function reload() {
        const rows = q('rows');
        rows.innerHTML = '<tr><td colspan="4">扫描中…</td></tr>';
        try {
            const { entries } = await api('/diagnose?remote=1');
            rows.innerHTML = '';
            if (entries.length === 0) {
                rows.innerHTML = '<tr><td colspan="4">未发现任何扩展/插件</td></tr>';
            }
            for (const entry of entries) {
                const badges = [];
                badges.push(entry.isRepo ? '<span class="stgi-badge good">git</span>' : '<span class="stgi-badge warn">非git</span>');
                if (entry.manifestOk === false) badges.push('<span class="stgi-badge bad">manifest损坏</span>');
                if (entry.depsMissing) badges.push('<span class="stgi-badge bad">依赖缺失</span>');
                if (entry.dirtyFiles.length > 0) badges.push(`<span class="stgi-badge warn">本地改动×${entry.dirtyFiles.length}</span>`);
                if (entry.remoteReachable === false) badges.push('<span class="stgi-badge bad">远端不可达</span>');
                if (entry.branch && entry.remoteReachable !== false && entry.dirtyFiles.length === 0) badges.push('<span class="stgi-badge good">正常</span>');

                const row = el(`<tr>
                    <td>${esc(entry.name)}<div class="stgi-note">${esc(entry.branch || '')} ${esc((entry.oid || '').slice(0, 7))}</div></td>
                    <td>${entry.target === 'plugin' ? '插件' : entry.target === 'global' ? '全局扩展' : '扩展'}</td>
                    <td>${badges.join(' ')}${entry.issues.length ? `<div class="stgi-note">${entry.issues.map(esc).join('；')}</div>` : ''}</td>
                    <td>
                        ${entry.isRepo ? '<button class="stgi-btn" data-act="update">更新</button>' : ''}
                        ${entry.target === 'plugin' || entry.depsMissing ? '<button class="stgi-btn" data-act="deps">依赖修复</button>' : ''}
                        ${entry.isRepo ? '<button class="stgi-btn" data-act="backups">备份恢复</button>' : ''}
                    </td>
                </tr>`);
                const act = (action, body = {}) => api(action, { body: { target: entry.target, name: entry.name, ...body } });
                row.querySelector('[data-act="update"]')?.addEventListener('click', async event => {
                    const button = event.target;
                    button.disabled = true;
                    try {
                        const result = await act('/update');
                        toast(result.upToDate ? '已是最新' : `已更新${result.backupRef ? '（本地改动已备份）' : ''}`, 'success');
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                    } finally {
                        button.disabled = false;
                    }
                });
                row.querySelector('[data-act="deps"]')?.addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        await act('/deps');
                        toast('依赖安装完成', 'success');
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                    } finally {
                        event.target.disabled = false;
                    }
                });
                row.querySelector('[data-act="backups"]')?.addEventListener('click', async () => {
                    openDialog(`备份恢复 — ${entry.name}`, tabBackups(entry));
                });
                rows.append(row);
            }
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="4">扫描失败: ${esc(String(error.message || error))}</td></tr>`;
        }
    }

    q('reload').addEventListener('click', reload);
    q('tavern').addEventListener('change', () => {
        q('tavernDeps').style.display = q('tavern').checked ? '' : 'none';
    });

    const fixTavern = rebuildLock => async event => {
        const button = event.target;
        button.disabled = true;
        const log = q('log');
        log.style.display = '';
        log.textContent = 'npm install 运行中…';
        try {
            const result = await api('/deps', { body: { preset: 'tavern', rebuildLock } });
            log.textContent = result.skipped ? '本体无 package.json？' : `完成\n${(result.logTail || []).join('\n')}`;
            toast('本体依赖修复完成，建议重启酒馆', 'success');
        } catch (error) {
            log.textContent = `失败: ${error.message || error}`;
            toast(String(error.message || error), 'error');
        } finally {
            button.disabled = false;
        }
    };
    q('fixTavern').addEventListener('click', fixTavern(false));
    q('fixTavernLock').addEventListener('click', fixTavern(true));

    q('scanDedup').addEventListener('click', async () => {
        const button = q('scanDedup');
        button.disabled = true;
        try {
            const [{ duplicates }, whoami] = await Promise.all([api('/dedup'), getWhoami()]);
            const table = q('dedupTable');
            const rows = q('dedupRows');
            table.style.display = '';
            rows.innerHTML = '';
            if (duplicates.length === 0) {
                rows.innerHTML = '<tr><td colspan="4">未发现本地与全局重复的扩展</td></tr>';
                return;
            }
            for (const dup of duplicates) {
                const dirtyBadge = dup.dirtyCount > 0
                    ? ` <span class="stgi-badge warn">本地改动×${dup.dirtyCount}</span>`
                    : '';
                const canForceDelete = whoami.canForce !== false;
                const forceLabel = dup.dirtyCount > 0 && canForceDelete
                    ? '<label><input type="checkbox" data-role="forceDel" /> 强制</label>'
                    : '';
                const adminHint = dup.dirtyCount > 0 && !canForceDelete
                    ? '<div class="stgi-note">有本地改动，需管理员强制删除</div>'
                    : '';
                const row = el(`<tr>
                    <td>${esc(dup.name)}</td>
                    <td>${esc(dup.localVersion || '?')} → ${esc(dup.globalVersion || '?')}${dirtyBadge}${adminHint}</td>
                    <td>${humanBytes(dup.localSize)}</td>
                    <td>
                        ${forceLabel}
                        <button class="stgi-btn">删除本地副本</button>
                    </td>
                </tr>`);
                row.querySelector('button').addEventListener('click', async event => {
                    const deleteButton = event.target;
                    deleteButton.disabled = true;
                    try {
                        await api('/dedup', {
                            method: 'DELETE',
                            body: {
                                name: dup.name,
                                force: row.querySelector('[data-role="forceDel"]')?.checked === true,
                            },
                        });
                        toast(`已删除本地副本 ${dup.name}，全局版继续可用`, 'success');
                        q('scanDedup').click();
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                    } finally {
                        deleteButton.disabled = false;
                    }
                });
                rows.append(row);
            }
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    reload();
    return section;
}

function tabBackups(entry) {
    const section = el(`
        <div>
            <div class="stgi-note">${esc(entry.name)} 的本地改动备份（存在扩展自己的 .git 内）。恢复会把工作区回滚到备份点。</div>
            <table class="stgi-table"><thead><tr><th>备份</th><th>提交</th><th>操作</th></tr></thead>
            <tbody data-role="rows"><tr><td colspan="3">加载中…</td></tr></tbody></table>
        </div>`);

    const rows = section.querySelector('[data-role="rows"]');
    api(`/backups?target=${encodeURIComponent(entry.target)}&name=${encodeURIComponent(entry.name)}`)
        .then(({ backups }) => {
            rows.innerHTML = '';
            if (backups.length === 0) {
                rows.innerHTML = '<tr><td colspan="3">没有备份记录</td></tr>';
                return;
            }
            for (const backup of backups) {
                const row = el(`<tr>
                    <td>${esc(backup.ref.replace('refs/git-improve/backup/', ''))}</td>
                    <td>${esc(backup.oid.slice(0, 7))}</td>
                    <td><button class="stgi-btn">恢复</button></td>
                </tr>`);
                row.querySelector('button').addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        await api('/recover', { body: { target: entry.target, name: entry.name, backupRef: backup.ref } });
                        toast('已恢复，刷新页面生效', 'success');
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                    } finally {
                        event.target.disabled = false;
                    }
                });
                rows.append(row);
            }
        })
        .catch(error => {
            rows.innerHTML = `<tr><td colspan="3">加载失败: ${esc(String(error.message || error))}</td></tr>`;
        });
    return section;
}

function humanBytes(n) {
    if (!Number.isFinite(n)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

let whoamiCache = null;
async function getWhoami() {
    if (!whoamiCache) {
        try {
            whoamiCache = await api('/whoami');
        } catch {
            whoamiCache = { mode: 'unknown', canForce: true };
        }
    }
    return whoamiCache;
}

function tabSettings(root) {
    const section = el(`
        <div>
            <div class="stgi-note">git 流量的代理开关。默认「直连」——完全不依赖环境；「跟随环境变量」读取 HTTP(S)_PROXY/NO_PROXY（回环地址始终豁免）；「自定义」对包括本机地址在内的所有 git 请求使用指定 http(s) 代理。</div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <label><input type="radio" name="stgiProxy" value="direct" /> 直连（默认）</label>
                    <label><input type="radio" name="stgiProxy" value="env" /> 跟随环境变量</label>
                    <label><input type="radio" name="stgiProxy" value="url" /> 自定义代理</label>
                </div>
                <div class="stgi-row">
                    <input data-role="proxyUrl" placeholder="代理地址，如 http://127.0.0.1:7891" />
                    <button class="stgi-btn primary" data-role="save">保存代理</button>
                </div>
                <div class="stgi-note" data-role="current"></div>
            </div>
            <div class="stgi-section">
                <div class="stgi-note"><b>安装去重颗粒度</b>：全局（管理员）已装同名扩展时阻止本地重复安装，节省服务器空间。「仓库名+版本号」仅在版本相同时阻止，允许本地安装不同版本。</div>
                <div class="stgi-row">
                    <label><input type="radio" name="stgiDedup" value="name" /> 仓库名（默认）</label>
                    <label><input type="radio" name="stgiDedup" value="name+version" /> 仓库名 + 版本号</label>
                    <button class="stgi-btn" data-role="saveDedup">保存去重设置</button>
                </div>
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="autoDedup" /> 启动时自动清理（仅删除无本地改动的重复副本，有改动的跳过并在日志提示）</label>
                </div>
                <div class="stgi-note" data-role="dedupCurrent"></div>
            </div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    const radios = section.querySelectorAll('input[name="stgiProxy"]');
    const dedupRadios = section.querySelectorAll('input[name="stgiDedup"]');

    function currentRadio() {
        for (const radio of radios) {
            if (radio.checked) return radio.value;
        }
        return 'direct';
    }

    (async () => {
        try {
            const { proxy, dedupGranularity, autoDedup } = await api('/settings');
            let mode = 'direct';
            if (proxy === 'env') mode = 'env';
            else if (proxy && proxy !== 'direct') mode = 'url';
            section.querySelector(`input[name="stgiProxy"][value="${mode}"]`).checked = true;
            if (mode === 'url') q('proxyUrl').value = proxy;
            q('current').textContent = `当前生效: ${proxy}`;
            section.querySelector(`input[name="stgiDedup"][value="${dedupGranularity === 'name+version' ? 'name+version' : 'name'}"]`).checked = true;
            q('autoDedup').checked = autoDedup === true;
            q('dedupCurrent').textContent = `当前生效: ${dedupGranularity === 'name+version' ? '仓库名+版本号' : '仓库名'}；自动清理: ${autoDedup ? '开' : '关'}`;
        } catch (error) {
            q('current').textContent = `读取失败: ${error.message || error}`;
        }
    })();

    q('save').addEventListener('click', async () => {
        const mode = currentRadio();
        const body = { proxy: mode === 'url' ? q('proxyUrl').value.trim() : mode };
        try {
            const result = await api('/settings', { body });
            toast(`已保存，当前生效: ${result.proxy}`, 'success');
            q('current').textContent = `当前生效: ${result.proxy}`;
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('saveDedup').addEventListener('click', async () => {
        let value = 'name';
        for (const radio of dedupRadios) {
            if (radio.checked) value = radio.value;
        }
        try {
            const result = await api('/settings', {
                body: { dedupGranularity: value, autoDedup: q('autoDedup').checked },
            });
            toast(`去重设置已保存: ${result.dedupGranularity === 'name+version' ? '仓库名+版本号' : '仓库名'}，自动清理${result.autoDedup ? '开' : '关'}`, 'success');
            q('dedupCurrent').textContent = `当前生效: ${result.dedupGranularity === 'name+version' ? '仓库名+版本号' : '仓库名'}；自动清理: ${result.autoDedup ? '开' : '关'}`;
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });
    return section;
}

// ---------------------------------------------------------------- dialog

function openDialog(title, section) {
    const overlay = el(`<div class="stgi-overlay"><div class="stgi-dialog">
        <div class="stgi-row" style="justify-content:space-between">
            <h3 style="margin:0">${esc(title)}</h3>
            <button class="stgi-btn" data-role="close">✕</button>
        </div>
        <div data-role="body"></div>
    </div></div>`);
    overlay.querySelector('[data-role="body"]').append(section);
    overlay.querySelector('[data-role="close"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            overlay.remove();
        }
    });
    document.body.append(overlay);
    return overlay;
}

function openMain() {
    const root = el('<div></div>');
    const tabs = [
        ['站点凭据', () => tabSites(root)],
        ['私有安装', () => tabInstall(root)],
        ['诊断与修复', () => tabDiagnose(root)],
        ['设置', () => tabSettings(root)],
    ];
    const bar = el('<div class="stgi-tabs"></div>');
    const body = el('<div></div>');
    root.append(bar, body);

    function show(index) {
        bar.querySelectorAll('.stgi-tab').forEach((tab, i) => tab.classList.toggle('active', i === index));
        body.innerHTML = '<div class="stgi-note">加载中…</div>';
        tabs[index][1]().then(section => {
            body.innerHTML = '';
            body.append(section);
        });
    }
    tabs.forEach(([label], index) => {
        const tab = el(`<div class="stgi-tab">${label}</div>`);
        tab.addEventListener('click', () => show(index));
        bar.append(tab);
    });
    show(0);
    openDialog('Git 源管理（补充面板）', root);
}

// ---------------------------------------------------------------- entry

export function initExtension() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) {
        console.warn('[st-git-improve] #extensionsMenu not found; panel entry unavailable');
        return;
    }
    const item = el(`<div class="list-group-item flex-container flexAlignCenter stgi-menu-item" id="st-git-improve-menu" title="私有源登录安装 / 依赖修复 / 冲突恢复（补充面板）">
        <i class="fa-solid fa-code-branch"></i>
        <span>Git 源管理</span>
    </div>`);
    item.addEventListener('click', openMain);
    menu.append(item);
    console.log('[st-git-improve] panel registered');
}

// ST evaluates extension modules after DOM ready.
try {
    initExtension();
} catch (error) {
    console.error('[st-git-improve] init failed:', error);
}
