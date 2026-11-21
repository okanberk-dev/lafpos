// Arşiv okuyup yazan küçük yardımcılar (bağımlılıksız): güncelleme paketi (.zip) derlemede yazılır (derle.mjs), kafedeki
// bekçi onu açar (guncelle.mjs); Node'un Windows zip'inden node.exe ve better-sqlite3'ün .tar.gz'sinden yerel modül de
// bununla çıkar. Harici araç (tar.exe, unzip) gerekmez: her bilgisayarda aynı kod çalışır, testi tests/guncelleme.test.ts.
// Zip: yalnız depolanmış (0) ve deflate (8) kayıtlar; ZIP64 alanları okunur, yazılmaz (paket birkaç MB). Açarken
// klasör dışına çıkan ad (.., mutlak yol, sürücü harfi) reddedilir.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zip'in sağlaması); Node 22.2'den beri zlib.crc32 */
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip'e girecek adın biçimi: düz bölü, göreli, klasör dışına çıkmaz */
export function safeName(name) {
  const n = String(name);
  if (!n || n.includes('\\') || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return n;
}

/**
 * Dosyalardan zip. Saat sabit (1980-01-01): aynı dosyalar aynı zip'i verir
 * @param {{ name: string, data: Buffer }[]} entries
 */
export function zipFiles(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = safeName(e.name);
    if (!name) throw new Error(`Zip'e girmeyecek ad: ${e.name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + body.length;
    if (offset > 0xfffffff0) throw new Error('Zip 4 GB sınırını aşıyor');
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

/** Klasördeki dosyalar (alt klasörlerle, ada göre sıralı) zip kaydı olarak; `prefix` her adın önüne */
export function filesOf(dir, prefix = '') {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ name: `${prefix}${relative(dir, p).split(sep).join('/')}`, data: readFileSync(p) });
    }
  };
  walk(dir);
  return out;
}

/** Zip'in kayıtları (merkez dizinden; ZIP64 boyutları ve konumu okunur) */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Zip dosyası değil (son kayıt yok)');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64: kayıt sayısı ya da konum sığmadıysa ZIP64 son kaydında
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 12));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('Zip64 son kaydı bozuk');
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip merkez dizini bozuk');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    // ZIP64 ek alanı: yalnız 0xFFFFFFFF olan değerler, bu sırayla
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    entries.push({ name, method, crc, csize, usize, local, dir: name.endsWith('/') });
    p = xEnd + commentLen;
  }
  return entries;
}

/** Bir kaydın içeriği (sağlama ve boy denetlenir) */
export function entryData(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`Zip kaydı bozuk: ${e.name}`);
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`Zip'te desteklenmeyen sıkıştırma (${e.method}): ${e.name}`);
  if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`Zip kaydının sağlaması tutmadı: ${e.name}`);
  return data;
}

/**
 * Zip'i klasöre açar. `map` kaydın adını hedefteki göreli yola çevirir (null: atla); klasör dışına çıkan ad hata
 * @returns {string[]} yazılan dosyaların göreli yolları
 */
export function extractZip(buf, dest, map = (name) => name) {
  const root = resolve(dest);
  const written = [];
  for (const e of readZip(buf)) {
    if (e.dir) continue;
    if (!safeName(e.name)) throw new Error(`Zip'te güvensiz ad: ${e.name}`);
    const rel = map(e.name);
    if (rel == null) continue;
    if (!safeName(rel)) throw new Error(`Güvensiz hedef: ${rel}`);
    const out = resolve(root, ...rel.split('/'));
    if (out !== root && !out.startsWith(root + sep)) throw new Error(`Zip'te güvensiz ad: ${e.name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entryData(buf, e));
    written.push(rel);
  }
  return written;
}

/** .tar.gz'deki dosyalar (ustar; yalnız düz dosyalar) */
export function readTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = [];
  let p = 0;
  while (p + 512 <= tar.length) {
    const head = tar.subarray(p, p + 512);
    if (head.every((b) => b === 0)) break;
    const str = (a, b) => head.toString('utf8', a, b).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    const prefix = head.toString('utf8', 257, 262) === 'ustar' ? str(345, 500) : '';
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    if (type === '0' || type === '\0') out.push({ name: name.replace(/^\.\//, ''), data: Buffer.from(tar.subarray(p + 512, p + 512 + size)) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
