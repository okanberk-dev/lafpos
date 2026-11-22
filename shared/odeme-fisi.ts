import type { PublicSettings } from './types';

/**
 * Ödeme penceresinin iki kararı (saf, testli): "Ödemeyi al" bu ödemeyi yazarkasaya mı yollar, ödemeden sonra fiş
 * yazıcısından ne çıkar. Ayrıntı: docs/04-YAZARKASA.md §4.1.
 */

export type PayMode = 'tutar' | 'kalem' | 'paylas';
type Provider = 'kapali' | 'tokenx' | 'pavo' | 'simulator';

export interface DeviceRouteInput {
  provider: Provider;
  mode: 'anlik' | 'liste';
  /** Yönetim › Yazarkasa POS › "Ödemeyi alınca cihaza gönder" */
  auto: boolean;
  /** Kullanıcının cihaza sepet gönderme yetkisi (`odeme.al`) */
  canSend: boolean;
  methodKind: 'nakit' | 'kart' | 'yemek' | 'havale' | 'cari' | 'online' | 'diger' | null;
  tip: number;
  payMode: PayMode;
  /** Hesap kişilere bölünmüş ve ödenmemiş pay var */
  splitActive: boolean;
  amount: number;
  remaining: number;
  pickedCount: number;
  /** Adisyonda LafPOS'ta tutar olarak alınmış (cihazdan gelmemiş) ödeme var: hesabın bütünü cihaza gidemez */
  amountPaidHere: boolean;
}

/**
 * `on`: otomatik gönderim bu kurulumda açık (kapalıysa ödeme penceresi bugünkü gibi çalışır). `send`: bu ödeme cihaza
 * gider. Gitmiyorsa `reason` kasiyere bir cümleyle neden LafPOS'a yazılacağını söyler.
 */
export function deviceRoute(i: DeviceRouteInput): { on: boolean; send: boolean; reason: string | null } {
  const on = i.provider !== 'kapali' && i.mode === 'anlik' && i.auto && i.canSend;
  if (!on) return { on, send: false, reason: null };
  if (!i.methodKind) return { on, send: false, reason: null };
  // Pavo'nun belgelediği ödeme tipleri yalnız nakit ve kart (docs/04-YAZARKASA.md §8.3)
  const kinds = i.provider === 'pavo' ? ['nakit', 'kart'] : ['nakit', 'kart', 'yemek'];
  const no = (reason: string) => ({ on, send: false, reason });
  if (!kinds.includes(i.methodKind)) return no('Bu ödeme türü yazarkasaya gitmez, LafPOS’a yazılır');
  if (i.payMode === 'paylas' || i.splitActive) return no('Paylaşımlı hesapta pay LafPOS’a yazılır');
  if (i.tip > 0) return no('Bahşişli ödeme yazarkasaya gitmez, LafPOS’a yazılır');
  if (i.payMode === 'kalem') return i.pickedCount > 0 ? { on, send: true, reason: null } : { on, send: false, reason: null };
  if (i.amountPaidHere) return no('Adisyonda LafPOS’ta alınmış ödeme var: kalan LafPOS’a yazılır ya da kalemleri seçin');
  if (i.amount < i.remaining) return no('Kısmi tutar yazarkasaya gitmez, LafPOS’a yazılır; tamamı ya da kalem seçerek cihaza gider');
  return { on, send: true, reason: null };
}

/** Kasa ekranı: kasa bilgisayarında kiosk Chrome (`--kiosk-printing`) sunucuya kendi üstünden bağlanır */
export function isKasaHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Ödemeden sonra kendiliğinden basılacaklar. Yalnız kasa ekranında ve fiş yazıcısı bulunmuşken (yoksa sessizce atlanır):
 * kısa işyeri nüshası (ayar, varsayılan açık) ve yazarkasasız kurulumda müşteriye bilgi fişi (ayar, varsayılan kapalı;
 * yazarkasa bağlıyken müşterinin fişini cihaz basar)
 */
export function afterPaymentPrints(i: {
  settings: Pick<PublicSettings, 'receiptStoreCopy' | 'receiptInfoSlip'>;
  printer: boolean;
  kasaScreen: boolean;
  provider: Provider;
  viaDevice: boolean;
}): { storeCopy: boolean; infoSlip: boolean } {
  if (!i.printer || !i.kasaScreen) return { storeCopy: false, infoSlip: false };
  return { storeCopy: !!i.settings.receiptStoreCopy, infoSlip: !!i.settings.receiptInfoSlip && i.provider === 'kapali' && !i.viaDevice };
}

/** Her ödeme için tam bir kez: aynı anahtar (cihaz fişi ya da ödeme kimliği) ikinci kez basılmaz */
export function printOnce(seen: Set<string> = new Set()) {
  return (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
