// 更新冲突识别与修复编排（纯逻辑，无 DOM 依赖；L1-MR-6 三形态同构，Node 可单测）。
//
// 语义（2026-11-07 需求）：「使插件正常更新」优先无损——宿主原生更新通道能 ff 就直接
// 更新并保留本地改动；被 git 拒绝（未跟踪文件挡道/本地改动冲突/分叉）时按 classifyGitError
// 分类，交 UI 出修复卡；修复 = 可选备份（backupFn 注入，纯前端无文件读取通道故缺省不可用）
// → 删旧目录 → 原生重装（冲突未跟踪文件随目录一并清除，等效「备份先行→只删冲突→ff 更新」
// 的重建形态）。破坏性动作的强确认由 UI 层负责（D9-3），本模块不做确认。

// 版本参数：与 manifest.json version 同步（宿主 HTTP 缓存破坏），见 index.js 说明。
const V = '0.9.3';

const { classifyGitError, kinds } = await import(`./conflict.js?v=${V}`);
const { hostNativeUpdate, hostDeleteExtension, hostNativeInstall } = await import(`./backend.js?v=${V}`);
const { buildAuthedUrl } = await import(`./installflow.js?v=${V}`);
const { fetchRemoteHead } = await import(`./remote-status.js?v=${V}`);

export { kinds as conflictKinds };

/**
 * 原生无损更新探测（一次尝试；调用即一次真实更新——能 ff 就已更新，被拒则无副作用）。
 * @param {string} name 扩展名（裸名，不带 third-party/ 前缀）
 * @param {{ global?: boolean }} [options]
 * @returns {Promise<{ status: 'up-to-date'|'updated'|'no-channel'|'untracked-conflict'|'local-changes'|'diverged'|'network'|'other'|'failed', files: string[], shortCommitHash: string, raw: string }>}
 */
export async function probeNativeUpdate(name, { global = false } = {}) {
    const result = await hostNativeUpdate(name, global);
    if (result.channelMissing) {
        return { status: 'no-channel', files: [], shortCommitHash: '', raw: '' };
    }
    const errorText = String(result.data?.rawText || result.data?.raw || result.data?.error || '');
    if (result.ok) {
        return {
            status: result.data?.isUpToDate ? 'up-to-date' : 'updated',
            files: [],
            shortCommitHash: String(result.data?.shortCommitHash || ''),
            raw: '',
        };
    }
    const cls = classifyGitError(errorText);
    return {
        status: cls.kind === kinds.NONE ? 'failed' : cls.kind,
        files: cls.files,
        shortCommitHash: '',
        raw: errorText,
    };
}

/**
 * 重建修复：删旧目录 + 原生重装（调用方先做强确认，D9-3）。
 * 备份经 backupFn 可选注入（Authority 文件/备份通道接入点）：不传 = 无备份通道，
 * 记一条日志并跳过（纯前端形态的预期路径）。
 * @param {{ name: string, url: string, branch?: string, target?: 'extension'|'global',
 *          accounts: import('./accounts.js').AccountStore, backupFn?: (ctx: object) => Promise<void>,
 *          onLog?: (line: string) => void }} options
 * @returns {Promise<{ name: string, mode: 'rebuild', backedUp: boolean }>}
 */
export async function repairByRebuild({ name, url, branch, target = 'extension', accounts, backupFn, onLog }) {
    const log = onLog || (() => { });
    let backedUp = false;
    if (backupFn) {
        log('备份扩展目录…');
        await backupFn({ name, url, branch: branch || '', target });
        backedUp = true;
    } else {
        log('备份不可用（纯前端无文件读取通道）——跳过备份');
    }
    log('删除旧版目录…');
    const deleted = await hostDeleteExtension(name, target === 'global');
    if (!deleted.ok) {
        throw new Error(`删除旧版失败: ${deleted.note}`);
    }
    log('宿主原生重装…');
    const credential = await accounts.credentialsFor(url).catch(() => null);
    const authedUrl = buildAuthedUrl(url, credential?.auth || null);
    const installed = await hostNativeInstall({
        authedUrl,
        global: target === 'global',
        branch: branch || undefined,
    });
    if (!installed.ok) {
        const detail = installed.data?.error || installed.data?.raw || `HTTP ${installed.status}`;
        throw new Error(`重装失败: ${detail}`);
    }
    // 登记回写（installedAt 刷新；登记失败不影响修复结果——来源登记本就允许补录）。
    // oid 同步：重装后本地 HEAD 即远端 HEAD，取站点 API 的远端 sha 回写，避免远端状态列
    // 因登记 oid 停留旧值而假阳性「有新版本」（取不到 → 置空，降级为「无法比较」而非说谎）。
    let oid = '';
    try {
        const head = await fetchRemoteHead(url, { branch: branch || '' });
        oid = head.ok ? head.sha : '';
    } catch { /* oid 同步失败不影响修复 */ }
    await accounts.recordInstall(name, { url, branch: branch || '', target, oid }).catch(() => { });
    log('重建修复完成，刷新页面后生效');
    return { name, mode: 'rebuild', backedUp, oid };
}
