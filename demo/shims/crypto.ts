import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, type CHash, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Tarayıcı demosunda `node:crypto`: sunucunun kullandığı kadarı, eşzamanlı (Web Crypto'nun özetleri eşzamansız
 * olduğu için @noble/hashes). Çıktılar Node'unkiyle aynıdır (tests/demo-runtime.test.ts denetler).
 */
type Encoding = 'hex' | 'base64' | 'base64url';
type HashFn = CHash;

const HASHES: Record<string, HashFn> = { sha256, sha1 };

function hashOf(algo: string): HashFn {
  const fn = HASHES[algo];
  if (!fn) throw new Error(`Demoda desteklenmeyen özet: ${algo}`);
  return fn;
}

function encode(bytes: Uint8Array, enc: Encoding): string {
  if (enc === 'hex') return bytesToHex(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return enc === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Node Buffer'ının `toString(kodlama)`'sı olan bayt dizisi */
class Bytes extends Uint8Array {
  override toString(enc?: Encoding): string {
    return enc ? encode(this, enc) : new TextDecoder().decode(this);
  }
}

class Digest {
  private parts: Uint8Array[] = [];
  constructor(private finish: (data: Uint8Array) => Uint8Array) {}

  update(data: string | Uint8Array, _inputEncoding?: string): this {
    this.parts.push(typeof data === 'string' ? utf8ToBytes(data) : data);
    return this;
  }

  digest(): Bytes;
  digest(enc: Encoding): string;
  digest(enc?: Encoding): Bytes | string {
    const all = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    const out = this.finish(all);
    return enc ? encode(out, enc) : new Bytes(out);
  }
}

export function createHash(algo: string) {
  const fn = hashOf(algo);
  return new Digest((data) => fn(data));
}

export function createHmac(algo: string, key: string | Uint8Array) {
  const fn = hashOf(algo);
  const k = typeof key === 'string' ? utf8ToBytes(key) : key;
  return new Digest((data) => hmac(fn, k, data));
}

export function randomBytes(size: number): Bytes {
  const out = new Bytes(size);
  crypto.getRandomValues(out);
  return out;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export default { createHash, createHmac, randomBytes, randomUUID };
