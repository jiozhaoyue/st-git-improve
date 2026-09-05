import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalize a repository URL into a cloneable form: strip web UI paths
 * (tree/blob/commit/...), query and fragment. Semantics mirror the host's
 * extensions endpoint (Luker src/endpoints/extensions.js:50-65).
 * @param {string} url
 * @returns {string}
 */
export function normalizeRepoUrl(url) {
    const raw = String(url || '').trim();
    const parsed = new URL(raw);
    const normalized = new URL(parsed.toString());
    normalized.search = '';
    normalized.hash = '';

    const segments = normalized.pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex(segment =>
        ['-', 'tree', 'blob', 'commit', 'commits', 'src', 'releases', 'tags', 'branches', 'compare', 'merge_requests'].includes(segment));
    const keepSegments = markerIndex >= 0 ? segments.slice(0, markerIndex) : segments;
    normalized.pathname = `/${keepSegments.join('/')}`.replace(/\/{2,}/g, '/');
    normalized.pathname = normalized.pathname.replace(/\/+$/, '');

    return normalized.toString();
}

/**
 * Derive the install directory name from a repository URL (last path segment,
 * .git suffix stripped). Mirrors native behavior.
 * @param {string} url
 * @returns {string}
 */
export function dirNameFromUrl(url) {
    const raw = String(url || '').trim();
    try {
        const parsed = new URL(raw);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const last = segments.at(-1) || '';
        return sanitizeDirName(last.replace(/\.git$/i, ''));
    } catch {
        return sanitizeDirName(path.basename(raw, '.git'));
    }
}

/** @param {string} name */
export function sanitizeDirName(name) {
    const cleaned = String(name || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]+/g, '_')
        .trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') {
        return '';
    }
    return cleaned;
}

/**
 * Strip credentials from a URL for storage/log/display. userinfo is replaced,
 * query and hash are dropped entirely.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
    const raw = String(url || '');
    try {
        const parsed = new URL(raw);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return raw.replace(/:\/\/[^@/]+@/g, '://***@');
    }
}

/**
 * Validate a list of relative file paths from a candidate tree.
 * @param {string[]} files
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateTreePaths(files) {
    const issues = [];
    const seen = new Map();
    const nfc = (value) => value.normalize('NFC');

    for (const raw of files) {
        const file = String(raw);
        if (file.includes('\\') || file.includes('\0')) {
            issues.push(`非法路径字符: ${file}`);
            continue;
        }
        const segments = file.split('/');
        if (segments.some(seg => seg === '.' || seg === '..' || seg.length === 0)) {
            issues.push(`非法路径段: ${file}`);
            continue;
        }
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(file)) {
            issues.push(`控制字符: ${file}`);
            continue;
        }
        for (const key of [file, nfc(file), file.toLowerCase()]) {
            const prior = seen.get(key);
            if (prior !== undefined && prior !== file) {
                issues.push(`路径冲突(NFC/大小写): ${prior} 与 ${file}`);
            }
            seen.set(key, file);
        }
    }

    return { ok: issues.length === 0, issues };
}

/** @param {string} file @param {unknown} value */
export function atomicWriteJson(file, value) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 4), 'utf-8');
    fs.renameSync(tmp, file);
}

/** @param {string} file @param {unknown} fallback */
export function readJsonOr(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/**
 * @param {number} [statusCode]
 * @param {string} [message]
 * @returns {Error & { statusCode?: number }}
 */
export function httpError(statusCode, message) {
    const error = new Error(message || 'error');
    // @ts-ignore
    error.statusCode = statusCode;
    return error;
}
