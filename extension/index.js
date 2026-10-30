// ST Git Improve — supplementary front-end panel.
// Adds a "Git 源管理" entry to the Extensions menu. Does not modify any
// native extension-management behavior.
//
// 运行模式（L0-11 适配器 + 特性检测 + 静默降级）：
//   - 服务端插件在位（/health 探测成功）→ 插件通道：完整语义（备份/去重/依赖修复）
//   - 纯前端（插件不在位）→ 浏览器内克隆（isomorphic-git）+ 宿主原生安装通道；
//     账号凭据保存在浏览器侧（宿主设置 / localStorage），逐个登录、可多个。

// 模块缓存破坏：宿主以 HTTP 缓存扩展模块文件，更新扩展后旧模块可能继续生效。
// 所有跨模块 import 带上版本参数，发版时与 manifest.json 的 version 同步修改。
const V = '0.8.4';

const backendMod = await import(`./src/core/backend.js?v=${V}`);
const detectMode = backendMod.detectMode;
const compareVersions = backendMod.compareVersions;
const pluginApi = backendMod.pluginApi;
const hostDiscover = backendMod.hostDiscover;
const hostSettingsGet = backendMod.hostSettingsGet;
const hostToggleExtensionDisabled = backendMod.hostToggleExtensionDisabled;
const hostMoveExtension = backendMod.hostMoveExtension;
const { getSharedStore } = await import(`./src/core/accounts.js?v=${V}`);
const { SITE_TYPES, siteKeyOf } = await import(`./src/core/sites.js?v=${V}`);
const { pureInstall, buildZipBytes } = await import(`./src/core/installflow.js?v=${V}`);
const { channelHint, classifyUrl } = await import(`./src/core/giturl.js?v=${V}`);

function toast(msg, kind = 'info') {
    const toastr = window.toastr;
    if (toastr) {
        toastr[kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'](msg, 'Git 源管理');
    } else {
        console.log(`[st-git-improve] ${kind}: ${msg}`);
    }
}

async function api(path, options = {}) {
    return pluginApi(path, options);
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 面板运行时上下文：模式 + 账号库（openMain 里初始化）。 */
const RT = {
    mode: 'pure',
    store: null,
    systemGit: null,
};

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

/** 操作日志逐行着色（ok=绿 / err=红 / 默认普通）。 */
function appendLogLine(log, line, kind = 'plain') {
    const row = el(`<div class="stgi-log-line${kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : ''}"></div>`);
    row.textContent = String(line ?? '');
    log.append(row);
    log.scrollTop = log.scrollHeight;
}

/** 面板版本是否落后于当前面板（插件内置副本回退风险）。 */
function panelVersionLag() {
    const bundled = RT.panelVersions?.bundled || '';
    return Boolean(bundled && V && compareVersions(bundled, V) < 0);
}

/** 构建「运行环境」卡（服务端 / 纯前端两态共用；kv 行由调用方填充）。 */
function buildEnvCard() {
    const card = el(`<div class="stgi-section" data-role="envCard">
        <div class="stgi-note"><b>运行环境</b> <span class="stgi-note" data-role="envStamp"></span></div>
        <div class="stgi-kv" data-role="envRows"></div>
        <div class="stgi-row"><button class="stgi-btn" data-role="envRefresh">刷新环境</button></div>
    </div>`);
    return card;
}

/** 往环境卡里填一行 kv。kind: good/bad/warn 控制值着色。 */
function addEnvRow(card, key, value, kind = '') {
    const rows = card.querySelector('[data-role="envRows"]');
    const row = el(`<div class="stgi-kv-row"><span class="stgi-kv-k"></span><span class="stgi-kv-v${kind ? ` ${kind}` : ''}"></span></div>`);
    row.querySelector('.stgi-kv-k').textContent = key;
    row.querySelector('.stgi-kv-v').textContent = String(value ?? '');
    rows.append(row);
}

// ---------------------------------------------------------------- tabs

/** 账号管理：逐个登录、多账号、默认账号、验证、导出/导入、（服务端模式）推送。 */
function tabAccounts(root) {
    const section = el(`
        <div>
            <div class="stgi-note">为需要登录的 git 站点保存账号——<b>逐个添加</b>，每个站点可存多个账号，☆ 切换该站点默认账号。凭据只保存在浏览器侧（宿主设置/localStorage），不会写进任何仓库地址。</div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <select data-role="type" style="flex:0 0 200px">
                        ${SITE_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
                    </select>
                    <input data-role="baseUrl" placeholder="站点地址，如 https://git.example.com" style="display:none" />
                    <input data-role="username" placeholder="用户名（可选）" />
                </div>
                <div class="stgi-row">
                    <input data-role="token" placeholder="访问令牌 (PAT)" type="password" />
                    <input data-role="note" placeholder="备注（可选，如 主号/小号）" style="flex:0 1 140px" />
                </div>
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="makeDefault" checked /> 设为该站点默认账号</label>
                    <button class="stgi-btn primary" data-role="add" style="margin-left:auto">添加账号</button>
                </div>
                <details>
                    <summary class="stgi-note" style="cursor:pointer">其他登录方式</summary>
                    <div class="stgi-row" style="margin-top:6px">
                        <input data-role="userinfoUrl" placeholder="粘贴 https://user:token@host/... 形式的地址，自动提取" />
                        <button class="stgi-btn" data-role="saveUserinfo">提取保存</button>
                    </div>
                </details>
            </div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="export">导出账号</button>
                <input type="file" data-role="importFile" accept="application/json" style="display:none" />
                <button class="stgi-btn" data-role="import">导入账号</button>
                ${RT.mode === 'server' ? '<span class="stgi-note">「推送服务端」把账号同步给服务端插件（其克隆/治理用它认证）</span>' : ''}
            </div>
            <table class="stgi-table"><thead>
                <tr><th>账号</th><th>站点</th><th>方式</th><th>状态</th><th>默认</th><th>操作</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    const typeSelect = q('type');

    function refreshBaseVisibility() {
        const type = SITE_TYPES.find(t => t.id === typeSelect.value);
        q('baseUrl').style.display = type?.needsBase ? '' : 'none';
        if (type && !type.needsBase) q('baseUrl').value = '';
    }
    typeSelect.addEventListener('change', refreshBaseVisibility);
    refreshBaseVisibility();

    function statusBadge(account) {
        if (!account.lastCheckedAt) return '<span class="stgi-badge warn">未验证</span>';
        return account.lastCheckOk
            ? `<span class="stgi-badge good">已验证${account.lastLogin ? ` (${esc(account.lastLogin)})` : ''}</span>`
            : '<span class="stgi-badge bad">验证失败</span>';
    }

    async function reload() {
        const snapshot = RT.store.snapshot();
        const rows = q('rows');
        rows.innerHTML = '';
        if (snapshot.accounts.length === 0) {
            rows.innerHTML = '<tr><td colspan="6">还没有账号 —— 在上方添加第一个</td></tr>';
            return;
        }
            for (const account of snapshot.accounts) {
                const siteKey = siteKeyOf(account.type, account.baseUrl);
                const isDefault = snapshot.defaults[siteKey] === account.id;
                const siteLabel = `${account.type}${SITE_TYPES.find(t => t.id === account.type)?.needsBase ? ` · ${account.baseUrl}` : ''}`;
                const checkedNote = account.lastCheckedAt
                    ? new Date(account.lastCheckedAt * 1000).toLocaleString('zh-CN', { hour12: false })
                    : '';
                const row = el(`<tr>
                <td>${esc(account.note || account.username || '(匿名)')}<div class="stgi-note">${esc(account.username || '')}${checkedNote ? ` · 验证于 ${esc(checkedNote)}` : ''}</div></td>
                <td>${esc(siteLabel)}</td>
                <td>${esc(account.method || 'pat')}</td>
                <td>${statusBadge(account)}</td>
                <td>${isDefault ? '<span class="stgi-badge good">★</span>' : '<button class="stgi-btn" data-act="setDefault" title="设为该站点默认">☆</button>'}</td>
                <td>
                    <button class="stgi-btn" data-act="test">测试</button>
                    ${RT.mode === 'server' ? '<button class="stgi-btn" data-act="push">推送服务端</button>' : ''}
                    <button class="stgi-btn" data-act="del">删除</button>
                </td>
            </tr>`);
            row.querySelector('[data-act="setDefault"]')?.addEventListener('click', async () => {
                try {
                    await RT.store.setDefault(siteKey, account.id);
                    reload();
                } catch (error) {
                    toast(String(error.message || error), 'error');
                }
            });
            row.querySelector('[data-act="test"]').addEventListener('click', async () => {
                toast('验证中…');
                try {
                    const result = await RT.store.testAccount(account.id);
                    if (result.ok) toast(`有效（${result.login || 'ok'}）`, 'success');
                    else if (result.blockedByBrowser) toast('浏览器直连被拦截（CORS），凭据已保存未验证', 'error');
                    else toast(`无效（HTTP ${result.status}）`, 'error');
                    reload();
                } catch (error) {
                    if (error?.blockedByBrowser) {
                        toast('浏览器直连被拦截（CORS 或网络），凭据已保存；实际以 git 操作结果为准', 'error');
                        reload();
                    } else {
                        toast(String(error.message || error), 'error');
                    }
                }
            });
            row.querySelector('[data-act="push"]')?.addEventListener('click', async () => {
                try {
                    await api('/sites', {
                        body: {
                            type: account.type,
                            baseUrl: account.baseUrl,
                            username: account.username,
                            method: 'pat',
                            token: account.token,
                        },
                    });
                    toast('已推送到服务端', 'success');
                } catch (error) {
                    toast(String(error.message || error), 'error');
                }
            });
            row.querySelector('[data-act="del"]').addEventListener('click', async () => {
                try {
                    await RT.store.removeAccount(account.id);
                    toast('已删除', 'success');
                    reload();
                } catch (error) {
                    toast(String(error.message || error), 'error');
                }
            });
            rows.append(row);
        }
    }

    q('add').addEventListener('click', async () => {
        try {
            const { account } = await RT.store.addAccount({
                type: typeSelect.value,
                baseUrl: q('baseUrl').value.trim() || undefined,
                username: q('username').value.trim(),
                token: q('token').value.trim(),
                note: q('note').value.trim(),
                makeDefault: q('makeDefault').checked,
            });
            q('token').value = '';
            q('username').value = '';
            q('note').value = '';
            toast('账号已保存', 'success');
            reload();
            // 保存后立即后台验证一次
            try {
                const result = await RT.store.testAccount(account.id);
                if (result.ok) toast(`验证通过（${result.login || 'ok'}）`, 'success');
                else toast(`已保存但验证未通过（HTTP ${result.status}）——可重试「测试」`, 'error');
                reload();
            } catch (error) {
                if (error?.blockedByBrowser) {
                    toast('浏览器直连被拦截（CORS），凭据已保存；实际以 git 操作结果为准', 'error');
                    reload();
                } else {
                    toast(`验证失败: ${error.message || error}`, 'error');
                }
            }
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('saveUserinfo').addEventListener('click', async () => {
        try {
            await RT.store.addFromUserinfoUrl(q('userinfoUrl').value.trim());
            q('userinfoUrl').value = '';
            toast('已提取并保存', 'success');
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(RT.store.snapshot(), null, 2)], { type: 'application/json' });
        const link = el(`<a href="${URL.createObjectURL(blob)}" download="st-git-improve-accounts.json">导出</a>`);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });

    q('import').addEventListener('click', () => q('importFile').click());
    q('importFile').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const imported = JSON.parse(await file.text());
            if (!Array.isArray(imported.accounts)) throw new Error('文件里没有 accounts 数组');
            if (!window.confirm(`导入 ${imported.accounts.length} 个账号？（覆盖当前账号库）`)) return;
            for (const account of imported.accounts) {
                await RT.store.addAccount({
                    type: account.type,
                    baseUrl: account.baseUrl,
                    username: account.username,
                    token: account.token,
                    note: account.note,
                    method: account.method || 'pat',
                    replaceExisting: true,
                    makeDefault: false,
                });
            }
            // 恢复默认账号映射
            for (const [siteKey, id] of Object.entries(imported.defaults || {})) {
                const account = RT.store.snapshot().accounts.find(a => a.id === id);
                if (account) await RT.store.setDefault(siteKey, id).catch(() => { });
            }
            toast('导入完成', 'success');
            reload();
        } catch (error) {
            toast(`导入失败: ${error.message || error}`, 'error');
        }
    });

    reload();
    return section;
}

async function tabInstall(root) {
    const pure = RT.mode !== 'server';
    const section = el(`
        <div>
            <div class="stgi-note">${pure
            ? '纯前端模式：浏览器内克隆（支持私有仓库，凭据来自「账号」页），再交给宿主原生安装通道。'
            : '安装私有/任意 git 仓库：http(s)（站点凭据自动认证）或 SSH/file 地址（git@host:path、ssh://、file://，走系统 git 与你自己的 ssh-agent）。前端扩展装到当前用户，服务端插件装到 plugins/。'}</div>
            <div class="stgi-note" data-role="channelHint" style="display:none"></div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <input data-role="url" placeholder="仓库地址 https://..." style="flex:3 1 260px" />
                    <input data-role="branch" placeholder="分支（可选）" style="flex:0 1 120px" />
                    <select data-role="target" style="flex:0 0 150px">
                        <option value="extension">用户扩展</option>
                        <option value="global">全局扩展</option>
                        ${pure ? '' : '<option value="plugin">服务端插件</option>'}
                    </select>
                </div>
                ${pure ? `
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="replace" /> 目录已存在时删除旧版重装（更新语义；扩展目录内的本地改动不会被备份）</label>
                </div>` : `
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="replace" /> 目录已存在时替换重装</label>
                </div>
                <details>
                    <summary class="stgi-note" style="cursor:pointer">高级选项</summary>
                    <div class="stgi-row">
                        <label><input type="checkbox" data-role="force" /> 强制本地安装（覆盖重复检测；全局已有同名/同版本扩展时仍要装本地副本）</label>
                    </div>
                </details>`}
                <div class="stgi-row">
                    <button class="stgi-btn primary" data-role="go">安装</button>
                </div>
                <div class="stgi-log" data-role="log" style="display:none"></div>
            </div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);

    // 通道可视化：输入地址即时显示将走的克隆通道（含不可用预警）
    const hint = q('channelHint');
    function updateChannelHint() {
        const result = channelHint(q('url').value, {
            mode: RT.mode,
            systemGitAvailable: RT.systemGit ? RT.systemGit.available : undefined,
        });
        hint.textContent = result.text;
        hint.style.display = result.text ? '' : 'none';
        hint.classList.remove('stgi-hint-ok', 'stgi-hint-err', 'stgi-hint-warn');
        if (result.level === 'ok') hint.classList.add('stgi-hint-ok');
        else if (result.level === 'error') hint.classList.add('stgi-hint-err');
        else if (result.level === 'warn') hint.classList.add('stgi-hint-warn');
    }
    q('url').addEventListener('input', updateChannelHint);

    q('go').addEventListener('click', async () => {
        const button = q('go');
        button.disabled = true;
        const log = q('log');
        log.style.display = '';
        const append = (line, kind = 'plain') => appendLogLine(log, line, kind);
        log.innerHTML = '';
        const url = q('url').value.trim();
        try {
            if (url) {
                const cls = classifyUrl(url);
                if (cls.channel === 'system' && RT.mode !== 'server') {
                    append(`此地址（${cls.label}）需要系统 git 通道，纯前端模式不支持。请改用 http(s) 地址或安装服务端插件。`, 'err');
                    toast('纯前端模式不支持 SSH/file 地址', 'error');
                    return;
                }
                await RT.store.credentialsFor(url); // 预解析站点（错误提前暴露）
            }
            if (RT.mode === 'server') {
                append('服务端插件通道…');
                const result = await api('/install', {
                    body: {
                        url,
                        branch: q('branch').value.trim() || undefined,
                        target: q('target').value,
                        replace: q('replace')?.checked,
                        force: q('force')?.checked,
                    },
                });
                append(`安装完成: ${result.name}`, 'ok');
                append(`提交: ${(result.oid || '').slice(0, 7)}`);
                toast('安装完成，刷新页面后生效', 'success');
            } else {
                const result = await pureInstall({
                    url,
                    branch: q('branch').value.trim() || undefined,
                    target: q('target').value,
                    replace: q('replace')?.checked === true,
                    accounts: RT.store,
                    onLog: line => append(line),
                });
                append(`完成: ${result.name}（宿主原生通道）`, 'ok');
                // 附加能力：克隆成功时把结果导出为本地 zip（数据备份/手动上传双保险）
                if (result.cloned) {
                    try {
                        const bytes = buildZipBytes(result.cloned);
                        const href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
                        const link = el(`<a class="stgi-btn" href="${href}" download="${esc(result.name || 'repository')}.zip">保存 zip 副本</a>`);
                        log.append(el('<div></div>'), link);
                        setTimeout(() => URL.revokeObjectURL(href), 60000);
                    } catch { /* 导出失败不影响安装结果 */ }
                }
                toast('安装完成，刷新页面后生效', 'success');
            }
        } catch (error) {
            append(`失败: ${error.message || error}`, 'err');
            toast(String(error.message || error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    if (RT.mode === 'server') {
        const whoami = await getWhoami();
        if (whoami.canForce === false) {
            q('force').closest('.stgi-row').style.display = 'none';
            q('force').closest('details').insertAdjacentHTML('beforeend',
                '<div class="stgi-note">当前登录用户非管理员：重复检测始终生效，强制覆盖不可用。</div>');
        }
    }
    return section;
}

async function tabDiagnose(root) {
    if (RT.mode !== 'server') {
        return tabDiagnosePure(root);
    }
    const section = el(`
        <div>
            <div class="stgi-note">扫描已装扩展与服务端插件。更新时本地改动会自动备份；依赖修复可对插件目录或酒馆本体重跑 npm install。</div>
            <div class="stgi-section" data-role="envSection"></div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="reload">扫描（含远端检查）</button>
                <button class="stgi-btn" data-role="updateAll">全部更新</button>
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

    // 运行环境卡：面板版本对 + 系统 git 桥 + 代理模式
    const envCard = buildEnvCard();
    section.querySelector('[data-role="envSection"]').append(envCard);
    async function fillEnv() {
        envCard.querySelector('[data-role="envRows"]').innerHTML = '';
        envCard.querySelector('[data-role="envStamp"]').textContent = `（${RT.mode === 'server' ? '服务端增强' : '纯前端'} · ${new Date().toLocaleTimeString()}）`;
        addEnvRow(envCard, '面板版本', `v${V}`, 'good');
        try {
            const health = await api('/health');
            const pv = health.panelVersions || {};
            const bundled = pv.bundled ? `v${pv.bundled}` : '未知';
            addEnvRow(envCard, '插件内置面板', bundled, panelVersionLag() ? 'bad' : 'good');
            if (panelVersionLag()) {
                addEnvRow(envCard, '⚠ 回退风险', '宿主重启会把面板覆盖回退到内置旧版——请同步 plugins/st-git-improve/extension/', 'warn');
            }
            addEnvRow(envCard, '数据目录面板', pv.installed ? `v${pv.installed}` : '未知');
            const sg = health.systemGit || {};
            addEnvRow(envCard, '系统 git 桥', sg.available ? (sg.version || '可用') : '不可用（SSH/file 地址将失败）', sg.available ? 'good' : 'bad');
            try {
                const { proxy } = await api('/settings');
                addEnvRow(envCard, 'git 代理', proxy || 'direct');
            } catch { /* 设置读取失败不阻塞环境卡 */ }
        } catch (error) {
            addEnvRow(envCard, '服务端读取失败', String(error.message || error), 'bad');
        }
    }
    envCard.querySelector('[data-role="envRefresh"]').addEventListener('click', () => fillEnv());
    fillEnv();

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

    q('updateAll').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        toast('批量更新中，请稍候…');
        try {
            const { updated, upToDate, failed } = await api('/update-all', { body: {} });
            const parts = [];
            if (updated.length > 0) parts.push(`更新 ${updated.length} 个`);
            if (upToDate.length > 0) parts.push(`${upToDate.length} 个已是最新`);
            if (failed.length > 0) parts.push(`失败 ${failed.length} 个（${failed.map(item => `${item.name}: ${item.error}`).join('；').slice(0, 300)}）`);
            toast(parts.join('，') || '没有可更新的 git 扩展/插件', failed.length > 0 ? 'error' : 'success');
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            button.disabled = false;
        }
    });

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

/** 纯前端诊断：宿主原生扩展发现 + 本面板登记来源的「更新」。 */
async function tabDiagnosePure(root) {
    const section = el(`
        <div>
            <div class="stgi-note">纯前端模式：列出宿主已装第三方扩展。本面板安装的扩展登记了来源，可直接「更新」（重跑安装流程取最新版）；依赖修复 / 备份恢复 / 去重需要服务端插件（可选增强）。</div>
            <div class="stgi-section" data-role="envSection"></div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="reload">扫描已装扩展</button>
                <button class="stgi-btn" data-role="updateAll">全部更新（已登记来源的）</button>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>名称</th><th>显示名</th><th>版本</th><th>操作</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
        </div>`);
    const q = role => section.querySelector(`[data-role="${role}"]`);

    // 运行环境卡（纯前端）：浏览器克隆能力 + 宿主原生通道 + 凭据存储
    const envCard = buildEnvCard();
    section.querySelector('[data-role="envSection"]').append(envCard);
    async function fillEnv() {
        envCard.querySelector('[data-role="envRows"]').innerHTML = '';
        envCard.querySelector('[data-role="envStamp"]').textContent = `（纯前端 · ${new Date().toLocaleTimeString()}）`;
        addEnvRow(envCard, '面板版本', `v${V}`, 'good');
        addEnvRow(envCard, '浏览器克隆', 'isomorphic-git 已载入（http(s) 地址可用）', 'good');
        addEnvRow(envCard, 'SSH/file 桥', '纯前端不可用（需服务端插件 + 系统 git）', 'warn');
        addEnvRow(envCard, '凭据存储', RT.store.storage?.name || '浏览器');
        try {
            const { status, ok } = await hostDiscover();
            addEnvRow(envCard, '宿主扩展通道', ok ? `可达（discover HTTP ${status}）` : `异常（HTTP ${status}）`, ok ? 'good' : 'bad');
        } catch (error) {
            addEnvRow(envCard, '宿主扩展通道', `不可达：${error.message || error}`, 'bad');
        }
    }
    envCard.querySelector('[data-role="envRefresh"]').addEventListener('click', () => fillEnv());
    fillEnv();

    q('updateAll').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        const installs = Object.entries(RT.store.getInstalls());
        if (installs.length === 0) {
            toast('没有登记过来源的扩展（用「私有安装」装过才有）', 'error');
            button.disabled = false;
            return;
        }
        const logBox = el('<div class="stgi-log" style="display:block"></div>');
        openDialog('全部更新（纯前端 · 顺序执行）', logBox);
        const append = line => { logBox.textContent += `${line}\n`; logBox.scrollTop = logBox.scrollHeight; };
        append(`共 ${installs.length} 个待更新扩展`);
        let okCount = 0;
        const failed = [];
        for (const [name, origin] of installs) {
            append(`—— ${name} ——`);
            try {
                await pureInstall({
                    url: origin.url,
                    branch: origin.branch || undefined,
                    target: origin.target || 'extension',
                    replace: true,
                    accounts: RT.store,
                    onLog: append,
                });
                okCount += 1;
            } catch (error) {
                failed.push(name);
                append(`失败: ${error.message || error}`);
            }
        }
        append(`完成：成功 ${okCount}，失败 ${failed.length}${failed.length ? `（${failed.join('、')}）` : ''}。刷新页面后生效。`);
        toast(`全部更新完成：成功 ${okCount}，失败 ${failed.length}`, failed.length > 0 ? 'error' : 'success');
        reload();
        button.disabled = false;
    });

    async function runUpdate(origin, displayName, { confirmFirst = false } = {}) {
        if (confirmFirst && !window.confirm(
            `更新 ${displayName || origin.url}：将删除本地旧版目录后重装最新版。\n注意：扩展目录内的本地改动不会被备份（服务端插件的 git 备份更新更安全）。继续？`)) {
            return null;
        }
        const logBox = el('<div class="stgi-log" style="display:block"></div>');
        const overlay = openDialog(`更新 — ${esc(displayName || origin.url)}`, logBox);
        const append = line => { logBox.textContent += `${line}\n`; logBox.scrollTop = logBox.scrollHeight; };
        try {
            await pureInstall({
                url: origin.url,
                branch: origin.branch || undefined,
                target: origin.target || 'extension',
                replace: true,
                accounts: RT.store,
                onLog: append,
            });
            append('完成。刷新页面后生效。');
            toast(`已更新 ${displayName || origin.url}`, 'success');
        } catch (error) {
            append(`失败: ${error.message || error}`);
            toast(String(error.message || error), 'error');
        }
        return overlay;
    }

    async function reload() {
        const rows = q('rows');
        rows.innerHTML = '<tr><td colspan="4">扫描中…</td></tr>';
        try {
            const [{ status, ok, entries }, installs] = await Promise.all([hostDiscover(), Promise.resolve(RT.store.getInstalls())]);
            if (!ok) throw new Error(`宿主 discover 失败（HTTP ${status}）`);
            rows.innerHTML = '';
            if (entries.length === 0) {
                rows.innerHTML = '<tr><td colspan="4">未发现任何第三方扩展</td></tr>';
                return;
            }
            for (const entry of entries) {
                const origin = installs[entry.name];
                const originNote = origin ? `<div class="stgi-note">来源: ${esc(origin.url)}${origin.branch ? ` @${esc(origin.branch)}` : ''}</div>` : '';
                const row = el(`<tr>
                    <td>${esc(entry.name || '')}${originNote}</td>
                    <td>${esc(entry.displayName || '')}</td>
                    <td>${esc(entry.version || '')}</td>
                    <td>${origin ? '<button class="stgi-btn" data-act="update">更新</button>' : '—'}</td>
                </tr>`);
                row.querySelector('[data-act="update"]')?.addEventListener('click', event => {
                    event.target.disabled = true;
                    runUpdate(origin, entry.name).finally(() => { reload(); });
                });
                rows.append(row);
            }
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="4">扫描失败: ${esc(String(error.message || error))}</td></tr>`;
        }
    }
    q('reload').addEventListener('click', reload);
    reload();
    return section;
}

function tabGovernance(root) {
    if (RT.mode !== 'server') {
        return tabGovernancePure(root);
    }
    const section = el(`
        <div>
            <div class="stgi-note">扩展治理：停用用户自行安装的扩展（宿主不再加载）。停用=整目录搬入停用区，扩展数据随目录各自保存、不丢失；启用原样搬回。彻底清理会删除停用副本释放磁盘空间，不可恢复。</div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="reload">刷新</button>
                <button class="stgi-btn" data-role="disableAll">一键停用全部自装扩展</button>
                <button class="stgi-btn" data-role="enableAll">全部启用</button>
                <span class="stgi-note" data-role="totals"></span>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>名称</th><th>范围</th><th>版本</th><th>占用</th><th>状态</th><th>操作</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
            <div class="stgi-note" data-role="parkedNote"></div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    const SCOPE_LABEL = { local: '用户扩展', global: '全局扩展', parked: '已停用', plugin: '服务端插件' };

    async function reload() {
        const rows = q('rows');
        rows.innerHTML = '<tr><td colspan="6">扫描中…</td></tr>';
        try {
            const { entries, totals, parkedDir } = await api('/governance');
            q('totals').textContent =
                `本地扩展共 ${humanBytes(totals.localBytes)}；停用区共 ${humanBytes(totals.parkedBytes)}` +
                (totals.parkedBytes > 0 ? `（彻底清理停用副本可释放 ${humanBytes(totals.parkedBytes)}）` : '');
            q('parkedNote').textContent = parkedDir ? `停用区位置: ${parkedDir}` : '';
            rows.innerHTML = '';
            if (entries.length === 0) {
                rows.innerHTML = '<tr><td colspan="6">未发现任何扩展/插件</td></tr>';
                return;
            }
            for (const entry of entries) {
                const badges = [];
                if (entry.scope === 'parked') {
                    badges.push('<span class="stgi-badge warn">已停用</span>');
                    if (entry.parkedAt) badges.push(`<span class="stgi-note">${esc(entry.parkedAt.slice(0, 19).replace('T', ' '))}</span>`);
                } else if (entry.scope === 'local') {
                    if (entry.settingsDisabled) {
                        badges.push('<span class="stgi-badge warn">宿主设置停用</span>');
                    } else {
                        badges.push('<span class="stgi-badge good">启用中</span>');
                    }
                }
                if (entry.isRepo === false) badges.push('<span class="stgi-badge warn">非git</span>');
                else if (entry.dirtyCount > 0) badges.push(`<span class="stgi-badge warn">本地改动×${entry.dirtyCount}</span>`);

                const actions = [];
                if (entry.scope === 'local' && entry.name !== 'st-git-improve') {
                    actions.push('<button class="stgi-btn" data-act="disable">停用</button>');
                }
                if (entry.scope === 'parked') {
                    actions.push('<button class="stgi-btn" data-act="enable">启用</button>');
                    actions.push('<label><input type="checkbox" data-role="confirmDel" /> 确认删除</label>');
                    actions.push('<button class="stgi-btn" data-act="purge">彻底清理</button>');
                }
                const row = el(`<tr>
                    <td>${esc(entry.name)}</td>
                    <td>${SCOPE_LABEL[entry.scope] || esc(entry.scope)}</td>
                    <td>${esc(entry.version || '?')}</td>
                    <td>${humanBytes(entry.bytes)}</td>
                    <td>${badges.join(' ') || '—'}</td>
                    <td>${actions.join(' ') || '—'}</td>
                </tr>`);
                row.querySelector('[data-act="disable"]')?.addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        const result = await api('/governance/disable', { body: { name: entry.name } });
                        toast(`已停用 ${result.name}，刷新页面后生效（数据完整保存在停用区）`, 'success');
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                        event.target.disabled = false;
                    }
                });
                row.querySelector('[data-act="enable"]')?.addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        await api('/governance/enable', { body: { name: entry.name } });
                        toast(`已启用 ${entry.name}，刷新页面后生效`, 'success');
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                        event.target.disabled = false;
                    }
                });
                row.querySelector('[data-act="purge"]')?.addEventListener('click', async event => {
                    if (row.querySelector('[data-role="confirmDel"]')?.checked !== true) {
                        toast('删除不可恢复：请先勾选该行的「确认删除」', 'error');
                        return;
                    }
                    event.target.disabled = true;
                    try {
                        const result = await api('/governance/parked', { method: 'DELETE', body: { name: entry.name, confirm: true } });
                        toast(`已彻底清理 ${result.name}，释放 ${humanBytes(result.freedBytes)}`, 'success');
                        reload();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                        event.target.disabled = false;
                    }
                });
                rows.append(row);
            }
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="6">加载失败: ${esc(String(error.message || error))}</td></tr>`;
        }
    }

    q('reload').addEventListener('click', reload);

    q('disableAll').addEventListener('click', async event => {
        event.target.disabled = true;
        try {
            const { disabled, skipped } = await api('/governance/disable-all', { body: {} });
            const parts = [`已停用 ${disabled.length} 个`];
            if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个（${skipped.map(item => `${item.name}: ${item.reason}`).join('；')}）`);
            toast(parts.join('，') || '没有可停用的自装扩展', 'success');
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            event.target.disabled = false;
        }
    });

    q('enableAll').addEventListener('click', async event => {
        event.target.disabled = true;
        try {
            const { enabled, skipped } = await api('/governance/enable-all', { body: {} });
            const parts = [`已启用 ${enabled.length} 个`];
            if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个（${skipped.map(item => `${item.name}: ${item.reason}`).join('；')}）`);
            toast(parts.join('，') || '停用区为空', 'success');
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            event.target.disabled = false;
        }
    });

    reload();
    return section;
}

/** 纯前端治理：宿主设置 disabledExtensions 开关（目录不动，宿主不加载）。 */
async function tabGovernancePure(root) {
    const section = el(`
        <div>
            <div class="stgi-note">纯前端治理：停用/启用走宿主设置（目录与数据完全不动，刷新后生效）；「迁全局/迁本地」走宿主迁移通道（目录真实搬移，全局对所有用户生效）。整目录停用区/彻底清理以释放磁盘需要服务端插件。</div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="reload">刷新</button>
                <span class="stgi-note" data-role="note"></span>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>名称</th><th>加载状态</th><th>加载开关</th><th>安装范围</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
        </div>`);
    const q = role => section.querySelector(`[data-role="${role}"]`);

    async function currentDisabledSet() {
        const settings = await hostSettingsGet();
        if (!settings.ok || !settings.data) {
            throw new Error(`宿主设置不可达（HTTP ${settings.status}）`);
        }
        // 实测键位：extension_settings.disabledExtensions（条目 'third-party/<name>'）；兼容旧根级形态。
        const data = settings.data;
        const container = data.extension_settings?.disabledExtensions ?? data.disabledExtensions;
        const names = new Set();
        const add = n => { if (typeof n === 'string') names.add(n.replace(/^third-party\//, '')); };
        if (Array.isArray(container)) {
            for (const n of container) add(n);
        } else if (container && typeof container === 'object') {
            for (const bucket of Object.values(container)) {
                if (Array.isArray(bucket)) for (const n of bucket) add(n);
            }
        }
        return names;
    }

    async function reload() {
        const rows = q('rows');
        rows.innerHTML = '<tr><td colspan="3">加载中…</td></tr>';
        try {
            const [disabled, discovered] = await Promise.all([currentDisabledSet(), hostDiscover()]);
            const scopeByName = new Map(discovered.ok ? discovered.entries.map(e => [e.name, e.scope]) : []);
            const names = discovered.ok && discovered.entries.length > 0
                ? discovered.entries.map(e => e.name)
                : [...disabled];
            rows.innerHTML = '';
            if (names.length === 0) {
                rows.innerHTML = '<tr><td colspan="4">未发现任何可治理的扩展</td></tr>';
                return;
            }
            for (const name of names) {
                const isDisabled = disabled.has(name);
                const scope = scopeByName.get(name) || 'local';
                const moveLabel = scope === 'global' ? '迁本地' : '迁全局';
                const row = el(`<tr>
                    <td>${esc(name)}<div class="stgi-note">${scope === 'global' ? '全局扩展（所有用户）' : '用户扩展'}</div></td>
                    <td>${isDisabled ? '<span class="stgi-badge warn">已停用</span>' : '<span class="stgi-badge good">加载中</span>'}</td>
                    <td><button class="stgi-btn" data-act="toggle">${isDisabled ? '启用' : '停用'}</button></td>
                    <td><button class="stgi-btn" data-act="move">${moveLabel}</button></td>
                </tr>`);
                row.querySelector('[data-act="toggle"]').addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        const result = await hostToggleExtensionDisabled(name, !isDisabled);
                        if (result.ok) {
                            toast(`${isDisabled ? '已启用' : '已停用'} ${name}，刷新页面后生效`, 'success');
                            reload();
                        } else {
                            toast(result.note || '操作失败', 'error');
                            event.target.disabled = false;
                        }
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                        event.target.disabled = false;
                    }
                });
                row.querySelector('[data-act="move"]').addEventListener('click', async event => {
                    const destination = scope === 'global' ? 'local' : 'global';
                    if (destination === 'global' &&
                        !window.confirm(`把 ${name} 迁移为全局扩展？全局扩展对实例上所有用户生效。`)) {
                        return;
                    }
                    event.target.disabled = true;
                    try {
                        const result = await hostMoveExtension(name, scope, destination);
                        if (result.ok) {
                            toast(`已迁移 ${name} → ${destination === 'global' ? '全局' : '本地'}，刷新页面后生效`, 'success');
                            reload();
                        } else {
                            toast(result.note || '迁移失败', 'error');
                            event.target.disabled = false;
                        }
                    } catch (error) {
                        toast(String(error.message || error), 'error');
                        event.target.disabled = false;
                    }
                });
                rows.append(row);
            }
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="4">加载失败: ${esc(String(error.message || error))}</td></tr>`;
        }
    }
    q('reload').addEventListener('click', reload);
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
                    <td>
                        <button class="stgi-btn" data-act="recover">恢复</button>
                        <button class="stgi-btn" data-act="delBackup">删除备份</button>
                    </td>
                </tr>`);
                row.querySelector('[data-act="recover"]').addEventListener('click', async event => {
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
                row.querySelector('[data-act="delBackup"]').addEventListener('click', async event => {
                    if (!window.confirm(`确定删除备份 ${backup.ref.replace('refs/git-improve/backup/', '')}？此操作不可恢复。`)) {
                        return;
                    }
                    event.target.disabled = true;
                    try {
                        await api('/backups', { method: 'DELETE', body: { target: entry.target, name: entry.name, backupRef: backup.ref } });
                        toast('备份已删除', 'success');
                        row.remove();
                    } catch (error) {
                        toast(String(error.message || error), 'error');
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

/** 面板回退守卫：服务端插件内置面板副本落后于当前面板时给出明确警告（第十二节隐患的 UI 化）。 */
function appendPanelVersionGuard(section) {
    try {
        if (!V) return;
        const bundled = RT.panelVersions?.bundled || '';
        const installed = RT.panelVersions?.installed || '';
        const box = el(`<div class="stgi-section">
            <div class="stgi-note"><b>面板版本</b>：当前 v${esc(V)}${bundled ? ` ｜ 插件内置 v${esc(bundled)}` : ''}${installed ? ` ｜ 数据目录 v${esc(installed)}` : ''}
              <button class="stgi-btn" data-role="pvCheck" style="margin-left:8px">重新检查</button></div>
            <div class="stgi-note" data-role="pvResult">${panelVersionLag()
                ? '⚠️ <b>面板回退风险</b>：插件内置面板副本落后于当前面板——宿主重启会把面板覆盖回退到旧版。请同步更新实例上的 <b>plugins/st-git-improve/extension/</b> 目录（与 data 内副本一致即可）。'
                : ''}</div>
        </div>`);
        box.querySelector('[data-role="pvCheck"]').addEventListener('click', async event => {
            event.target.disabled = true;
            try {
                const detection = await detectMode({ force: true });
                RT.mode = detection.mode;
                RT.panelVersions = detection.info?.panelVersions || null;
                RT.systemGit = detection.info?.systemGit || null;
                const result = box.querySelector('[data-role="pvResult"]');
                const b = RT.panelVersions?.bundled || '';
                result.textContent = panelVersionLag()
                    ? `内置 v${b} 落后于当前 v${V}——宿主重启会回退面板，请同步插件内置副本`
                    : (b ? `内置 v${b} 与当前 v${V} 一致，无回退风险` : '服务端插件不在位（纯前端模式），无内置副本');
                toast('面板版本检查完成', 'success');
            } catch (error) {
                toast(String(error.message || error), 'error');
            } finally {
                event.target.disabled = false;
            }
        });
        section.prepend(box);
    } catch { /* 守卫失败不影响设置页 */ }
}

async function tabSettings(root) {
    const pure = RT.mode !== 'server';
    const section = el(`
        <div>
            ${pure ? `
            <div class="stgi-section">
                <div class="stgi-note">纯前端模式：以下服务端设置（git 代理 / 安装去重颗粒度）仅在服务端插件在位时可用；账号管理见「账号」页的导出/导入。</div>
                <div class="stgi-row"><span class="stgi-note" data-role="feNote"></span></div>
            </div>` : `
            <div class="stgi-section">
                <div class="stgi-note">git 流量的代理开关。默认「直连」——完全不依赖环境；「跟随环境变量」读取 HTTP(S)_PROXY/NO_PROXY（回环地址始终豁免）；「自定义」对包括本机地址在内的所有 git 请求使用指定 http(s) 代理。</div>
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
            </div>`}
        </div>`);

    if (pure) {
        section.querySelector('[data-role="feNote"]').textContent =
            `凭据存储通道：${RT.store.storage?.name || '浏览器'}。`;
        const row = section.querySelector('[data-role="feNote"]').closest('.stgi-row');
        row.append(el('<button class="stgi-btn" data-role="redetect">重新探测运行模式</button>'));
        row.querySelector('[data-role="redetect"]').addEventListener('click', async event => {
            event.target.disabled = true;
            const before = RT.mode;
            const detection = await detectMode({ force: true });
            RT.mode = detection.mode;
            toast(`探测完成：${RT.mode === 'server' ? '服务端增强' : '纯前端'}${before !== RT.mode ? '（模式已变化，重新打开面板生效）' : ''}`, 'success');
            if (before !== RT.mode) {
                document.querySelector('.stgi-overlay')?.remove();
                openMain();
            } else {
                event.target.disabled = false;
            }
        });
        appendPanelVersionGuard(section);
        return section;
    }

    appendPanelVersionGuard(section);

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

async function openMain() {
    // 初始化运行时上下文：模式探测 + 账号库加载
    const detection = await detectMode();
    RT.mode = detection.mode;
    RT.panelVersions = detection.info?.panelVersions || null;
    RT.systemGit = detection.info?.systemGit || null;
    if (!RT.store) {
        RT.store = await getSharedStore();
    }

    const root = el('<div></div>');
    const tabs = [
        ['账号', () => tabAccounts(root)],
        ['私有安装', () => tabInstall(root)],
        ['诊断与修复', () => tabDiagnose(root)],
        ['扩展治理', () => tabGovernance(root)],
        [panelVersionLag() ? '设置 ⚠️' : '设置', () => tabSettings(root)],
    ];
    const bar = el('<div class="stgi-tabs"></div>');
    const body = el('<div></div>');
    root.append(bar, body);

    function show(index) {
        bar.querySelectorAll('.stgi-tab').forEach((tab, i) => tab.classList.toggle('active', i === index));
        body.innerHTML = '<div class="stgi-note">加载中…</div>';
        // Tab factories may return the section element synchronously or a
        // Promise — normalize so both work.
        Promise.resolve(tabs[index][1]()).then(section => {
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
    const modeBadge = RT.mode === 'server'
        ? { cls: 'good', label: '服务端增强' }
        : { cls: 'warn', label: '纯前端' };
    const overlay = openDialog('Git 源管理（补充面板）', root);
    // 徽标走 DOM 节点插入（openDialog 会对标题做 esc，不能内联 HTML）
    overlay.querySelector('h3').append(el(` <span class="stgi-badge ${modeBadge.cls}"></span>`));
    overlay.querySelector('h3 .stgi-badge').textContent = modeBadge.label;
    return overlay;
}

// ---------------------------------------------------------------- entry

const MENU_ITEM_ID = 'st-git-improve-menu';
/** A host extension may rebuild the extensions menu; give up re-adding after this many removals. */
const MAX_REATTACH = 3;

function buildMenuItem() {
    const item = el(`<div class="list-group-item flex-container flexAlignCenter stgi-menu-item" id="${MENU_ITEM_ID}" title="私有源登录安装 / 依赖修复 / 冲突恢复（补充面板）">
        <i class="fa-solid fa-code-branch"></i>
        <span>Git 源管理</span>
    </div>`);
    item.addEventListener('click', openMain);
    return item;
}

/** True when the item is present (or was just added). */
function ensureMenuItem() {
    if (document.getElementById(MENU_ITEM_ID)) {
        return true;
    }
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) {
        return false;
    }
    menu.append(buildMenuItem());
    return true;
}

/**
 * The host builds #extensionsMenu asynchronously and other extensions may
 * rebuild it later, so registration must not depend on execution order:
 * watch the DOM until the menu exists, then keep a bounded re-attach guard.
 */
export function initExtension() {
    if (!ensureMenuItem()) {
        const observer = new MutationObserver(() => {
            if (ensureMenuItem()) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const timer = setInterval(() => {
            if (ensureMenuItem()) {
                clearInterval(timer);
                observer.disconnect();
            }
        }, 500);
        setTimeout(() => {
            clearInterval(timer);
            observer.disconnect();
        }, 30000);
    }

    const menu = document.querySelector('#extensionsMenu');
    if (menu) {
        let reattachments = 0;
        new MutationObserver(() => {
            if (reattachments < MAX_REATTACH && !document.getElementById(MENU_ITEM_ID) &&
                document.querySelector('#extensionsMenu') === menu) {
                reattachments += 1;
                menu.append(buildMenuItem());
                console.warn('[st-git-improve] menu item was removed; re-attached ' +
                    `(${reattachments}/${MAX_REATTACH})`);
            }
        }).observe(menu, { childList: true });
    }

    console.log('[st-git-improve] panel registered');
}

// ST evaluates extension modules after DOM ready.
try {
    initExtension();
} catch (error) {
    console.error('[st-git-improve] init failed:', error);
}
