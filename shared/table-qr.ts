/**
 * Masa QR kodu: sitenin kuralının aynısı (laffogato `src/lib/admin/cafe-tables-core.ts`). QR içeriği sitenin masa adresi
 * `https://laffogato.net/masa/<kod>`: uygulama ve web aynı adresi tanır, müşteri okutunca menüyü görür ve uygulamadan bu
 * masaya sipariş verir (docs/03-ENTEGRASYON.md §2.3 "Masa QR"). Kod gizli değildir (masada basılı) ama bir masanınkinden
 * başkası türetilemez: 10 simge = 50 bit. Alfabe Crockford base32 (I, L, O, U yok; basılı karttan yanlış okunmasın).
 * Adres apex'e sabittir: basılı kart sitenin adresi ya da `LAFFOGATO_URL` değişse de çalışır. Kodu LafPOS üretir ve
 * saklar (`tables.qrCode`); site kodu `PUT /api/panel/tables` ile alır (sözleşme), sipariş `tableCode` ile masaya düşer.
 */
export const TABLE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TABLE_CODE_LENGTH = 10;
export const TABLE_URL_BASE = 'https://laffogato.net/masa/';

/** QR'ın içeriği ve kartın altındaki bağlantı */
export function tableQrUrl(code: string): string {
  return `${TABLE_URL_BASE}${code}`;
}

const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * Yeni, yansız kod: 32, 256'yı böler ama alfabe değişirse dağılım sessizce bozulmasın diye adil mod koruması kalır
 * (sitedeki `generateTableCode` ile aynı). Sunucuda ve tarayıcı demosunda `crypto.getRandomValues`.
 */
export function generateTableCode(random: (n: number) => Uint8Array = randomBytes): string {
  const fair = 256 - (256 % TABLE_CODE_ALPHABET.length);
  let out = '';
  while (out.length < TABLE_CODE_LENGTH) {
    for (const byte of random(TABLE_CODE_LENGTH)) {
      if (byte >= fair) continue;
      out += TABLE_CODE_ALPHABET[byte % TABLE_CODE_ALPHABET.length];
      if (out.length === TABLE_CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Yazılan ya da okunan kod aranmadan önce: kırpılır, büyük harf, boşluk ve tire atılır, Crockford'un benzeşenleri
 * katlanır (O → 0, I ve L → 1). Sonra tam on simge ve hepsi alfabeden değilse `null`: aranmaz, geri yazılmaz.
 */
export function normalizeTableCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const folded = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (folded.length !== TABLE_CODE_LENGTH) return null;
  for (const ch of folded) if (!TABLE_CODE_ALPHABET.includes(ch)) return null;
  return folded;
}
