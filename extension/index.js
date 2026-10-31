// ST Git Improve — front-end panel（总览 + 三区新 IA，施工图见任务 design.md §2）。
// 唯一 UI 注入点 = 扩展设置抽屉（D6-5）；面板外零按钮、零注入（D6-6）。
// 能力态三维（宿主通道 × Authority × 管理员）驱动三态徽标与逐项灰化（D3-3/D3-4/D9-1）。
// 数据持久化铁律（C-2）：凭据/台账/来源登记的事实源 = 宿主 extension_settings；
// localStorage 仅作写失败兜底缓存，永不为事实源。

// 模块缓存破坏：宿主以 HTTP 缓存扩展模块文件，更新扩展后旧模块可能继续生效。
// 所有跨模块 import 带上版本参数，发版时与 manifest.json 的 version 同步修改。
const V = '0.9.2';

const backendMod = await import(`./src/core/backend.js?v=${V}`);
const { hostDiscover, hostSettingsGet, hostToggleExtensionDisabled, hostMoveExtension, hostDeleteExtension } = backendMod;
const { getSharedStore } = await import(`./src/core/accounts.js?v=${V}`);
const { SITE_TYPES, siteKeyOf } = await import(`./src/core/sites.js?v=${V}`);
const { pureInstall, buildZipBytes } = await import(`./src/core/installflow.js?v=${V}`);
const { channelHint, classifyUrl } = await import(`./src/core/giturl.js?v=${V}`);
const { originRepoFromHome, checkSelfUpdate } = await import(`./src/core/selfupdate.js?v=${V}`);
const { detectCapabilityState, can } = await import(`./src/core/capability.js?v=${V}`);
const { t } = await import(`./src/i18n/index.js?v=${V}`);
const { createGovernanceLog } = await import(`./src/core/governance-log.js?v=${V}`);
const { fetchBranches, checkRemoteUpdate } = await import(`./src/core/remote-status.js?v=${V}`);

function toast(msg, kind = 'info') {
    const toastr = window.toastr;
    if (toastr) {
        toastr[kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'](msg, t('panel.title'));
    } else {
        console.log(`[st-git-improve] ${kind}: ${msg}`);
    }
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    // 多根陷阱守卫（1.3 验收复盘）：本函数只取首个顶级元素，模板含多个兄弟根时
    // 其余元素会被静默丢弃——开发态立即告警，防「灰化按钮区从未进入 DOM」一类故障回归。
    if (template.content.children.length > 1) {
        console.warn(`[st-git-improve] el() template has ${template.content.children.length} root elements; `
            + 'only the first is returned — wrap the template in a container element');
    }
    return template.content.firstElementChild;
}

const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 面板运行时上下文：能力态 + 账号库 + 台账 + 分区摘要（buildPanel 里初始化）。 */
const RT = {
    store: null,      // AccountStore（凭据与来源登记，事实源在宿主设置，C-2）
    cap: null,        // 能力态（detectCapabilityState 结果）
    govLog: null,     // 治理台账（governance-log.js）
    discover: null,   // hostDiscover 结果短缓存 { at, result }
    summary: { installed: 0, updatable: 0, disabled: 0, duplicates: 0, accounts: 0, sites: 0, scannedAt: 0 },
};

/**
 * 能力态裁决落 DOM（D3-4 常显灰化 / D9-1 逐项灰化）：
 * 不可用 = 灰化(disabled) + title=t(reasonKey)。
 * @param {HTMLButtonElement} button
 * @param {{ allowed: boolean, reasonKey: string | null } | null} gate
 */
function applyGate(button, gate) {
    if (gate && gate.allowed) {
        button.disabled = false;
        button.title = '';
        return true;
    }
    button.disabled = true;
    button.title = t(gate?.reasonKey || 'cap.reason.unknownAction');
    return false;
}

/** 操作日志逐行着色（ok=绿 / err=红 / warn=黄 / 默认普通）。 */
function appendLogLine(log, line, kind = 'plain') {
    const cls = kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '';
    const row = el(`<div class="stgi-log-line${cls}"></div>`);
    row.textContent = String(line ?? '');
    log.append(row);
    log.scrollTop = log.scrollHeight;
}

/** 在日志区追加「刷新页面」按钮（安装/更新完成后面板文件已落盘，刷新即生效）。 */
function appendRefreshButton(log) {
    const button = el(`<button class="stgi-btn" title="${esc(t('panel.refreshPageTitle'))}">${esc(t('panel.refreshPage'))}</button>`);
    button.addEventListener('click', () => location.reload());
    log.append(el('<div></div>'), button);
}

/**
 * 面板自更新检查（D4-4 快捷动作之一；C-1 唯一触发点在总览快捷动作区）：
 * 读自身 manifest.homePage → origin 仓库最新 manifest 版本对比。
 * @param {HTMLElement} stateEl 结果内联展示位
 * @param {HTMLButtonElement} [button] 触发按钮（检查期间禁用）
 */
async function runSelfUpdateCheck(stateEl, button) {
    if (button) button.disabled = true;
    stateEl.classList.remove('stgi-hint-ok', 'stgi-hint-err', 'stgi-hint-warn');
    stateEl.textContent = t('self.checking');
    try {
        const manifest = await (await fetch(new URL('./manifest.json', import.meta.url).href)).json();
        const repo = originRepoFromHome(manifest?.homePage);
        const result = await checkSelfUpdate({ currentVersion: V, repo });
        if (!result.ok) {
            stateEl.textContent = t('self.checkFailed', { note: result.note || '' });
            stateEl.classList.add('stgi-hint-err');
        } else if (result.upToDate) {
            stateEl.textContent = t('self.upToDate', { latest: result.latest });
            stateEl.classList.add('stgi-hint-ok');
        } else {
            stateEl.textContent = t('self.newVersion', { latest: result.latest, current: V });
            stateEl.classList.add('stgi-hint-warn');
            const link = el(`<a class="stgi-btn" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">${esc(t('self.openRelease'))}</a>`);
            stateEl.parentElement.append(link);
        }
    } catch (error) {
        stateEl.textContent = t('self.checkFailed', { note: String(error?.message || error) });
        stateEl.classList.add('stgi-hint-err');
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------------------------------------------------------------- 总览首屏（D4-1 三件套）

/** 三态徽标（D3-3）：tier → 字典键 + 语义色 class。 */
const TIER_BADGE = {
    pure: { key: 'cap.tier.pure', cls: 'warn' },
    authority: { key: 'cap.tier.authority', cls: 'warn' },
    'authority-admin': { key: 'cap.tier.authorityAdmin', cls: 'good' },
};

/** 有界 JSON 请求（L1-MR-7：任何 await 必须能 settle；失败返回 null 不阻塞环境卡）。 */
async function fetchJsonBounded(url, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return await response.json().catch(() => null);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 构建「运行环境」卡（D4-1 首屏三件套之一；D3-3 三态徽标渲染在此）。 */
function buildEnvCard() {
    const card = el(`<div class="stgi-section stgi-env-card" data-role="envCard">
        <div class="stgi-row stgi-env-head">
            <b>${esc(t('env.title'))}</b>
            <span class="stgi-badge" data-role="tierBadge"></span>
        </div>
        <div class="stgi-kv" data-role="envRows"></div>
        <div class="stgi-row"><button class="stgi-btn" data-role="envRefresh">${esc(t('env.refresh'))}</button></div>
    </div>`);
    card.querySelector('[data-role="envRefresh"]').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        try {
            RT.cap = await detectCapabilityState({ force: true });
            await fillEnv(card);
        } catch (error) {
            console.error('[st-git-improve] env refresh failed:', error);
        } finally {
            button.disabled = false;
        }
    });
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

/** 填充环境卡：三态徽标 + 宿主版本 + 面板版本 + 克隆能力 + 凭据存储 + Authority 能力态 + 当前用户。 */
async function fillEnv(card) {
    const cap = RT.cap;
    const tier = TIER_BADGE[cap?.tier] || TIER_BADGE.pure;
    const badge = card.querySelector('[data-role="tierBadge"]');
    badge.className = `stgi-badge ${tier.cls}`;
    badge.textContent = t(tier.key);
    card.querySelector('[data-role="envRows"]').innerHTML = '';
    addEnvRow(card, t('env.panelVersion'), `v${V}`, 'good');
    const versionInfo = await fetchJsonBounded('/version');
    addEnvRow(card, t('env.hostVersion'), versionInfo?.version || t('env.hostVersionUnknown'));
    addEnvRow(card, t('env.browserClone'), t('env.browserCloneValue'), 'good');
    addEnvRow(card, t('env.sshBridge'), t('env.sshBridgeValue'), 'warn');
    addEnvRow(card, t('env.credStore'), RT.store?.storage?.name || 'browser');
    const authority = cap?.authority;
    if (authority?.present) {
        const capCount = Object.values(authority.capabilities || {}).filter(Boolean).length;
        addEnvRow(card, t('env.authority'), t('env.authorityPresent', { version: authority.version || '?', count: capCount }), 'good');
    } else {
        addEnvRow(card, t('env.authority'), t('env.authorityAbsent'), 'warn');
    }
    const me = await fetchJsonBounded('/api/users/me');
    const handle = String(me?.handle || me?.name || '');
    if (handle) addEnvRow(card, t('env.currentUser'), handle);
    addEnvRow(card, t('env.probeAt'), new Date(cap?.probeAt || Date.now()).toLocaleTimeString());
}

// ---------------------------------------------------------------- 分区三：账号（D5-3 功能全保留）

/** 账号管理（D5-3 功能全保留）：逐个登录、多账号、默认账号、验证、导出/导入。 */
function tabAccounts(root) {
    const section = el(`
        <div>
            <div class="stgi-note">${t('acc.note', { emphasis: `<b>${esc(t('acc.noteEmphasis'))}</b>` })}</div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <select data-role="type" style="flex:0 0 200px">
                        ${SITE_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
                    </select>
                    <input data-role="baseUrl" placeholder="${esc(t('acc.baseUrlPlaceholder'))}" style="display:none" />
                    <input data-role="username" placeholder="${esc(t('acc.usernamePlaceholder'))}" />
                </div>
                <div class="stgi-row">
                    <input data-role="token" placeholder="${esc(t('acc.tokenPlaceholder'))}" type="password" />
                    <input data-role="note" placeholder="${esc(t('acc.notePlaceholder'))}" style="flex:0 1 140px" />
                </div>
                <div class="stgi-row">
                    <label><input type="checkbox" data-role="makeDefault" checked /> ${esc(t('acc.makeDefaultLabel'))}</label>
                    <button class="stgi-btn primary" data-role="add" style="margin-left:auto">${esc(t('acc.add'))}</button>
                </div>
                <details>
                    <summary class="stgi-note" style="cursor:pointer">${esc(t('acc.otherMethods'))}</summary>
                    <div class="stgi-row" style="margin-top:6px">
                        <input data-role="userinfoUrl" placeholder="${esc(t('acc.userinfoPlaceholder'))}" />
                        <button class="stgi-btn" data-role="saveUserinfo">${esc(t('acc.saveUserinfo'))}</button>
                    </div>
                </details>
            </div>
            <div class="stgi-row">
                <button class="stgi-btn" data-role="export">${esc(t('acc.export'))}</button>
                <input type="file" data-role="importFile" accept="application/json" style="display:none" />
                <button class="stgi-btn" data-role="import">${esc(t('acc.import'))}</button>
                <button class="stgi-btn" data-role="testAll">${esc(t('acc.testAll'))}</button>
            </div>
            <div class="stgi-note" data-role="summary"></div>
            <table class="stgi-table"><thead>
                <tr><th>${esc(t('acc.colAccount'))}</th><th>${esc(t('acc.colSite'))}</th><th>${esc(t('acc.colMethod'))}</th><th>${esc(t('acc.colStatus'))}</th><th>${esc(t('acc.colDefault'))}</th><th>${esc(t('acc.colActions'))}</th></tr>
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
        if (!account.lastCheckedAt) return `<span class="stgi-badge warn">${esc(t('acc.statusUnchecked'))}</span>`;
        return account.lastCheckOk
            ? `<span class="stgi-badge good">${esc(t('acc.statusOk'))}${account.lastLogin ? ` (${esc(account.lastLogin)})` : ''}</span>`
            : `<span class="stgi-badge bad">${esc(t('acc.statusFailed'))}</span>`;
    }

    async function reload() {
        const snapshot = RT.store.snapshot();
        const rows = q('rows');
        q('summary').textContent = snapshot.accounts.length
            ? t('acc.summary', {
                accounts: snapshot.accounts.length,
                sites: new Set(snapshot.accounts.map(a => siteKeyOf(a.type, a.baseUrl))).size,
            })
            : '';
        rows.innerHTML = '';
        if (snapshot.accounts.length === 0) {
            rows.innerHTML = `<tr><td colspan="6">${esc(t('acc.empty'))}</td></tr>`;
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
                <td>${esc(account.note || account.username || t('acc.anonymous'))}<div class="stgi-note">${esc(account.username || '')}${checkedNote ? ` · ${esc(t('acc.verifiedAt', { time: checkedNote }))}` : ''}</div></td>
                <td>${esc(siteLabel)}</td>
                <td>${esc(account.method || 'pat')}</td>
                <td>${statusBadge(account)}</td>
                <td>${isDefault ? '<span class="stgi-badge good">★</span>' : `<button class="stgi-btn" data-act="setDefault" title="${esc(t('acc.setDefaultTitle'))}">☆</button>`}</td>
                <td>
                    <button class="stgi-btn" data-act="test">${esc(t('acc.test'))}</button>
                    <button class="stgi-btn" data-act="del">${esc(t('acc.delete'))}</button>
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
            row.querySelector('[data-act="test"]').addEventListener('click', async event => {
                const button = event.target;
                if (button.disabled) return;
                button.disabled = true;
                toast(t('acc.testing'));
                try {
                    const result = await RT.store.testAccount(account.id);
                    if (result.ok) toast(t('acc.testOk', { login: result.login || 'ok' }), 'success');
                    else if (result.blockedByBrowser) toast(t('acc.testBlockedShort'), 'error');
                    else toast(t('acc.testBad', { status: result.status }), 'error');
                    reload();
                } catch (error) {
                    if (error?.blockedByBrowser) {
                        toast(t('acc.testBlockedLong'), 'error');
                        reload();
                    } else {
                        toast(String(error.message || error), 'error');
                        button.disabled = false;
                    }
                }
            });
            row.querySelector('[data-act="del"]').addEventListener('click', async () => {
                const label = account.note || account.username || t('acc.anonymous');
                if (!window.confirm(t('acc.confirmDelete', { name: label }))) {
                    return;
                }
                try {
                    await RT.store.removeAccount(account.id);
                    toast(t('acc.deleted'), 'success');
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
            toast(t('acc.saved'), 'success');
            reload();
            // 保存后立即后台验证一次
            try {
                const result = await RT.store.testAccount(account.id);
                if (result.ok) toast(t('acc.verifyOk', { login: result.login || 'ok' }), 'success');
                else toast(t('acc.verifyFailed', { status: result.status }), 'error');
                reload();
            } catch (error) {
                if (error?.blockedByBrowser) {
                    toast(t('acc.testBlockedSaved'), 'error');
                    reload();
                } else {
                    toast(t('acc.verifyError', { message: error.message || error }), 'error');
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
            toast(t('acc.userinfoSaved'), 'success');
            reload();
        } catch (error) {
            toast(String(error.message || error), 'error');
        }
    });

    q('testAll').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        const accounts = RT.store.snapshot().accounts;
        if (accounts.length === 0) {
            toast(t('acc.testAllEmpty'), 'error');
            button.disabled = false;
            return;
        }
        toast(t('acc.testAllRunning', { count: accounts.length }));
        let okCount = 0;
        const failed = [];
        for (const account of accounts) {
            const label = account.note || account.username || t('acc.anonymous');
            try {
                const result = await RT.store.testAccount(account.id);
                if (result.ok || result.blockedByBrowser) okCount += 1;
                else failed.push(t('acc.testFailHttp', { name: label, status: result.status }));
            } catch (error) {
                if (error?.blockedByBrowser) okCount += 1;
                else failed.push(t('acc.testFailError', { name: label, message: error.message || error }));
            }
        }
        reload();
        toast(t('acc.testAllDone', {
            ok: okCount,
            failed: failed.length,
            detail: failed.length ? t('acc.testAllDetail', { list: failed.join(t('common.listSep')) }) : '',
        }), failed.length ? 'error' : 'success');
        button.disabled = false;
    });

    q('export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(RT.store.snapshot(), null, 2)], { type: 'application/json' });
        const link = el(`<a href="${URL.createObjectURL(blob)}" download="st-git-improve-accounts.json">${esc(t('acc.exportLink'))}</a>`);
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
            if (!Array.isArray(imported.accounts)) throw new Error(t('acc.errNoAccounts'));
            if (!window.confirm(t('acc.confirmImport', { count: imported.accounts.length }))) return;
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
            toast(t('acc.importDone'), 'success');
            reload();
        } catch (error) {
            toast(t('acc.importFailed', { message: error.message || error }), 'error');
        }
    });

    reload();
    return section;
}

// ---------------------------------------------------------------- 分区一：我的扩展（D5-1）

/** hostDiscover 结果短缓存：同一扫描周期内「我的扩展」与「治理」两区共享一次发现请求。 */
async function discoverCached({ force = false } = {}) {
    const fresh = RT.discover && Date.now() - RT.discover.at < 5000;
    if (!force && fresh) {
        return RT.discover.result;
    }
    const result = await hostDiscover();
    RT.discover = { at: Date.now(), result };
    return result;
}

/** 顶部安装入口（D5-1）：地址输入 + 通道提示 + 分支下拉（站点 API）+ 目标选择。 */
function buildInstallEntry(hooks) {
    const section = el(`
        <div class="stgi-section">
            <div class="stgi-note" data-role="channelHint" style="display:none"></div>
            <div class="stgi-row">
                <input data-role="url" placeholder="${esc(t('ext.urlPlaceholder'))}" style="flex:3 1 260px" />
                <input data-role="branch" placeholder="${esc(t('ext.branchPlaceholder'))}" style="flex:0 1 120px" list="stgi-branch-list" />
                <datalist id="stgi-branch-list" data-role="branchList"></datalist>
                <select data-role="target" style="flex:0 0 150px">
                    <option value="extension">${esc(t('ext.targetExtension'))}</option>
                    <option value="global">${esc(t('ext.targetGlobal'))}</option>
                </select>
            </div>
            <div class="stgi-row">
                <label><input type="checkbox" data-role="replace" /> ${esc(t('ext.replaceLabel'))}</label>
            </div>
            <div class="stgi-row">
                <button class="stgi-btn primary" data-role="go">${esc(t('ext.install'))}</button>
            </div>
            <div class="stgi-log" data-role="log" style="display:none"></div>
        </div>`);

    const q = role => section.querySelector(`[data-role="${role}"]`);
    applyGate(q('go'), can('install', RT.cap));

    // 通道可视化：输入地址即时显示将走的克隆通道（含不可用预警）
    const hint = q('channelHint');
    function updateChannelHint() {
        const result = channelHint(q('url').value, { mode: 'pure' });
        hint.textContent = result.text;
        hint.style.display = result.text ? '' : 'none';
        hint.classList.remove('stgi-hint-ok', 'stgi-hint-err', 'stgi-hint-warn');
        if (result.level === 'ok') hint.classList.add('stgi-hint-ok');
        else if (result.level === 'error') hint.classList.add('stgi-hint-err');
        else if (result.level === 'warn') hint.classList.add('stgi-hint-warn');
    }
    q('url').addEventListener('input', updateChannelHint);

    // 分支下拉（D3-1 #8 站点 API）：地址变化后拉取远端分支列表（失败静默，不阻塞输入；
    // 公开仓库无需凭据，私有仓库用该站点默认账号 token）
    const datalist = q('branchList');
    let branchTimer = null;
    let lastFetched = '';
    q('url').addEventListener('input', () => {
        clearTimeout(branchTimer);
        branchTimer = setTimeout(async () => {
            const value = q('url').value.trim();
            if (!value || value === lastFetched) return;
            const credential = await RT.store.credentialsFor(value).catch(() => null);
            const result = await fetchBranches(value, { auth: credential?.auth || null });
            if (result.ok) {
                lastFetched = value;
                datalist.innerHTML = result.branches.map(b => `<option value="${esc(b)}"></option>`).join('');
            }
        }, 700);
    });

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
                if (cls.channel === 'system') {
                    append(t('ext.installFailedUrl'), 'err');
                    toast(t('ext.installFailedUrl'), 'error');
                    return;
                }
                await RT.store.credentialsFor(url); // 预解析站点（错误提前暴露）
            }
            const result = await pureInstall({
                url,
                branch: q('branch').value.trim() || undefined,
                target: q('target').value,
                replace: q('replace')?.checked === true,
                accounts: RT.store,
                onLog: line => append(line),
            });
            append(t('ext.logDone', { name: result.name }), 'ok');
            // 附加能力：克隆成功时把结果导出为本地 zip（数据备份/手动上传双保险）
            if (result.cloned) {
                try {
                    const bytes = buildZipBytes(result.cloned);
                    const href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
                    const link = el(`<a class="stgi-btn" href="${href}" download="${esc(result.name || 'repository')}.zip">${esc(t('ext.zipCopy'))}</a>`);
                    log.append(el('<div></div>'), link);
                    setTimeout(() => URL.revokeObjectURL(href), 60000);
                } catch { /* 导出失败不影响安装结果 */ }
            }
            appendRefreshButton(log);
            toast(t('ext.installDoneToast'), 'success');
            await hooks.scanExtensions?.({ force: true });
        } catch (error) {
            append(t('ext.logFailed', { message: String(error?.message || error) }), 'err');
            toast(String(error.message || error), 'error');
        } finally {
            applyGate(button, can('install', RT.cap));
        }
    });

    return section;
}

/** 分区一「我的扩展」（D5-1 常驻列表 + 行内操作；D5-4 扫描三维 + 灰化列）。 */
function buildExtensionsZone(hooks) {
    const box = zoneWrap('extensions', t('ext.title'));
    box.append(el(`<div class="stgi-note">${esc(t('ext.installNote'))}</div>`));
    box.append(buildInstallEntry(hooks));

    const list = el(`
        <div>
            <div class="stgi-row"><b>${esc(t('ext.listTitle'))}</b></div>
            <table class="stgi-table"><thead>
                <tr><th>${esc(t('ext.colName'))}</th><th>${esc(t('ext.colVersion'))}</th><th>${esc(t('ext.colRemote'))}</th><th>${esc(t('ext.colDeps'))}</th><th>${esc(t('ext.colActions'))}</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
            <div class="stgi-log" data-role="zoneLog" style="display:none"></div>
        </div>`);
    box.append(list);

    const rows = list.querySelector('[data-role="rows"]');
    const zoneLog = list.querySelector('[data-role="zoneLog"]');

    /** 行内操作：更新（仅登记来源者；宿主 delete + 重装，删前强确认——本地改动不备份）。 */
    async function runUpdate(entry, origin, button) {
        const confirmed = await confirmDangerous({
            text: t('confirm.updateText', { name: entry.name || origin.url }),
            danger: t('confirm.updateDanger'),
            okButton: t('popup.confirmUpdate'),
        });
        if (!confirmed) return;
        button.disabled = true;
        zoneLog.style.display = '';
        zoneLog.innerHTML = '';
        const append = (line, kind = 'plain') => appendLogLine(zoneLog, line, kind);
        try {
            await pureInstall({
                url: origin.url,
                branch: origin.branch || undefined,
                target: origin.target || 'extension',
                replace: true,
                accounts: RT.store,
                onLog: line => append(line),
            });
            appendRefreshButton(zoneLog);
            toast(t('ext.toastUpdated', { name: entry.name || origin.url }), 'success');
            await refresh({ force: true });
        } catch (error) {
            append(t('ext.logFailed', { message: String(error?.message || error) }), 'err');
            toast(String(error.message || error), 'error');
        } finally {
            applyGate(button, can('update', RT.cap));
        }
    }

    /** 行内操作：卸载（宿主 delete + 官方 Popup 强确认 + 红字不可恢复，D9-3/R-13）。 */
    async function runUninstall(entry, button) {
        const confirmed = await confirmDangerous({
            text: t('confirm.uninstallText', { name: entry.name || '' }),
            danger: t('confirm.uninstallDanger'),
            okButton: t('popup.confirmUninstall'),
        });
        if (!confirmed) return;
        button.disabled = true;
        try {
            const result = await hostDeleteExtension(entry.name);
            if (!result.ok) {
                throw new Error(result.note || t('gov.opFailed'));
            }
            await RT.govLog?.append('uninstall', entry.name).catch(() => { });
            toast(t('ext.toastUninstalled', { name: entry.name }), 'success');
            await refresh({ force: true });
            await hooks.scanGovernance?.({ force: true });
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            applyGate(button, can('remove', RT.cap));
        }
    }

    /** 行内操作：迁全局/迁本地（宿主迁移通道；可逆操作免弹窗，D9-3）。 */
    async function runMove(entry, button) {
        const source = entry.scope === 'global' ? 'global' : 'local';
        const destination = source === 'global' ? 'local' : 'global';
        button.disabled = true;
        try {
            const result = await hostMoveExtension(entry.name, source, destination);
            if (!result.ok) {
                throw new Error(result.note || t('gov.migrateFailed'));
            }
            await RT.govLog?.append('move', entry.name, `${source} -> ${destination}`).catch(() => { });
            toast(t('gov.toastMoved', { name: entry.name, destination: destination === 'global' ? t('gov.destGlobal') : t('gov.destLocal') }), 'success');
            await refresh({ force: true });
            await hooks.scanGovernance?.({ force: true });
        } catch (error) {
            toast(String(error.message || error), 'error');
        } finally {
            applyGate(button, can('move', RT.cap));
        }
    }

    /** 常驻已装列表 + 扫描三维（D5-4）：已装列表 + 可更新标记 + 远端状态（站点 API）。 */
    async function refresh({ force = false } = {}) {
        rows.innerHTML = `<tr><td colspan="5">${esc(t('ext.loading'))}</td></tr>`;
        try {
            const [discoverResult, installs] = await Promise.all([discoverCached({ force }), Promise.resolve(RT.store.getInstalls())]);
            if (!discoverResult.ok) {
                throw new Error(`discover HTTP ${discoverResult.status}`);
            }
            const entries = discoverResult.entries;
            RT.summary.installed = entries.length;
            RT.summary.updatable = entries.filter(entry => installs[entry.name]).length;
            RT.summary.scannedAt = Date.now();
            hooks.onSummaryChange?.();
            rows.innerHTML = '';
            if (entries.length === 0) {
                rows.innerHTML = `<tr><td colspan="5">${esc(t('ext.empty'))}</td></tr>`;
                return;
            }
            const remoteTasks = [];
            for (const entry of entries) {
                const origin = installs[entry.name];
                const installedNote = origin?.installedAt
                    ? ` · ${t('ext.installedAt')} ${new Date(Number(origin.installedAt) * 1000).toLocaleString('zh-CN', { hour12: false })}`
                    : '';
                const originNote = origin
                    ? `<div class="stgi-note">${t('ext.source')}: ${esc(origin.url)}${origin.branch ? ` @${esc(origin.branch)}` : ''}${esc(installedNote)}</div>`
                    : '';
                const row = el(`<tr>
                    <td>${esc(entry.name || '')}${origin ? `<span class="stgi-badge good">${esc(t('ext.updatable'))}</span>` : ''}${originNote}</td>
                    <td>${esc(entry.version || '')}</td>
                    <td data-role="remoteCell">${esc(origin ? t('ext.remoteChecking') : t('ext.remoteUnknown'))}</td>
                    <td><button class="stgi-btn" data-act="extNeedAuthority" disabled title="${esc(t('cap.reason.needAuthority'))}">${esc(t('ext.needAuthority'))}</button></td>
                    <td class="stgi-actions-cell"></td>
                </tr>`);
                const actionsCell = row.querySelector('.stgi-actions-cell');
                if (origin) {
                    const updateButton = el(`<button class="stgi-btn">${esc(t('ext.update'))}</button>`);
                    updateButton.addEventListener('click', () => runUpdate(entry, origin, updateButton));
                    actionsCell.append(updateButton);
                    applyGate(updateButton, can('update', RT.cap));
                    remoteTasks.push({ origin, cell: row.querySelector('[data-role="remoteCell"]') });
                }
                const uninstallButton = el(`<button class="stgi-btn">${esc(t('ext.uninstall'))}</button>`);
                uninstallButton.addEventListener('click', () => runUninstall(entry, uninstallButton));
                actionsCell.append(uninstallButton);
                applyGate(uninstallButton, can('remove', RT.cap));
                const moveLabel = entry.scope === 'global' ? t('ext.moveToLocal') : t('ext.moveToGlobal');
                const moveButton = el(`<button class="stgi-btn">${esc(moveLabel)}</button>`);
                moveButton.addEventListener('click', () => runMove(entry, moveButton));
                actionsCell.append(moveButton);
                applyGate(moveButton, can('move', RT.cap));
                rows.append(row);
            }
            // 三维之「远端状态」：顺序逐个检查，避免触发站点 API 限流；失败显示「—」+ tooltip（D5-4）
            for (const task of remoteTasks) {
                const credential = await RT.store.credentialsFor(task.origin.url).catch(() => null);
                const result = await checkRemoteUpdate(task.origin, { auth: credential?.auth || null });
                if (result.ok && result.state === 'newer') {
                    task.cell.innerHTML = `<span class="stgi-badge warn">${esc(t('ext.remoteNewer'))}</span>`;
                } else if (result.ok && result.state === 'same') {
                    task.cell.innerHTML = `<span class="stgi-badge good">${esc(t('ext.remoteSame'))}</span>`;
                } else {
                    task.cell.textContent = t('ext.remoteUnknown');
                    task.cell.title = t(result.reasonKey || 'remote.err.network');
                }
            }
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="5">${esc(t('ext.scanFailed', { message: String(error?.message || error) }))}</td></tr>`;
        }
    }

    refresh();
    return { box, refresh };
}

// ---------------------------------------------------------------- 分区二：治理与清理（D5-2）

/** 纯前端治理：宿主设置 disabledExtensions 集合读取（实测键位 extension_settings.disabledExtensions，兼容旧形态）。 */
async function currentDisabledSet() {
    const settings = await hostSettingsGet();
    if (!settings.ok || !settings.data) {
        throw new Error(t('gov.err.settingsUnreachable', { status: String(settings.status) }));
    }
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

/**
 * 分区二「治理与清理」（D5-2）：
 * 停用/启用（宿主设置开关）+ 一键全停/全启（留本区，不上总览，D4-4）+
 * 去重扫描与删除本地副本（无改动守卫不可行 → 官方 Popup 强确认 + 风险提示，D3-1 #5）+
 * 治理台账（extension_settings 本地记录，C-2）+ Authority 管理能力常显灰化（D3-4）。
 */
function buildGovernanceZone(hooks) {
    const box = zoneWrap('governance', t('gov.title'));
    box.append(el(`<div class="stgi-note">${esc(t('gov.note'))}</div>`));
    // 注意：el() 只返回首个顶级元素——本块含 5 个兄弟块，必须包一层容器 div，
    // 否则表格/去重区/台账区/灰化按钮区会被静默丢弃（1.3 验收实锤 bug 的修复）。
    box.append(el(`
        <div>
            <div class="stgi-row">
                <button class="stgi-btn" data-act="govDisableAll">${esc(t('gov.disableAll'))}</button>
                <button class="stgi-btn" data-act="govEnableAll">${esc(t('gov.enableAll'))}</button>
            </div>
            <table class="stgi-table"><thead>
                <tr><th>${esc(t('gov.colName'))}</th><th>${esc(t('gov.colState'))}</th><th>${esc(t('gov.colActions'))}</th></tr>
            </thead><tbody data-role="rows"></tbody></table>
            <div class="stgi-section">
                <div class="stgi-row"><b>${esc(t('gov.dedupTitle'))}</b></div>
                <div class="stgi-note">${esc(t('gov.dedupNote'))}</div>
                <table class="stgi-table" data-role="dedupTable" style="display:none"><thead>
                    <tr><th>${esc(t('gov.colName'))}</th><th>${esc(t('ext.colVersion'))}</th><th>${esc(t('gov.colActions'))}</th></tr>
                </thead><tbody data-role="dedupRows"></tbody></table>
            </div>
            <div class="stgi-section">
                <div class="stgi-row">
                    <button class="stgi-btn" data-act="govLedgerToggle">${esc(t('gov.ledgerToggle'))}</button>
                </div>
                <table class="stgi-table" data-role="ledgerTable" style="display:none"><thead>
                    <tr><th>${esc(t('gov.ledgerColTime'))}</th><th>${esc(t('gov.ledgerColAction'))}</th><th>${esc(t('gov.ledgerColName'))}</th><th>${esc(t('gov.ledgerColDetail'))}</th></tr>
                </thead><tbody data-role="ledgerRows"></tbody></table>
            </div>
            <div class="stgi-section">
                <div class="stgi-row"><b>${esc(t('gov.grayedTitle'))}</b></div>
                <div class="stgi-row">
                    <button class="stgi-btn" data-role="grayDisableZone">${esc(t('gov.grayed.disableZone'))}</button>
                    <button class="stgi-btn" data-role="grayPurge">${esc(t('gov.grayed.purge'))}</button>
                    <button class="stgi-btn" data-role="grayDepsFix">${esc(t('gov.grayed.depsFix'))}</button>
                    <button class="stgi-btn" data-role="grayBackup">${esc(t('gov.grayed.backup'))}</button>
                </div>
            </div>
        </div>`));

    const rows = box.querySelector('[data-role="rows"]');
    const dedupTable = box.querySelector('[data-role="dedupTable"]');
    const dedupRows = box.querySelector('[data-role="dedupRows"]');
    const ledgerTable = box.querySelector('[data-role="ledgerTable"]');
    const ledgerRows = box.querySelector('[data-role="ledgerRows"]');
    let lastEntries = [];
    let lastDisabled = new Set();

    // D3-4 常显灰化引导：Authority 管理能力按钮（can() 裁决 + reasonKey tooltip，D9-1）
    applyGate(box.querySelector('[data-role="grayDisableZone"]'), can('disableZone', RT.cap));
    applyGate(box.querySelector('[data-role="grayPurge"]'), can('purgeZone', RT.cap));
    applyGate(box.querySelector('[data-role="grayDepsFix"]'), can('depsFix', RT.cap));
    applyGate(box.querySelector('[data-role="grayBackup"]'), can('rebuildUpdate', RT.cap));
    applyGate(box.querySelector('[data-act="govDisableAll"]'), can('governToggle', RT.cap));
    applyGate(box.querySelector('[data-act="govEnableAll"]'), can('governToggle', RT.cap));

    /** 去重表渲染（重复 = 同名同时存在于 local 与 global）。 */
    function renderDedup(duplicates) {
        dedupRows.innerHTML = '';
        dedupTable.style.display = '';
        if (duplicates.length === 0) {
            dedupRows.innerHTML = `<tr><td colspan="3">${esc(t('gov.dedupScanEmpty'))}</td></tr>`;
            return;
        }
        for (const dup of duplicates) {
            const row = el(`<tr>
                <td>${esc(dup.local.name)}</td>
                <td>${esc(dup.local.version || t('gov.versionUnknown'))} → ${esc(dup.global.version || t('gov.versionUnknown'))}</td>
                <td class="stgi-actions-cell"></td>
            </tr>`);
            const deleteButton = el(`<button class="stgi-btn">${esc(t('gov.dedupDelete'))}</button>`);
            deleteButton.addEventListener('click', () => runDedupDelete(dup, deleteButton));
            row.querySelector('.stgi-actions-cell').append(deleteButton);
            applyGate(deleteButton, can('dedupCleanBasic', RT.cap));
            dedupRows.append(row);
        }
    }

    /** 行内操作：删除本地重复副本（宿主 delete；纯前端无法核实本地改动 → 强确认 + 风险提示）。 */
    async function runDedupDelete(dup, button) {
        const confirmed = await confirmDangerous({
            text: t('confirm.dedupText', { name: dup.local.name }),
            danger: t('confirm.dedupDanger'),
            okButton: t('popup.confirmDelete'),
        });
        if (!confirmed) return;
        button.disabled = true;
        try {
            const result = await hostDeleteExtension(dup.local.name);
            if (!result.ok) {
                throw new Error(result.note || t('gov.opFailed'));
            }
            await RT.govLog?.append('dedupClean', dup.local.name).catch(() => { });
            toast(t('gov.toastDedupDeleted', { name: dup.local.name }), 'success');
            await reload();
            await hooks.scanExtensions?.({ force: true });
        } catch (error) {
            toast(String(error.message || error), 'error');
            applyGate(button, can('dedupCleanBasic', RT.cap));
        }
    }

    /** 停用/启用（宿主设置开关；可逆操作免弹窗，D9-3）。 */
    async function runToggle(name, isDisabled, button) {
        button.disabled = true;
        try {
            const result = await hostToggleExtensionDisabled(name, !isDisabled);
            if (result.ok) {
                await RT.govLog?.append(isDisabled ? 'enable' : 'disable', name).catch(() => { });
                toast(t(isDisabled ? 'gov.toastEnabled' : 'gov.toastDisabled', { name }), 'success');
                await reload();
            } else {
                toast(result.note || t('gov.opFailed'), 'error');
                button.disabled = false;
            }
        } catch (error) {
            toast(String(error.message || error), 'error');
            button.disabled = false;
        }
    }

    async function reload() {
        rows.innerHTML = `<tr><td colspan="3">${esc(t('gov.loading'))}</td></tr>`;
        dedupTable.style.display = 'none';
        try {
            const [disabled, discoverResult] = await Promise.all([currentDisabledSet(), discoverCached()]);
            const entries = discoverResult.ok ? discoverResult.entries : [];
            lastEntries = entries;
            lastDisabled = disabled;
            RT.summary.disabled = entries.length > 0
                ? entries.filter(entry => disabled.has(entry.name)).length
                : disabled.size;
            const globalByName = new Map(entries.filter(entry => entry.scope === 'global').map(entry => [entry.name, entry]));
            const duplicates = entries
                .filter(entry => entry.scope === 'local' && globalByName.has(entry.name))
                .map(entry => ({ local: entry, global: globalByName.get(entry.name) }));
            RT.summary.duplicates = duplicates.length;
            RT.summary.scannedAt = Date.now();
            hooks.onSummaryChange?.();

            rows.innerHTML = '';
            if (entries.length === 0 && disabled.size === 0) {
                rows.innerHTML = `<tr><td colspan="3">${esc(t('gov.empty'))}</td></tr>`;
                return;
            }
            const names = entries.length > 0 ? entries.map(entry => entry.name) : [...disabled];
            const scopeByName = new Map(entries.map(entry => [entry.name, entry.scope]));
            for (const name of names) {
                const isDisabled = disabled.has(name);
                const scope = scopeByName.get(name) || 'local';
                const row = el(`<tr>
                    <td>${esc(name)}<div class="stgi-note">${esc(scope === 'global' ? t('gov.scopeGlobalNote') : t('gov.scopeLocalNote'))}</div></td>
                    <td>${isDisabled ? `<span class="stgi-badge warn">${esc(t('gov.stateOff'))}</span>` : `<span class="stgi-badge good">${esc(t('gov.stateOn'))}</span>`}</td>
                    <td class="stgi-actions-cell"></td>
                </tr>`);
                const toggleButton = el(`<button class="stgi-btn">${esc(isDisabled ? t('gov.enable') : t('gov.disable'))}</button>`);
                toggleButton.addEventListener('click', () => runToggle(name, isDisabled, toggleButton));
                row.querySelector('.stgi-actions-cell').append(toggleButton);
                applyGate(toggleButton, can('governToggle', RT.cap));
                rows.append(row);
            }
            renderDedup(duplicates);
        } catch (error) {
            rows.innerHTML = `<tr><td colspan="3">${esc(t('gov.loadFailed', { message: String(error?.message || error) }))}</td></tr>`;
        }
    }

    // 一键全停（D4-4：留治理分区内；跳过本插件自身，避免自断面板）
    box.querySelector('[data-act="govDisableAll"]').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        try {
            const targets = lastEntries.filter(entry => entry.scope === 'local' && entry.name !== 'st-git-improve');
            let okCount = 0;
            const failed = [];
            for (const entry of targets) {
                try {
                    const result = await hostToggleExtensionDisabled(entry.name, true);
                    if (result.ok) {
                        okCount += 1;
                        await RT.govLog?.append('disable', entry.name, 'batch').catch(() => { });
                    } else {
                        failed.push(entry.name);
                    }
                } catch {
                    failed.push(entry.name);
                }
            }
            const failedNote = failed.length ? t('gov.allDoneFailed', { failed: failed.join(t('common.listSep')) }) : '';
            toast(t('gov.disableAllDone', { ok: okCount, failed: failedNote }), okCount > 0 ? 'success' : 'error');
            await reload();
        } finally {
            applyGate(button, can('governToggle', RT.cap));
        }
    });

    // 一键全启（把宿主设置停用清单里的已装扩展全部启用）
    box.querySelector('[data-act="govEnableAll"]').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        try {
            const targets = lastEntries.filter(entry => lastDisabled.has(entry.name));
            let okCount = 0;
            const failed = [];
            for (const entry of targets) {
                try {
                    const result = await hostToggleExtensionDisabled(entry.name, false);
                    if (result.ok) {
                        okCount += 1;
                        await RT.govLog?.append('enable', entry.name, 'batch').catch(() => { });
                    } else {
                        failed.push(entry.name);
                    }
                } catch {
                    failed.push(entry.name);
                }
            }
            const failedNote = failed.length ? t('gov.allDoneFailed', { failed: failed.join(t('common.listSep')) }) : '';
            toast(t('gov.enableAllDone', { ok: okCount, failed: failedNote }), okCount > 0 ? 'success' : 'error');
            await reload();
        } finally {
            applyGate(button, can('governToggle', RT.cap));
        }
    });

    // 治理台账（extension_settings 本地记录，C-2；最新在前，最近 50 条）
    box.querySelector('[data-act="govLedgerToggle"]').addEventListener('click', async event => {
        const button = event.target;
        const show = ledgerTable.style.display === 'none';
        ledgerTable.style.display = show ? '' : 'none';
        if (!show) return;
        ledgerRows.innerHTML = `<tr><td colspan="4">${esc(t('gov.loading'))}</td></tr>`;
        try {
            const actions = await RT.govLog.list({ limit: 50 });
            ledgerRows.innerHTML = '';
            if (!actions.length) {
                ledgerRows.innerHTML = `<tr><td colspan="4">${esc(t('gov.ledgerEmpty'))}</td></tr>`;
                return;
            }
            for (const entry of actions) {
                ledgerRows.append(el(`<tr>
                    <td>${esc(new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }))}</td>
                    <td>${esc(t(`ledger.action.${entry.action}`))}</td>
                    <td>${esc(entry.name || '')}</td>
                    <td>${esc(entry.detail || '—')}</td>
                </tr>`));
            }
        } catch (error) {
            ledgerRows.innerHTML = `<tr><td colspan="4">${esc(t('gov.loadFailed', { message: String(error?.message || error) }))}</td></tr>`;
        }
    });

    reload();
    return { box, refresh: reload };
}

// ---------------------------------------------------------------- 分区三：就地设置（D4-3 / D5-3）

/** 就地设置块（D5-3）：去重颗粒度/自动清理——Authority 态生效，纯前端常显灰化 + tooltip（D3-4）。 */
function buildInlineSettings() {
    const gate = can('dedupClean', RT.cap);
    const reasonKey = gate.allowed ? 'settings.pendingAuthority' : (gate.reasonKey || 'cap.reason.needAuthority');
    return el(`<div class="stgi-section stgi-grayed" title="${esc(t(reasonKey))}">
        <div class="stgi-note"><b>${esc(t('settings.dedupTitle'))}</b>${esc(t('common.colonSep'))}${esc(t('settings.dedupNote'))}</div>
        <div class="stgi-row">
            <label><input type="radio" name="stgiDedup" value="name" disabled /> ${esc(t('settings.dedupName'))}</label>
            <label><input type="radio" name="stgiDedup" value="name+version" disabled /> ${esc(t('settings.dedupNameVersion'))}</label>
        </div>
        <div class="stgi-row">
            <label><input type="checkbox" disabled /> ${esc(t('settings.autoClean'))}</label>
        </div>
    </div>`);
}

// ---------------------------------------------------------------- 官方 Popup（红线 2：废除自造浮层；L1-MR-4 官方通道）

let popupMod; // undefined=未加载；false=加载失败（降级 window.confirm）；否则为模块

async function loadPopupMod() {
    if (popupMod !== undefined) return popupMod;
    try {
        popupMod = await import('/scripts/popup.js');
        if (typeof popupMod?.callGenericPopup !== 'function' || !popupMod?.POPUP_TYPE) {
            throw new Error('popup API missing');
        }
    } catch (error) {
        console.warn('[st-git-improve] official popup unavailable, falling back to window.confirm:', error);
        popupMod = false;
    }
    return popupMod;
}

/** 有界等待（L1-MR-7）：Popup promise 超时按「用户未响应 = 取消」兜底 settle，禁止永久 pending。 */
const POPUP_SETTLE_TIMEOUT_MS = 300000;
function withBoundedSettle(promise) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), POPUP_SETTLE_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 强确认弹窗（D9-3：不可恢复操作——卸载/删重复副本/删旧重装）。
 * 官方文档用法：callGenericPopup(content, POPUP_TYPE.CONFIRM)，结果 truthy = 确认；
 * 内容为「后果说明 + 红字不可恢复」。import 失败或 API 缺失时降级 window.confirm（L0-11）。
 * @param {{ text: string, danger?: string, okButton?: string }} options
 * @returns {Promise<boolean>}
 */
async function confirmDangerous(options) {
    const mod = await loadPopupMod();
    if (!mod) {
        const plain = `${options.text}${options.danger ? `\n${options.danger}` : ''}`;
        return window.confirm(plain);
    }
    const body = el('<div class="stgi-popup-body"></div>');
    const textRow = el('<div class="stgi-popup-text"></div>');
    textRow.textContent = options.text;
    body.append(textRow);
    if (options.danger) {
        const dangerRow = el('<div class="stgi-popup-danger"></div>');
        dangerRow.textContent = options.danger;
        body.append(dangerRow);
    }
    const result = await withBoundedSettle(mod.callGenericPopup(body, mod.POPUP_TYPE.CONFIRM, {
        okButton: options.okButton || t('popup.ok'),
        cancelButton: t('popup.cancel'),
    }));
    return Boolean(result);
}

// ---------------------------------------------------------------- 面板装配（总览 + 三区；D4-1/D4-2）

/** 分区骨架（同页纵向分区，D4-2；非旧五页签）。 */
function zoneWrap(zoneKey, title) {
    const box = el(`<section class="stgi-section stgi-zone" data-zone="${esc(zoneKey)}">
        <div class="stgi-zone-title"></div>
    </section>`);
    box.querySelector('.stgi-zone-title').textContent = title;
    return box;
}

/** 分区三「账号与设置」（D5-3：账号功能全保留 + 就地设置灰化）。 */
function buildAccountsZone(hooks) {
    const box = zoneWrap('accounts', t('acc.title'));
    box.append(tabAccounts(null));
    box.append(buildInlineSettings());
    async function refresh() {
        const snapshot = RT.store.snapshot();
        RT.summary.accounts = snapshot.accounts.length;
        RT.summary.sites = new Set(snapshot.accounts.map(a => siteKeyOf(a.type, a.baseUrl))).size;
        hooks.onSummaryChange?.();
    }
    refresh();
    return { box, refresh };
}

/** 分区状态摘要（D4-1 首屏三件套之二）：每分区一行统计，点击滚动到对应分区。 */
function buildZoneSummary(root) {
    const box = el(`<div class="stgi-section stgi-summary">
        <div class="stgi-row"><b>${esc(t('overview.zones'))}</b><span class="stgi-note">${esc(t('sum.jumpHint'))}</span></div>
        <div class="stgi-summary-row" data-jump="extensions"><span class="stgi-summary-name"></span><span class="stgi-summary-stats"></span></div>
        <div class="stgi-summary-row" data-jump="governance"><span class="stgi-summary-name"></span><span class="stgi-summary-stats"></span></div>
        <div class="stgi-summary-row" data-jump="accounts"><span class="stgi-summary-name"></span><span class="stgi-summary-stats"></span></div>
    </div>`);
    const names = { extensions: t('sum.extName'), governance: t('sum.govName'), accounts: t('sum.accName') };
    for (const row of box.querySelectorAll('.stgi-summary-row')) {
        row.querySelector('.stgi-summary-name').textContent = names[row.dataset.jump] || '';
        row.addEventListener('click', () => {
            root.querySelector(`[data-zone="${row.dataset.jump}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    function render() {
        const scanned = Boolean(RT.summary.scannedAt);
        const stats = {
            extensions: scanned
                ? t('sum.extStats', { installed: RT.summary.installed, updatable: RT.summary.updatable })
                : t('sum.pending'),
            governance: scanned
                ? t('sum.govStats', { disabled: RT.summary.disabled, duplicates: RT.summary.duplicates })
                : t('sum.pending'),
            accounts: t('sum.accStats', { accounts: RT.summary.accounts, sites: RT.summary.sites }),
        };
        for (const row of box.querySelectorAll('.stgi-summary-row')) {
            row.querySelector('.stgi-summary-stats').textContent = stats[row.dataset.jump] || '';
        }
    }
    return { box, render };
}

/** 快捷动作区（D4-4）：全部更新 · 全量扫描 · 面板自更新检查；结果内联反馈，完成后回写分区摘要。 */
function buildQuickActions(root, hooks) {
    const box = el(`<div class="stgi-section stgi-quick">
        <div class="stgi-row"><b>${esc(t('quick.title'))}</b></div>
        <div class="stgi-row">
            <button class="stgi-btn" data-act="quickUpdateAll">${esc(t('quick.updateAll'))}</button>
            <button class="stgi-btn" data-act="quickFullScan">${esc(t('quick.fullScan'))}</button>
            <button class="stgi-btn" data-act="quickSelfCheck">${esc(t('quick.selfCheck'))}</button>
            <span class="stgi-note" data-role="quickState"></span>
        </div>
        <div class="stgi-row"><span class="stgi-note" data-role="selfState"></span></div>
        <div class="stgi-log" data-role="quickLog" style="display:none"></div>
    </div>`);

    const q = role => box.querySelector(`[data-role="${role}"]`);
    const quickState = q('quickState');
    const quickLog = q('quickLog');
    const fullScanGate = () => ({
        allowed: RT.cap?.host?.discover === true,
        reasonKey: RT.cap?.host?.reasonKey || 'cap.reason.hostUnreachable',
    });

    // 能力态裁决（D9-1 逐项灰化）：全部更新依赖宿主 install 通道；全量扫描依赖 discover 可达
    applyGate(box.querySelector('[data-act="quickUpdateAll"]'), can('update', RT.cap));
    applyGate(box.querySelector('[data-act="quickFullScan"]'), fullScanGate());

    // 全部更新（全局批量动作，C-1 唯一入口）：顺序更新全部登记来源的扩展
    box.querySelector('[data-act="quickUpdateAll"]').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        quickState.textContent = t('quick.updating');
        quickLog.style.display = '';
        quickLog.innerHTML = '';
        const append = (line, kind = 'plain') => appendLogLine(quickLog, line, kind);
        const installs = Object.entries(RT.store.getInstalls());
        if (installs.length === 0) {
            quickState.textContent = '';
            append(t('quick.nothingRegistered'), 'warn');
            toast(t('quick.nothingRegistered'), 'error');
            applyGate(button, can('update', RT.cap));
            return;
        }
        append(t('quick.updateTotal', { count: installs.length }));
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
                    onLog: line => append(line),
                });
                okCount += 1;
            } catch (error) {
                failed.push(name);
                append(t('ext.logFailed', { message: String(error?.message || error) }), 'err');
            }
        }
        append(t('quick.updateSummary', { ok: okCount, failed: failed.length }), failed.length ? 'err' : 'ok');
        appendRefreshButton(quickLog);
        quickState.textContent = t('quick.updateSummary', { ok: okCount, failed: failed.length });
        toast(t('quick.updateSummary', { ok: okCount, failed: failed.length }), failed.length > 0 ? 'error' : 'success');
        await hooks.scanExtensions?.({ force: true });
        applyGate(button, can('update', RT.cap));
    });

    // 全量扫描（C-1 唯一入口）：我的扩展三维 + 治理去重，完成后回写分区摘要
    box.querySelector('[data-act="quickFullScan"]').addEventListener('click', async event => {
        const button = event.target;
        button.disabled = true;
        quickState.textContent = t('quick.scanning');
        try {
            await hooks.scanExtensions?.({ force: true });
            await hooks.scanGovernance?.({ force: true });
            quickState.textContent = t('quick.scanDone');
        } catch (error) {
            quickState.textContent = t('ext.scanFailed', { message: String(error?.message || error) });
        } finally {
            applyGate(button, fullScanGate());
        }
    });

    // 面板自更新检查（C-1 唯一入口）
    box.querySelector('[data-act="quickSelfCheck"]').addEventListener('click', event => {
        runSelfUpdateCheck(q('selfState'), event.target);
    });

    return box;
}

/** 面板主装配（openMain 重写）：总览首屏三件套 + 三区（D4-1/D4-2）。 */
async function buildPanel(container) {
    const [store, cap] = await Promise.all([
        RT.store ? Promise.resolve(RT.store) : getSharedStore(),
        detectCapabilityState(),
    ]);
    RT.store = store;
    RT.cap = cap;
    RT.govLog = RT.govLog || createGovernanceLog();

    const root = el('<div class="stgi-panel"></div>');
    const overview = zoneWrap('overview', t('overview.title'));
    const summaryCtl = buildZoneSummary(root);
    const hooks = {
        onSummaryChange: () => summaryCtl.render(),
        scanExtensions: null,
        scanGovernance: null,
    };
    const extensionsZone = buildExtensionsZone(hooks);
    hooks.scanExtensions = extensionsZone.refresh;
    const governanceZone = buildGovernanceZone(hooks);
    hooks.scanGovernance = governanceZone.refresh;
    const accountsZone = buildAccountsZone(hooks);

    overview.append(buildEnvCard(), summaryCtl.box, buildQuickActions(root, hooks));
    root.append(overview, extensionsZone.box, governanceZone.box, accountsZone.box);
    container.innerHTML = '';
    container.append(root);

    // 首屏数据：环境卡 + 三区常驻列表（D5-1 进入即展示）；各自内部捕获错误不互相拖垮
    fillEnv(overview.querySelector('[data-role="envCard"]'))
        .catch(error => console.error('[st-git-improve] env card fill failed:', error));
    extensionsZone.refresh();
    governanceZone.refresh();
    accountsZone.refresh();

    // 分区摘要联动：账号库任何落盘（增删账号/验证/来源登记）后刷新摘要计数
    const originalSave = store.save.bind(store);
    store.save = async (...args) => {
        const result = await originalSave(...args);
        accountsZone.refresh();
        return result;
    };
}

// ---------------------------------------------------------------- entry（D6-5/D6-6：唯一 UI 注入点 = 扩展设置抽屉，零额外按钮）

const DRAWER_SELECTORS = ['#extensions_settings2', '#extensions_settings'];
const DRAWER_WAIT_TIMEOUT_MS = 15000;
const DRAWER_POLL_INTERVAL_MS = 500;

/** 有界等待扩展设置抽屉容器出现（宿主异步构建 DOM；超时返回 null，L1-MR-7）。 */
function waitForDrawerContainer(timeoutMs = DRAWER_WAIT_TIMEOUT_MS) {
    return new Promise(resolve => {
        if (typeof document === 'undefined') {
            // Node/测试环境：无 DOM 可挂载，立即按「容器不存在」结算，不留定时器
            resolve(null);
            return;
        }
        const pick = () => {
            for (const selector of DRAWER_SELECTORS) {
                const found = document.querySelector(selector);
                if (found) return found;
            }
            return null;
        };
        let observer = null;
        let timer = null;
        function cleanup() {
            if (observer) observer.disconnect();
            if (timer) clearInterval(timer);
            clearTimeout(timeoutTimer);
        }
        function check() {
            const found = pick();
            if (!found) return false;
            cleanup();
            resolve(found);
            return true;
        }
        const timeoutTimer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
        if (check()) return;
        timer = setInterval(check, DRAWER_POLL_INTERVAL_MS);
        observer = new MutationObserver(check);
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    });
}

/**
 * 面板区块（官方文档记载的扩展设置块形态：inline-drawer 结构由宿主样式与
 * 事件委托接管，本扩展样式只落在 .stgi-* 类上）。
 */
function buildDrawerBlock(container) {
    const block = el(`<div class="stgi-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-role="panelTitle"></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stgi-note" data-role="panelBody"></div>
            </div>
        </div>
    </div>`);
    block.querySelector('[data-role="panelTitle"]').textContent = t('panel.title');
    block.querySelector('[data-role="panelBody"]').textContent = t('panel.loading');
    container.append(block);
    return block.querySelector('[data-role="panelBody"]');
}

async function mountPanelBlock() {
    // 幂等守卫：壳内调试可能手动重复 import/执行本模块，先移除已有面板块再挂载，防重复实例
    if (typeof document !== 'undefined') {
        document.querySelectorAll('.stgi-block').forEach(node => node.remove());
    }
    const container = await waitForDrawerContainer();
    if (!container) {
        console.error('[st-git-improve] extensions settings drawer not found; panel not injected');
        return;
    }
    const body = buildDrawerBlock(container);
    try {
        await buildPanel(body);
    } catch (error) {
        console.error('[st-git-improve] panel render failed:', error);
        body.textContent = '';
        body.append(el(`<div class="stgi-note">${esc(t('panel.renderFailed'))}</div>`));
    }
}

export function initExtension() {
    try {
        const mounting = mountPanelBlock();
        if (mounting && typeof mounting.catch === 'function') {
            mounting.catch(error => console.error('[st-git-improve] panel mount failed:', error));
        }
    } catch (error) {
        console.error('[st-git-improve] init failed:', error);
    }
    console.log('[st-git-improve] panel registered');
}

// ST evaluates extension modules after DOM ready.
try {
    initExtension();
} catch (error) {
    console.error('[st-git-improve] init failed:', error);
}
