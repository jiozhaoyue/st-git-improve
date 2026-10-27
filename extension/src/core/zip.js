// Store-only ZIP writer（无压缩、零依赖）。
// 用途：把浏览器内存中的仓库文件打包成 .zip，供宿主原生「归档安装」通道上传，
// 或供「导出为本地 zip」功能下载。严格实现 PKZIP APPNOTE 的 local header +
// central directory + EOCD 结构，method=0（stored），UTF-8 文件名位（bit 11）。

/** CRC-32（IEEE 802.3，ZIP 规范多项式 0xEDB88320）。 */
export function crc32(data) {
    const table = crc32._table || (crc32._table = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            t[n] = c;
        }
        return t;
    })());
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/** DOS 时间（本地时间，2 秒粒度）。 */
function dosDateTime(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { dosDate, dosTime };
}

function utf8Bytes(str) {
    return new TextEncoder().encode(str);
}

function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/**
 * 构建一个 store-only ZIP。
 * @param {Array<{ path: string, data: Uint8Array, date?: Date }>} entries
 *        path 使用正斜杠分隔，不以 / 开头。
 * @returns {Uint8Array} 完整的 zip 字节流
 */
export function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let count = 0;

    for (const entry of entries) {
        const name = String(entry.path).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!name) throw new Error('zip 条目缺少路径');
        const data = entry.data instanceof Uint8Array ? entry.data : utf8Bytes(String(entry.data));
        if (data.length > 0xFFFFFFFF) throw new Error(`条目过大: ${name}`);
        const { dosDate, dosTime } = dosDateTime(entry.date);
        const crc = crc32(data);
        const nameBytes = utf8Bytes(name);
        const flags = 0x0800; // bit 11: UTF-8 文件名

        const local = new Uint8Array(30 + nameBytes.length);
        local.set([0x50, 0x4b, 0x03, 0x04], 0); // PK\x03\x04
        local.set(u16(20), 4);       // version needed
        local.set(u16(flags), 6);
        local.set(u16(0), 8);        // method: stored
        local.set(u16(dosTime), 10);
        local.set(u16(dosDate), 12);
        local.set(u32(crc), 14);
        local.set(u32(data.length), 18); // compressed
        local.set(u32(data.length), 22); // uncompressed
        local.set(u16(nameBytes.length), 26);
        local.set(u16(0), 28);       // extra length
        local.set(nameBytes, 30);
        localParts.push(local, data);

        const central = new Uint8Array(46 + nameBytes.length);
        central.set([0x50, 0x4b, 0x01, 0x02], 0); // PK\x01\x02
        central.set(u16(20), 4);     // version made by
        central.set(u16(20), 6);     // version needed
        central.set(u16(flags), 8);
        central.set(u16(0), 10);     // method
        central.set(u16(dosTime), 12);
        central.set(u16(dosDate), 14);
        central.set(u32(crc), 16);
        central.set(u32(data.length), 20);
        central.set(u32(data.length), 24);
        central.set(u16(nameBytes.length), 28);
        central.set(u16(0), 30);     // extra
        central.set(u16(0), 32);     // comment
        central.set(u16(0), 34);     // disk number
        central.set(u16(0), 36);     // internal attrs
        central.set(u32(0), 38);     // external attrs
        central.set(u32(offset), 42); // local header offset
        central.set(nameBytes, 46);
        centralParts.push(central);

        offset += local.length + data.length;
        count += 1;
    }

    const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
    const eocd = new Uint8Array(22);
    eocd.set([0x50, 0x4b, 0x05, 0x06], 0); // PK\x05\x06
    eocd.set(u16(0), 4);           // disk number
    eocd.set(u16(0), 6);           // central dir disk
    eocd.set(u16(count), 8);
    eocd.set(u16(count), 10);
    eocd.set(u32(centralSize), 12);
    eocd.set(u32(offset), 16);     // central dir offset
    eocd.set(u16(0), 20);          // comment length

    return concat([...localParts, ...centralParts, eocd]);
}

/**
 * 解析 zip 的 central directory（校验用，支持 store 条目）。
 * @returns {Array<{ path: string, size: number, crc32: number, method: number, data: Uint8Array }>}
 */
export function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 从尾部找 EOCD 签名（0x06054b50），允许最长 65535 的注释。
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('EOCD 未找到，不是有效的 zip');
    const count = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('central directory 签名不匹配');
        const method = view.getUint16(ptr + 10, true);
        const crc = view.getUint32(ptr + 16, true);
        const size = view.getUint32(ptr + 24, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localOffset = view.getUint32(ptr + 42, true);
        const path = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
        // local header 里取数据（store 方法时数据紧跟 local header 之后）
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = bytes.subarray(dataStart, dataStart + size);
        if (method === 0 && crc32(data) !== crc) {
            throw new Error(`CRC 校验失败: ${path}`);
        }
        entries.push({ path, size, crc32: crc, method, data });
        ptr += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
