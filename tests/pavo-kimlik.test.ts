import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FINGERPRINT_RE, LEGACY_FINGERPRINT, newFingerprint, pavoFingerprint, usePavoStore } from '../server/okc/providers/pavo';

/**
 * Pavo kimliği (fingerprint) kuruluma özel ve kalıcı: ilk eşleştirmede üretilir. Geriye uyum: kimliği saklanmadan
 * eşleştirilmiş eski kurulum `LafPOS` ile devam eder (ve bu saklanır); ayarlar dosyasındaki PAVO_FINGERPRINT her şeyden önce
 */

function memoryStore(init: { sequence?: number; cert?: string | null; fp?: string | null } = {}) {
  const m = { sequence: init.sequence ?? 0, cert: init.cert ?? null, fp: init.fp ?? null };
  return {
    m,
    store: {
      getSequence: () => m.sequence,
      setSequence: (n: number) => void (m.sequence = n),
      getCert: () => m.cert,
      setCert: (c: string | null) => void (m.cert = c),
      getFingerprint: () => m.fp,
      setFingerprint: (fp: string) => void (m.fp = fp),
    },
  };
}

describe('Pavo kimliği', () => {
  let env: string | undefined;
  beforeEach(() => {
    env = process.env.PAVO_FINGERPRINT;
    delete process.env.PAVO_FINGERPRINT;
  });
  afterEach(() => {
    if (env === undefined) delete process.env.PAVO_FINGERPRINT;
    else process.env.PAVO_FINGERPRINT = env;
  });

  it('yeni kimlik kısa ve harf-rakam-tire: LafPOS- ve 6 karakter; her kurulumda farklı', () => {
    const a = newFingerprint();
    expect(a).toMatch(/^LafPOS-[A-Z2-9]{6}$/);
    expect(FINGERPRINT_RE.test(a)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(new Set(Array.from({ length: 20 }, () => newFingerprint())).size).toBeGreaterThan(1);
    expect(newFingerprint(() => 0)).toBe('LafPOS-AAAAAA');
  });

  it('geriye uyum: daha önce eşleştirilmiş kurulum LafPOS ile devam eder ve bu saklanır', () => {
    const { m, store } = memoryStore({ sequence: 12 });
    usePavoStore(store);
    expect(pavoFingerprint()).toEqual({ value: LEGACY_FINGERPRINT, source: 'eski' });
    expect(m.fp).toBe('LafPOS');
    // Eşleştirme sonradan sıfırlansa da (cihaz değişti) kimlik aynı kalır
    m.sequence = 0;
    m.cert = null;
    expect(pavoFingerprint()).toEqual({ value: 'LafPOS', source: 'eski' });
    // Yalnız sertifikası saklanmış eski kurulum da eşleştirilmiş sayılır
    const cert = memoryStore({ cert: 'AA:BB' });
    usePavoStore(cert.store);
    expect(pavoFingerprint().value).toBe('LafPOS');
  });

  it('saklanan kimlik kullanılır; hiç eşleştirilmemişse kimlik yok sayılır (ilk eşleştirmede üretilir)', () => {
    const stored = memoryStore({ fp: 'LafPOS-K7Q2XM', sequence: 3 });
    usePavoStore(stored.store);
    expect(pavoFingerprint()).toEqual({ value: 'LafPOS-K7Q2XM', source: 'kurulum' });
    const fresh = memoryStore();
    usePavoStore(fresh.store);
    expect(pavoFingerprint()).toEqual({ value: 'LafPOS', source: 'yok' });
    expect(fresh.m.fp).toBeNull();
  });

  it('ayarlar dosyasındaki PAVO_FINGERPRINT her şeyden önce gelir', () => {
    process.env.PAVO_FINGERPRINT = 'Kasa-1';
    usePavoStore(memoryStore({ fp: 'LafPOS-K7Q2XM' }).store);
    expect(pavoFingerprint()).toEqual({ value: 'Kasa-1', source: 'dosya' });
  });
});
