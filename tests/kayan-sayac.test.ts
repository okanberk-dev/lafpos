import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tl, tlPlain, tlShort } from '@shared/money';
import { cellsText, toCells } from '../src/components/ui/rollingDigits';

/**
 * Kayan rakamlı sayaç (src/components/ui/AnimatedCounter.tsx): yazı LafPOS'un kendi biçimleyicisinden gelir, sayaç yalnız
 * basamakları döndürür. Burada ekrana çizilen hücrelerin biçimleyicinin yazısıyla birebir aynı olduğu ve basamak
 * anahtarlarının değer değişince yerinde kaldığı denetlenir
 */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fmtN = (n: number) => n.toLocaleString('tr-TR');
const digitKeys = (text: string) => toCells(text).flatMap((c) => (c.kind === 'digit' ? [c.key] : []));

const KURUS = [0, 1, 5, 50, 99, 100, 150, 8500, 8550, 12345, 99_900, 100_000, 123_450, 999_999, 1_000_000, 35_700, 1_245_050, 100_000_000, 123_456_789, -1, -12_345, -100_000];

describe('kayan sayaç: yazı biçimleyicinin aynısı', () => {
  it('tl, tlShort, tlPlain: hücreler yan yana biçimleyicinin yazısını verir', () => {
    for (const k of KURUS) {
      for (const f of [tl, tlShort, tlPlain]) expect(cellsText(toCells(f(k))), `${f.name}(${k})`).toBe(f(k));
    }
  });
  it('sayılar (adisyon, fiş sayısı): binlik nokta dahil aynı', () => {
    for (const n of [0, 7, 999, 1000, 12_500, 1_234_567]) expect(cellsText(toCells(fmtN(n)))).toBe(fmtN(n));
  });
  it('örnekler: ₺ başta, binlik nokta, kuruş virgülle', () => {
    expect(cellsText(toCells(tl(123450)))).toBe('₺1.234,50');
    expect(cellsText(toCells(tlShort(8500)))).toBe('₺85');
    expect(cellsText(toCells(tl(-12345)))).toBe('-₺123,45');
  });
  it('kuruş hücreleri ayrı işaretlidir (ekranda soluk yazılır), lira hücreleri değil', () => {
    const cells = toCells(tl(123450));
    expect(cells.filter((c) => c.frac).map((c) => (c.kind === 'digit' ? String(c.digit) : c.char)).join('')).toBe(',50');
    expect(cells.filter((c) => !c.frac).map((c) => (c.kind === 'digit' ? String(c.digit) : c.char)).join('')).toBe('₺1.234');
    expect(toCells(fmtN(1234)).some((c) => c.frac)).toBe(false);
  });
});

describe('kayan sayaç: basamaklar yerinde döner', () => {
  it('anahtarlar tekil', () => {
    for (const k of KURUS) {
      const keys = toCells(tl(k)).map((c) => c.key);
      expect(new Set(keys).size, tl(k)).toBe(keys.length);
    }
  });
  it('basamak liranın basamak değeriyle anahtarlanır: ₺999 → ₺1.000 eski sütunları yerinde bırakır', () => {
    expect(digitKeys(tl(99_900))).toEqual(['i3', 'i2', 'i1', 'f0', 'f1']);
    expect(digitKeys(tl(100_000))).toEqual(['i4', 'i3', 'i2', 'i1', 'f0', 'f1']);
    // Binlik nokta da ardından gelen basamağın yerine bağlı: ₺1.000 ile ₺12.000'in noktası aynı hücre
    const sep = (k: number) => toCells(tl(k)).find((c) => c.kind === 'mark' && c.char === '.')?.key;
    expect(sep(100_000)).toBe(sep(1_200_000));
  });
  it('kısa tutarda kuruş gelip gidince liranın basamakları kaymaz (₺85 → ₺85,50)', () => {
    expect(digitKeys(tlShort(8500))).toEqual(['i2', 'i1']);
    expect(digitKeys(tlShort(8550))).toEqual(['i2', 'i1', 'f0', 'f1']);
  });
  it('eksiye geçince ₺ aynı hücre kalır', () => {
    const lira = (k: number) => toCells(tl(k)).find((c) => c.kind === 'mark' && c.char === '₺')?.key;
    expect(lira(-12_345)).toBe(lira(12_345));
  });
});

describe('kayan sayaç: ekranlarda ve erişilebilirlikte', () => {
  const counter = read('src/components/ui/AnimatedCounter.tsx');
  it('ekran okuyucu yalnız son değeri okur; dönen çark gizli', () => {
    expect(counter).toMatch(/className="sr-only"/);
    expect(counter).toMatch(/<span aria-hidden="true" className="inline-flex/);
  });
  it('çark yalnız dönerken çizilir: dururken pencerede tek rakam (sayfa metninde ve düğme taramasında gizli 0-9 yok)', () => {
    expect(counter).toMatch(/\{moving && \(/);
    expect(counter).not.toMatch(/SIZER/);
  });
  it('hareket azaltmada çark dönmez, ilk boyamada da dönmez', () => {
    expect(counter).toMatch(/useReducedMotion\(\)/);
    expect(counter).toMatch(/AnimatePresence mode="popLayout" initial=\{false\}/);
  });
  it('yazıyı ekranın biçimleyicisi verir: sayaç kendi biçimini yazmaz', () => {
    expect(counter).toMatch(/format\(value\)/);
    expect(counter).not.toMatch(/Intl\.NumberFormat|toLocaleString/);
  });
  it('değişen rakamlar kayan sayaçla: patron paneli (Uzaktan da) ve raporların özet kartları', () => {
    expect(read('src/pages/patron/KeelPanel.tsx')).toMatch(/<AnimatedCounter /);
    expect(read('src/pages/patron/PatronPage.tsx')).toMatch(/<AnimatedCounter /);
    expect(read('src/pages/reports/ReportsPage.tsx')).toMatch(/<AnimatedCounter /);
  });
  it('kasa ekranları (satış, ödeme, kasa) sayaç almaz: kasa hızı ve kör kasa değişmez', () => {
    for (const p of ['src/pages/order/CartPanel.tsx', 'src/pages/order/PaymentModal.tsx', 'src/pages/cash/CashPage.tsx', 'src/pages/cash/ZView.tsx', 'src/pages/cash/CashCount.tsx']) {
      expect(read(p), p).not.toMatch(/AnimatedCounter/);
    }
  });
});
