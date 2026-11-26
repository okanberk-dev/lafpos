import { tl } from './money';
import type { PublicSettings } from './types';

/**
 * Ödeme penceresinin iki kararı (saf, testli): "Ödemeyi al" bu ödemeyi yazarkasaya mı yollar, ödemeden sonra fiş
 * yazıcısından ne çıkar. Ayrıntı: docs/04-YAZARKASA.md §4.1.
 */

export type PayMode = 'tutar' | 'kalem' | 'paylas';
type Provider = 'kapali' | 'tokenx' | 'tokenkablo' | 'pavo' | 'simulator';

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
  /** Adisyona hiç ödeme alınmamış (`order.paid === 0`): bölünmüş hesabın bütünü cihaza gidebilir */
  nothingPaid?: boolean;
  /**
   * Seçilen yemek kartı cihaza gidebilir mi (`boot.integrations.okc.mealMethods`'ta): Pavo'da yalnız cihazın ödeme
   * aracına eşlenmiş kart. Verilmezse Pavo'da gitmez, diğerlerinde gider (eski sunucu)
   */
  mealOnDevice?: boolean;
}

/**
 * `on`: otomatik gönderim bu kurulumda açık (kapalıysa ödeme penceresi bugünkü gibi çalışır). `send`: bu ödeme cihaza
 * gider. Gitmiyorsa `reason` kasiyere bir cümleyle neden LafPOS'a yazılacağını söyler.
 */
export function deviceRoute(i: DeviceRouteInput): { on: boolean; send: boolean; reason: string | null; block?: true } {
  const on = i.provider !== 'kapali' && i.mode === 'anlik' && i.auto && i.canSend;
  if (!on) return { on, send: false, reason: null };
  if (!i.methodKind) return { on, send: false, reason: null };
  // Pavo'nun belgelediği ödeme tipleri yalnız nakit ve kart (docs/04-YAZARKASA.md §8.3); yemek kartı yalnız cihazın
  // ödeme aracına eşlenmişse (§8.6)
  const meal = i.mealOnDevice ?? i.provider !== 'pavo';
  const kinds = meal ? ['nakit', 'kart', 'yemek'] : ['nakit', 'kart'];
  if (i.methodKind === 'yemek' && !meal && i.provider === 'pavo') return { on, send: false, reason: 'Bu yemek kartı cihazın ödeme aracına eşlenmedi, LafPOS’a yazılır (Yönetim › Yazarkasa POS)' };
  const no = (reason: string) => ({ on, send: false, reason });
  if (!kinds.includes(i.methodKind)) return no('Bu ödeme türü yazarkasaya gitmez, LafPOS’a yazılır');
  // Hiç pay alınmamış bölünmüş hesap cihaza bütün olarak gider (Yazarkasa bölümü: cihazda N ayrı ödeme, tek fiş)
  if (i.payMode === 'paylas' || i.splitActive) return no(i.nothingPaid ? 'Paylaşımlı hesap: aşağıdaki Yazarkasa bölümünden bütün hesabı cihaza gönderin' : 'Paylaşımlı hesapta pay LafPOS’a yazılır');
  // Bahşişli ödeme cihaza gitmez; hesabın tamamı sessizce LafPOS'a yazılmasın (kart çekilmez, fiş kesilmez): ödeme
  // düğmesi kapanır, hesap bahşişsiz cihazdan alınır
  if (i.tip > 0) return { on, send: false, reason: 'Bahşişi ayrı alın: önce hesabı bahşişsiz cihazdan alın', block: true };
  if (i.payMode === 'kalem') return i.pickedCount > 0 ? { on, send: true, reason: null } : { on, send: false, reason: null };
  if (i.amountPaidHere) return no('Adisyonda LafPOS’ta alınmış ödeme var: kalan LafPOS’a yazılır ya da kalemleri seçin');
  if (i.amount < i.remaining) return no('Kısmi tutar yazarkasaya gitmez, LafPOS’a yazılır; tamamı ya da kalem seçerek cihaza gider');
  return { on, send: true, reason: null };
}

/**
 * Ödeme penceresindeki Yazarkasa bölümü kendiliğinden gönderim kipinde mi (yalnız bilgi metni) yoksa elle "Hesabı
 * yazarkasaya gönder" düğmesini mi gösterir: hiç pay alınmamış, birden çok kişiye bölünmüş hesap elle cihaza gider
 */
export function okcPanelAuto(routeOn: boolean, split: { shares: unknown[] } | null | undefined, orderPaid: number): boolean {
  return routeOn && !(!!split && orderPaid === 0 && split.shares.length > 1);
}

/**
 * Otomatik gönderim açıkken cihaza gitmeyen nakit, kart ya da yemek ödemesi: düğme bunu söyler, kart ve yemekte onay
 * sorulur (para bu cihazdan alınmaz). Gönderim kapalıysa ya da tür zaten cihaz dışıysa (havale, açık hesap) null
 */
export function offDeviceLabel(route: { on: boolean; send: boolean }, method: { kind: string; name: string } | null, total: number): { label: string; confirm: boolean } | null {
  if (!route.on || route.send || !method) return null;
  if (method.kind === 'nakit') return { label: `${tl(total)} ${method.name}: LafPOS’a yaz (fiş ayrıca)`, confirm: false };
  if (method.kind === 'kart' || method.kind === 'yemek') return { label: `${tl(total)} ${method.name}: cihazsız kaydet`, confirm: true };
  return null;
}

/** Cihazın yazdığı ödeme (okc.paid olayında): tür, ad ve tutar */
export interface DevicePaid {
  kind: string;
  name: string;
  amount: number;
}

/**
 * Cihaz ödemesinin sonuç ekranı: para üstü cihazın gerçek ödemelerinden çıkar, LafPOS'taki seçimden değil (kasiyer
 * Nakit 500 seçip müşteri kartla öderse para üstü yoktur). Yalnız bütün ödeme nakit, toplamı gönderilen tutara eşit
 * ve verilen yeterliyse verilen − tutar. Cihazın ödemeleri bilinmiyorsa (eski sunucu) `change` null: ekran para üstünü
 * cihazın fişinden vermeyi söyler
 */
export function deviceResult(sent: { amount: number; given: number | null; methodName: string }, paid: DevicePaid[] | undefined): { change: number | null; method: string } {
  if (!paid) return { change: sent.given != null ? null : 0, method: sent.methodName };
  if (!paid.length) return { change: 0, method: sent.methodName };
  const method = paid.length === 1 ? paid[0].name : paid.map((p) => `${tl(p.amount)} ${p.name}`).join(' + ');
  const sum = paid.reduce((a, p) => a + p.amount, 0);
  const cash = paid.every((p) => p.kind === 'nakit');
  const change = cash && sum === sent.amount && sent.given != null && sent.given >= sent.amount ? sent.given - sent.amount : 0;
  return { change, method };
}

/** Kasa ekranı: kasa bilgisayarında kiosk Chrome (`--kiosk-printing`) sunucuya kendi üstünden bağlanır */
export function isKasaHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Ödemeden sonra kendiliğinden basılacaklar. Yalnız kasa ekranında ve fiş yazıcısı bulunmuşken (yoksa sessizce atlanır),
 * her kâğıt kendi ayarıyla (ikisi de varsayılan açık): müşteri nüshası (sipariş no büyük, kalemler, "mali değeri
 * yoktur") ve işyeri nüshası (bar ve hazırlık için kalemli kâğıt). Ödeme LafPOS'ta da alınsa cihazda da aynı
 */
export function afterPaymentPrints(i: {
  settings: Pick<PublicSettings, 'receiptStoreCopy' | 'receiptInfoSlip'>;
  printer: boolean;
  kasaScreen: boolean;
}): { storeCopy: boolean; infoSlip: boolean } {
  if (!i.printer || !i.kasaScreen) return { storeCopy: false, infoSlip: false };
  // Müşteri nüshası yazarkasa bağlıyken de (saha, 22 Kas 2026: sipariş numarası çağrı için; "mali değeri yoktur" yazar)
  return { storeCopy: !!i.settings.receiptStoreCopy, infoSlip: !!i.settings.receiptInfoSlip };
}

/**
 * Bir ödemenin kâğıtları basılış sırasıyla, her biri ayrı yazdırma işi (yazıcı her birinin sonunda keser): önce müşteri
 * nüshası, sonra işyeri nüshası; yalnız ayarı açık olanlar. Ekran cihaz ödemesinin nüshasını, buradan en az bir kâğıt
 * çıkıyorsa sunucudan alır (sunucu da aynı kuralla bekletir: server/okc/store-copy.ts). Eskiden yalnız işyeri nüshasına
 * bakılıyordu: o kapalıyken cihaz ödemesinin müşteri nüshası hiç basılmıyordu (inceleme, 23 Kas 2026)
 */
export function afterPaymentParts(plan: { storeCopy: boolean; infoSlip: boolean }): ('musteri' | 'isyeri')[] {
  return [...(plan.infoSlip ? (['musteri'] as const) : []), ...(plan.storeCopy ? (['isyeri'] as const) : [])];
}

/**
 * Pavo'nun banka gün sonu kâğıdını (Z ve Pavo - LafPOS kıyası) bu ekran basar mı: kasa ekranı, fiş yazıcısı ve Pavo
 * bağlantısı. Kendi ayarını (Yönetim › Yazarkasa POS › "Gün sonu kâğıdı fiş yazıcısından da çıksın") sunucu denetler
 * (`takeEodSlip`). Ödeme sonrası nüsha ayarlarına bağlı değil: eskiden işyeri nüshası kapalıyken gün sonu kâğıdı da hiç
 * çıkmıyordu (inceleme, 23 Kas 2026)
 */
export function bankEodSlipHere(i: { printer: boolean; kasaScreen: boolean; provider: Provider }): boolean {
  return i.printer && i.kasaScreen && i.provider === 'pavo';
}

/** Her ödeme için tam bir kez: aynı anahtar (cihaz fişi ya da ödeme kimliği) ikinci kez basılmaz */
export function printOnce(seen: Set<string> = new Set()) {
  return (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
