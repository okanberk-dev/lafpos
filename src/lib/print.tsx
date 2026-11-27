import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { COMP_LABEL } from '@shared/comp';
import { BANKA_KIYAS_BASLIGI } from '@shared/eski-adlar';
import { tlPlain } from '@shared/money';
import { lineGross } from '@shared/order-calc';
import { fmtDateTime } from '@shared/time';
import type { BootstrapDTO, OrderDTO, PublicSettings } from '@shared/types';
import type { ZSummary } from '@shared/types';
import { post } from './api';

/** Sunucunun verdiği banka gün sonu kâğıdı (`server/okc/service.ts` `PavoEodSlip`) */
export interface BankEodSlip {
  batchNo: string;
  deviceDateTime: string | null;
  grandTotalKurus: number | null;
  acquirers: { name: string; count: number | null; totalKurus: number | null }[];
  dayCardKurus: number | null;
  trigger: 'otomatik' | 'elle';
  at: number;
  /** Kapanan günün Z'si (eski sunucuda yok): banka gün sonuyla birlikte basılır */
  z?: { date: string; zNo: number; closedAt: number | null; summary: ZSummary } | null;
}
import { callFor, callText, numaratorLabel, serviceModeOf } from '@shared/service-mode';

/**
 * 80 mm termal yazıcıya çıktı (kasa bilgisayarında kiosk Chrome, XP-80C gibi). Varsayılan yol doğrudan: fiş görüntüye
 * çevrilip sunucudan ağdaki yazıcıya ESC/POS gider, yazdırma penceresi açılmaz (`printNow`). Olmazsa tarayıcıdan: içerik
 * `.print-area`ya çizilir, `window.print()` çağrılır; sayfanın geri kalanı yazdırmada gizlidir. Fişin bütün görünümü index.css'teki
 * `.rc-*` sınıflarındadır: 80 mm kâğıtta 72 mm ortalı yazı alanı, yalnız siyah (gri ve zemin termal kâğıtta noktalı
 * basılır), sistemin eş aralıklı yazısı (yazdırma anında yüklenmesi gereken yazı tipi yok), sütunlu rakam. Tutarlar
 * sunucunun DTO'sundan gelir; burada yeni hesap yok
 */
const usePrint = create<{ content: ReactNode | null; sheet: boolean; set: (c: ReactNode | null, sheet?: boolean) => void }>((set) => ({ content: null, sheet: false, set: (content, sheet = false) => set({ content, sheet }) }));

/** Açılış verisini okumak için (PrintHost kaydeder): doğrudan basma ayarı yazdırma anında okunur */
let queryClient: QueryClient | null = null;
const directEnabled = () => !!queryClient?.getQueryData<BootstrapDTO>(['bootstrap'])?.settings.receiptDirect;

/** Tarayıcı yazdırması: içerik `.print-area`ya çizilir, `window.print()`. `finished`: `afterprint` (en çok 6 sn) */
function browserPrint(content: ReactNode, sheet: boolean): { sent: Promise<void>; finished: Promise<void> } {
  // Kiosk Chrome'da afterprint window.print() içinde gelebilir: dinleyici önce kurulur
  const finished = new Promise<void>((done) => {
    const t = setTimeout(done, 6000);
    window.addEventListener(
      'afterprint',
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });
  usePrint.getState().set(content, sheet);
  // İçerik çizilsin diye bir kare bekle
  const sent = new Promise<void>((done, fail) =>
    requestAnimationFrame(() =>
      setTimeout(() => {
        try {
          window.print();
          done();
        } catch (e) {
          fail(e);
        }
      }, 30),
    ),
  );
  return { sent, finished };
}

/** 80 mm termal yazıcının noktası: 576 nokta = 72 mm (203 dpi); fiş ekranda 72 mm (CSS, `.rc-raster`) çizilip ölçeklenir */
const RASTER_WIDTH = 576;

/** Tuval → 1 bitlik satırlar (en soldaki en yüksek bit, 1 = siyah); saydam beyaz sayılır */
export function packBits(rgba: Uint8ClampedArray, width: number, height: number, threshold = 160): Uint8Array {
  const rowBytes = width / 8;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3]! / 255;
      const lum = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * a + 255 * (1 - a);
      if (lum < threshold) out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return out;
}

const toBase64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Fişi görüntüye çevirip sunucuya yollar (server/lib/escpos.ts: ESC/POS raster ve kesme, yazıcının IP'sine TCP). Fiş
 * bugünkü bileşenle ekran dışında (`.rc-raster`, index.css) çizilir. Sunucu basamazsa reddedilir
 */
async function directPrint(content: ReactNode): Promise<void> {
  const host = document.createElement('div');
  host.className = 'rc-raster';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(content));
    const { toCanvas } = await import('html-to-image');
    const shot = await toCanvas(host, {
      pixelRatio: RASTER_WIDTH / host.offsetWidth,
      backgroundColor: '#fff',
      skipFonts: true,
      // Kopya ekran dışındaki konumunu taşımasın (yoksa görüntü boş çıkar)
      style: { position: 'static', left: '0', top: '0' },
    });
    const height = Math.max(1, Math.round((shot.height * RASTER_WIDTH) / shot.width));
    const canvas = document.createElement('canvas');
    canvas.width = RASTER_WIDTH;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Tuval yok');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, RASTER_WIDTH, height);
    g.drawImage(shot, 0, 0, RASTER_WIDTH, height);
    const bits = packBits(g.getImageData(0, 0, RASTER_WIDTH, height).data, RASTER_WIDTH, height);
    await post('/kasa/fis', { width: RASTER_WIDTH, height, data: toBase64(bits) });
  } finally {
    root.unmount();
    host.remove();
  }
}

/**
 * Doğrudan basmayı dener, olmazsa tarayıcıdan basar (fiş kaybolmaz). A4 sayfa ve ayar kapalıyken hep tarayıcıdan.
 * Saf karar (test: tests/fis-dogrudan.test.ts)
 */
export async function printVia<T>(opts: { sheet: boolean; enabled: boolean; direct: () => Promise<void>; browser: () => T }): Promise<{ how: 'direct' } | { how: 'browser'; result: T }> {
  if (!opts.sheet && opts.enabled) {
    try {
      await opts.direct();
      return { how: 'direct' };
    } catch (e) {
      console.warn('[fiş] doğrudan basılamadı, tarayıcıdan basılıyor', e);
    }
  }
  return { how: 'browser', result: opts.browser() };
}

/** Tek iş: nasıl basıldığı ve (tarayıcıdan basıldıysa) `afterprint`i bekleyen söz */
async function printOne(content: ReactNode, sheet: boolean): Promise<{ how: 'direct' | 'browser'; finished: Promise<void> }> {
  const r = await printVia({ sheet, enabled: directEnabled(), direct: () => directPrint(content), browser: () => browserPrint(content, sheet) });
  if (r.how === 'direct') return { how: 'direct', finished: Promise.resolve() };
  await r.result.sent;
  return { how: 'browser', finished: r.result.finished };
}

/**
 * Yazdırma sırası (saf; test: tests/fis-sirasi.test.ts). Yazdırma alanı (`.print-area`) tek ve `afterprint` olayı bütün
 * pencereye gelir: sırasız iki zincir (bir saniye arayla alınan iki payın nüshaları, nüsha ile gün sonu kâğıdı) üst üste
 * binince biri ötekinin `afterprint`iyle bitmiş sayılıp ikinci kâğıdını ilki basılırken gönderiyor, içerik yazdırma
 * anından önce değişince biri öbürünün fişini, öteki boş kâğıt basıyordu (inceleme, 23 Kas 2026). Her iş bu sıradan
 * geçer: arayan, iş değerini verince (`value`, ör. yazdırma komutu verildi) devam eder; sıradaki iş ise bu işin
 * bitişini (`finished`: doğrudan basmada sunucunun yanıtı, tarayıcıda `afterprint`) ve kısa bir arayı (`gapMs`; kiosk
 * Chrome art arda gelen `window.print()`i yutabiliyor) bekler. Başarısız iş sırayı durdurmaz; bitmeyen iş (yanıtı
 * gelmeyen istek) sırayı en çok `stallMs` tutar
 */
export function printQueue(opts: { gapMs?: number; stallMs?: number } = {}) {
  const gapMs = opts.gapMs ?? 300;
  const stallMs = opts.stallMs ?? 30_000;
  const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  /** İş bitince ya da en çok `ms` sonra (hata da bitiş sayılır) */
  const settled = (p: Promise<unknown>, ms: number) =>
    new Promise<void>((done) => {
      const t = setTimeout(done, ms);
      const end = () => {
        clearTimeout(t);
        done();
      };
      p.then(end, end);
    });
  let tail: Promise<void> = Promise.resolve();
  return function add<T>(job: () => Promise<{ value: T; finished: Promise<void> }>): Promise<T> {
    // İş öncekinin sırası bitince başlar; sıranın yeni sonu bu işin bitişi (ya da süre aşımı) ve ardından ara
    const run = tail.then(job);
    tail = tail.then(() => settled(run.then((r) => r.finished), stallMs)).then(() => wait(gapMs));
    return run.then((r) => r.value);
  };
}

/** Bu sekmenin bütün fiş ve sayfa çıktıları tek sırada (`printQueue`) */
const enqueue = printQueue();

/**
 * Fiş: ayar açıkken (Yönetim › Ayarlar ve yedek › Fiş yazıcısı, varsayılan açık) yazdırma penceresi açılmadan doğrudan
 * ağdaki fiş yazıcısına (`directPrint`); yazıcının adresi yoksa ya da ulaşılamazsa tarayıcıdan. `sheet`: 80 mm fiş değil
 * A4 sayfa (masa kartları; hep tarayıcıdan, index.css `.print-sheet`). Önceki çıktı bitince başlar (`printQueue`). Dönen
 * söz fiş yazıcıya gidince (ya da yazdırma komutu verilince; kiosk Chrome'da `window.print()` fişi yazıcıya gönderip
 * döner) biter. Yazdırılamazsa reddedilir
 */
export function printNow(content: ReactNode, opts: { sheet?: boolean } = {}): Promise<'direct' | 'browser'> {
  return enqueue(async () => {
    const r = await printOne(content, !!opts.sheet);
    return { value: r.how, finished: r.finished };
  });
}

/**
 * Birkaç fişi ayrı işler olarak basar: her biri ayrı kesilir (saha, 22 Kas 2026: iki nüsha böyle ayrı kâğıt çıkıyor).
 * Parçalar sıraya art arda girer, araya başka bir çıktı girmez; her biri öncekinin bitişini bekler (`printQueue`). Söz
 * hepsi bitince (tarayıcıda sonuncusunun `afterprint`i) biter: işyeri nüshasının "basıldı" onayı bundan sonra gider.
 * Biri basılamazsa reddedilir
 */
export async function printEach(parts: ReactNode[]): Promise<void> {
  const done = parts.map((part) =>
    enqueue(async () => {
      const r = await printOne(part, false);
      return { value: r.finished, finished: r.finished };
    }),
  );
  await Promise.all(done);
}

export function PrintHost() {
  const content = usePrint((s) => s.content);
  const sheet = usePrint((s) => s.sheet);
  const qc = useQueryClient();
  useEffect(() => {
    queryClient = qc;
  }, [qc]);
  useEffect(() => {
    const done = () => usePrint.getState().set(null);
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, []);
  if (!content) return null;
  return <div className={sheet ? 'print-area print-sheet hidden print:block' : 'print-area hidden print:block'}>{content}</div>;
}

/** İki sütunlu satır: solda metin (uzunsa alt satıra kayar, kesilmez), sağda tutar (kırılmaz, sağa yaslı) */
const Row = ({ l, r, strong, small }: { l: ReactNode; r?: ReactNode; strong?: boolean; small?: boolean }) => (
  <div className={['rc-row', strong ? 'rc-strong' : '', small ? 'rc-small' : ''].filter(Boolean).join(' ')}>
    <span className="rc-l">{l}</span>
    {r !== undefined && <span className="rc-r">{r}</span>}
  </div>
);
/** Bölüm ayıracı: kesik çizgi */
const Hr = () => <div className="rc-hr" aria-hidden="true" />;

/** Merkez'deki dükkân adı ve şube kodu (Merkez'e bağlı değilse yok): "Şube Marina · MRN" */
const branchLine = (boot: BootstrapDTO) => {
  const b = boot.branch;
  if (!b || (!b.name && !b.code)) return null;
  return `Şube ${[b.name, b.code].filter(Boolean).join(' · ')}`;
};

function Header({ boot, title }: { boot: BootstrapDTO; title: string }) {
  const s = boot.settings;
  const branch = branchLine(boot);
  return (
    <div className="rc-head">
      <div className="rc-name">{s.businessName}</div>
      {s.receiptHeader && <div className="rc-sub rc-pre">{s.receiptHeader}</div>}
      {s.businessAddress && <div className="rc-sub">{s.businessAddress}</div>}
      {s.businessPhone && <div className="rc-sub">Tel {s.businessPhone}</div>}
      {branch && <div className="rc-sub">{branch}</div>}
      <div className="rc-title">{title}</div>
    </div>
  );
}

/** KDV dökümü (fiyatlar KDV dahil; tutarlar sunucunun hesabı) */
const KdvRows = ({ rows }: { rows: { rate: number; base: number; kdv: number }[] }) =>
  rows.length ? (
    <div className="rc-block">
      <Row small l="KDV oranı / matrah" r="KDV" />
      {rows.map((k) => (
        <Row key={k.rate} small l={`%${k.rate} / ${tlPlain(k.base)}`} r={tlPlain(k.kdv)} />
      ))}
    </div>
  ) : null;

/** Fişte müşteri adı yalnız ayar açıkken (Yönetim › Ayarlar › İşletme ve fiş; varsayılan kapalı) ve adisyonda müşteri varsa */
export const receiptCustomerName = (order: Pick<OrderDTO, 'customer'>, settings: Pick<PublicSettings, 'receiptCustomerName'>): string | null =>
  settings.receiptCustomerName && order.customer?.name ? order.customer.name : null;

/**
 * Adisyon (hesap fişi, bilgi fişi). Mali değeri yoktur: mali fiş ÖKC'den (yazarkasa) kesilir. `share`: paylaşımlı
 * hesapta kişinin payı da basılır
 */
export function BillReceipt({ order, boot, sizeLabel, share, copy }: { order: OrderDTO; boot: BootstrapDTO; sizeLabel: (s: string) => string; share?: { no: number; of: number; amount: number }; /** Ödemeden sonra müşteri nüshası: sipariş no en büyük öğe, "mali değeri yoktur" */ copy?: boolean }) {
  const t = order.totals;
  const live = order.items.filter((i) => !i.voided);
  // Self ve yarı self servis: müşterinin numarası ya da masası fişte büyük (numara çağrılınca alır)
  const call = order.tableName ? null : callFor(order, serviceModeOf(boot.settings));
  const place = order.tableName ?? (order.numarator ? numaratorLabel(order.numarator) : order.type === 'tezgah' ? 'Tezgâh' : order.type === 'gelal' ? 'Gel-al' : 'Paket');
  const customer = receiptCustomerName(order, boot.settings);
  const payments = (order.payments ?? []).filter((p) => !p.refundedAt);
  return (
    <div className="rc">
      <Header boot={boot} title={copy ? 'MÜŞTERİ NÜSHASI' : 'ADİSYON'} />
      {copy ? (
        // Müşteri nüshası: çağrı için sipariş numarası kâğıdın en büyük öğesi
        <div className="rc-big">
          <div className="rc-big-label">{order.tableName ? 'MASA' : 'SİPARİŞ NO'}</div>
          <div className="rc-big-no">{order.tableName ?? (call ? callText(call).replace(/^No /, '') : String(order.no))}</div>
        </div>
      ) : (
        call && <div className="rc-call">{callText(call)}</div>
      )}
      <div className="rc-block">
        <Row strong l={place} r={`No ${order.no}`} />
        <Row l="Tarih" r={fmtDateTime(Date.now())} />
        {order.waiterName && <Row l={`Garson ${order.waiterName}`} r={`${order.guests} kişi`} />}
        {customer && <Row l={`Müşteri ${customer}`} />}
      </div>
      <Hr />
      <div className="rc-items">
        {live.map((i) => (
          <div key={i.id} className="rc-item">
            <span className="rc-qty">{i.qty}x</span>
            <span className="rc-item-name">
              {i.name}
              {i.size !== 'TEK' ? ` ${sizeLabel(i.size)}` : ''}
            </span>
            <span className="rc-r">{i.complimentary ? COMP_LABEL[i.compKind ?? 'ikram'].toLocaleUpperCase('tr-TR') : tlPlain(lineGross(i))}</span>
            {i.optionsText && <span className="rc-item-sub">{i.optionsText}</span>}
            {i.note && <span className="rc-item-sub">Not: {i.note}</span>}
            {i.discount > 0 && (
              <>
                <span className="rc-item-sub rc-item-sub-l">İndirim{i.discountReason ? ` (${i.discountReason})` : ''}</span>
                <span className="rc-r">-{tlPlain(i.discount)}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <Hr />
      {t.lineDiscounts + t.orderDiscount > 0 && (
        <>
          <Row l="Ara toplam" r={tlPlain(t.gross)} />
          <Row l={`İndirim${order.discountReason ? ` (${order.discountReason})` : ''}`} r={`-${tlPlain(t.lineDiscounts + t.orderDiscount)}`} />
        </>
      )}
      {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tlPlain(t.service)} />}
      <div className="rc-total">
        <span>TOPLAM</span>
        <span className="rc-r">{tlPlain(t.total)} TL</span>
      </div>
      {payments.length > 0 && (
        <div className="rc-block">
          {payments.map((p) => (
            <Row key={p.id} l={p.methodName} r={tlPlain(p.amount)} />
          ))}
        </div>
      )}
      {order.paid > 0 && order.paid < order.total && (
        <>
          <Row l="Ödenen" r={tlPlain(order.paid)} />
          <Row strong l="Kalan" r={`${tlPlain(order.total - order.paid)} TL`} />
        </>
      )}
      {share && (
        <>
          <Hr />
          <Row strong l={`PAYINIZ (${share.no}/${share.of})`} r={`${tlPlain(share.amount)} TL`} />
          <div className="rc-small">Hesap {share.of} kişiye eşit bölündü</div>
        </>
      )}
      <Hr />
      <KdvRows rows={t.kdv} />
      <div className="rc-foot">
        <div className="rc-strong">BİLGİ FİŞİDİR · MALİ DEĞERİ YOKTUR</div>
        {boot.settings.receiptFooter && <div className="rc-pre rc-foot-note">{boot.settings.receiptFooter}</div>}
      </div>
    </div>
  );
}

/**
 * İşyeri nüshası: ödemeden sonra fiş yazıcısından çıkan, kasada ve barda kalan kâğıt (bar ve hazırlık için kalem
 * dökümü, indirim ve servisle adisyon toplamı, ödemeler). Müşterinin kâğıdı ayrı: müşteri nüshası (`BillReceipt`
 * `copy`), mali fiş yazarkasadan. `device`: yazarkasanın fiş ve Z no'su (cihazdan geldiyse)
 */
export function StoreCopyReceipt({
  order,
  boot,
  payments,
  device,
  cashier,
  at = Date.now(),
  comp,
}: {
  order: OrderDTO;
  boot: BootstrapDTO;
  payments: Pick<OrderDTO['payments'][number], 'id' | 'methodName' | 'amount' | 'tip'>[];
  device?: { receiptNo: number | null; zNo: number | null; docId?: string | null; docLabel?: string | null } | null;
  cashier: string | null;
  at?: number;
  /** Ciro dışı kapanış (ikram, ödenmez, zayi): "ALINAN" yerine türü yazılır */
  comp?: string | null;
}) {
  const t = order.totals;
  const place = order.tableName ?? (order.numarator ? numaratorLabel(order.numarator) : order.type === 'tezgah' ? 'Tezgâh' : order.type === 'gelal' ? 'Gel-al' : 'Paket');
  const branch = branchLine(boot);
  const paid = payments.reduce((a, p) => a + p.amount + p.tip, 0);
  return (
    <div className="rc">
      <div className="rc-head">
        <div className="rc-name">{boot.settings.businessName}</div>
        {branch && <div className="rc-sub">{branch}</div>}
        <div className="rc-title">İŞYERİ NÜSHASI</div>
      </div>
      <div className="rc-block">
        <Row strong l={place} r={`No ${order.no}`} />
        <Row l="Tarih" r={fmtDateTime(at)} />
        {cashier && <Row l={`Kasiyer ${cashier}`} />}
      </div>
      <Hr />
      {/* Bar ve hazırlık için kalem dökümü (seçenekler girintili). Kalemden adisyon toplamına adisyondaki gibi
          (`BillReceipt`): ikram edilen kalemde tutar yerine türü (toplam onu saymaz), indirimli kalemin altında indirimi,
          toplamdan önce ara toplam, indirim ve servis. Eskiden ikram liste fiyatıyla basılıyor, indirim hiç yazılmıyordu:
          kalemler adisyon toplamının üstünde kalıyor, aradaki fark kâğıtta görünmüyordu (inceleme, 23 Kas 2026) */}
      <div className="rc-items">
        {order.items
          .filter((i) => !i.voided)
          .map((i) => (
            <div key={i.id} className="rc-item">
              <span className="rc-qty">{i.qty}x</span>
              <span className="rc-item-name">
                {i.name}
                {i.size && i.size !== 'TEK' ? ` ${boot.settings.sizeLabels?.[i.size as 'M' | 'L'] ?? i.size}` : ''}
              </span>
              <span className="rc-r">{i.complimentary ? COMP_LABEL[i.compKind ?? 'ikram'].toLocaleUpperCase('tr-TR') : tlPlain(lineGross(i))}</span>
              {i.optionsText && <span className="rc-item-sub">{i.optionsText}</span>}
              {i.note && <span className="rc-item-sub">Not: {i.note}</span>}
              {i.discount > 0 && (
                <>
                  <span className="rc-item-sub rc-item-sub-l">İndirim{i.discountReason ? ` (${i.discountReason})` : ''}</span>
                  <span className="rc-r">-{tlPlain(i.discount)}</span>
                </>
              )}
            </div>
          ))}
      </div>
      <Hr />
      {t.lineDiscounts + t.orderDiscount > 0 && (
        <>
          <Row l="Ara toplam" r={tlPlain(t.gross)} />
          <Row l={`İndirim${order.discountReason ? ` (${order.discountReason})` : ''}`} r={`-${tlPlain(t.lineDiscounts + t.orderDiscount)}`} />
        </>
      )}
      {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tlPlain(t.service)} />}
      <Row l="Adisyon toplamı" r={tlPlain(order.total)} />
      <div className="rc-block">
        {payments.map((p) => (
          <Row key={p.id} l={p.tip > 0 ? `${p.methodName} (bahşiş ${tlPlain(p.tip)})` : p.methodName} r={tlPlain(p.amount + p.tip)} />
        ))}
      </div>
      {comp ? (
        <div className="rc-total">
          <span>{comp.toLocaleUpperCase('tr-TR')}</span>
          <span className="rc-r">0,00 TL</span>
        </div>
      ) : (
        <>
          <div className="rc-total">
            <span>ALINAN</span>
            <span className="rc-r">{tlPlain(paid)} TL</span>
          </div>
          {order.total - order.paid > 0 && <Row strong l="Kalan" r={`${tlPlain(order.total - order.paid)} TL`} />}
        </>
      )}
      {device && (device.receiptNo != null || device.zNo != null || device.docId) && (
        <div className="rc-block">
          {device.receiptNo != null && <Row l={`Yazarkasa ${device.docLabel ?? 'fiş'} no`} r={String(device.receiptNo)} />}
          {device.zNo != null && <Row l="Z no" r={String(device.zNo)} />}
          {device.docId && <Row small l={device.docId} />}
        </div>
      )}
      <div className="rc-foot">
        <div className="rc-strong">İŞYERİ NÜSHASI · MALİ DEĞERİ YOKTUR</div>
      </div>
    </div>
  );
}

/** Gün sonu (Z) ya da gün açıkken ara rapor (X) çıktısı: X'te kapanış anı yoktur */
export function ZReceipt({ boot, date, zNo, s, closedAt }: { boot: BootstrapDTO; date: string; zNo: number; s: ZSummary; closedAt: number | null }) {
  return (
    <div className="rc">
      <Header boot={boot} title={closedAt ? `GÜN SONU · Z ${zNo}` : 'ARA RAPOR (X)'} />
      <div className="rc-block">
        <Row l="İş günü" r={date} />
        {closedAt && <Row l="Kapanış" r={fmtDateTime(closedAt)} />}
        <Row l="Yazdırma" r={fmtDateTime(Date.now())} />
      </div>
      <Hr />
      <Row l="Brüt satış" r={tlPlain(s.gross)} />
      <Row l="İndirim" r={`-${tlPlain(s.discounts)}`} />
      {s.service > 0 && <Row l="Servis" r={tlPlain(s.service)} />}
      <div className="rc-total">
        <span>NET CİRO</span>
        <span className="rc-r">{tlPlain(s.netSales)} TL</span>
      </div>
      <Row l="Adisyon / kişi" r={`${s.receipts} / ${s.guests}`} />
      <Hr />
      <div className="rc-caption">Ödemeler</div>
      {s.payments.map((p) => (
        <Row key={p.methodId} l={`${p.name} (${p.count})`} r={tlPlain(p.amount)} />
      ))}
      {s.tips > 0 && <Row l="Bahşiş" r={tlPlain(s.tips)} />}
      {/* Mali fişi yazarkasada kesilmeyen kart ve nakit, bahşiş hariç; eski Z'de alan yok, satır da basılmaz */}
      {s.offDevice && (
        <>
          <Hr />
          <div className="rc-caption">Yazarkasadan geçmeyen</div>
          <Row l="Kart" r={tlPlain(s.offDevice.card)} />
          <Row l="Nakit" r={tlPlain(s.offDevice.cash)} />
        </>
      )}
      <Hr />
      <KdvRows rows={s.kdv} />
      <Hr />
      <div className="rc-caption">Ciro dışı</div>
      <Row l="İkram" r={tlPlain(s.complimentary - (s.odenmez ?? 0) - (s.zayi ?? 0))} />
      {(s.odenmez ?? 0) > 0 && <Row l="Ödenmez" r={tlPlain(s.odenmez ?? 0)} />}
      {(s.zayi ?? 0) > 0 && <Row l="Zayi" r={tlPlain(s.zayi ?? 0)} />}
      <Row l={`İptal (${s.voidAfterSendCount} hazırlandıktan sonra)`} r={tlPlain(s.voided)} />
      <Hr />
      <div className="rc-caption">Kasa</div>
      <Row l="Açılış nakiti" r={tlPlain(s.openingCash)} />
      <Row l="Kasa girişi" r={tlPlain(s.cashIn)} />
      <Row l="Harcama" r={`-${tlPlain(s.cashOut)}`} />
      <Row l="Teslim" r={`-${tlPlain(s.handedOver)}`} />
      {/* Teslimin kime gittiği (eski Z'de yok) */}
      {(s.handedOverBy ?? []).map((r) => (
        <Row small key={r.userId ?? `ad:${r.name}`} l={`· Kime: ${r.name}`} r={`-${tlPlain(r.amount)}`} />
      ))}
      {s.cariCollections > 0 && <Row l="Açık hesap tahsilatı" r={tlPlain(s.cariCollections)} />}
      <Row strong l="Beklenen nakit" r={tlPlain(s.expectedCash)} />
      {s.countedCash != null && <Row l="Sayılan nakit" r={tlPlain(s.countedCash)} />}
      {s.cashDiff != null && <Row strong l="FARK" r={tlPlain(s.cashDiff)} />}
      {s.onlineOrders > 0 && (
        <>
          <Hr />
          <Row l={`Online sipariş (sitede ödendi) ${s.onlineOrders}`} r={tlPlain(s.onlineTotal)} />
        </>
      )}
      <Hr />
      <div className="rc-foot">AsilPOS yönetim raporudur, mali Z değildir</div>
    </div>
  );
}

/** Cihazda alınan banka gün sonunun kâğıdı (`POST /okc/eod/slip`): bankalar, işlem sayısı, toplam; varsa AsilPOS kıyası */
export function BankEodReceipt({ boot, slip }: { boot: BootstrapDTO; slip: BankEodSlip }) {
  const diff = slip.grandTotalKurus != null && slip.dayCardKurus != null ? slip.grandTotalKurus - slip.dayCardKurus : null;
  return (
    <div className="rc">
      <Header boot={boot} title="BANKA GÜN SONU · PAVO" />
      <div className="rc-block">
        <Row l="Batch" r={slip.batchNo} />
        {slip.deviceDateTime && <Row l="Cihaz saati" r={slip.deviceDateTime} />}
        <Row l="Alınış" r={slip.trigger === 'otomatik' ? 'Gün kapanınca' : 'Elle'} />
        <Row l="Yazdırma" r={fmtDateTime(Date.now())} />
      </div>
      <Hr />
      <div className="rc-caption">Bankalar</div>
      {slip.acquirers.length ? (
        slip.acquirers.map((a, i) => <Row key={`${a.name}-${i}`} l={`${a.name}${a.count != null ? ` (${a.count})` : ''}`} r={a.totalKurus != null ? tlPlain(a.totalKurus) : '-'} />)
      ) : (
        <Row l="İşlem yok" />
      )}
      <div className="rc-total">
        <span>TOPLAM</span>
        <span className="rc-r">{slip.grandTotalKurus != null ? `${tlPlain(slip.grandTotalKurus)} TL` : '-'}</span>
      </div>
      <Hr />
      {/* Kayıt için kıyas: Pavo'nun (bankanın) kart toplamı ile AsilPOS'ta kartla alınan; fark çıkmamalı. Başlık eski
          adla: ladmin'in kâğıt okuyucusu banka satırlarını onda bitirir (shared/eski-adlar.ts) */}
      <div className="rc-caption">{BANKA_KIYAS_BASLIGI}</div>
      <Row l="Pavo kart toplamı" r={slip.grandTotalKurus != null ? tlPlain(slip.grandTotalKurus) : '-'} />
      <Row l="AsilPOS kart toplamı" r={slip.dayCardKurus != null ? tlPlain(slip.dayCardKurus) : '-'} />
      {diff != null ? (
        <>
          <Row strong l="FARK" r={tlPlain(diff)} />
          <div className="rc-total">
            <span>{diff === 0 ? 'UYUMLU' : 'FARK VAR!'}</span>
            <span className="rc-r">{diff === 0 ? 'OK' : diff > 0 ? 'Pavo fazla' : 'Pavo eksik'}</span>
          </div>
        </>
      ) : (
        <Row strong l="Karşılaştırılamadı" />
      )}
      <Hr />
      <div className="rc-foot">Pavo cihazının banka gün sonu özetidir</div>
    </div>
  );
}

/**
 * Deneme fişi (Yönetim › Ayarlar ve yedek › Fiş yazıcısı): fişlerle aynı düzen. Kenardan kenara çizgi ve sağa yaslı
 * tutar kâğıdın iki yanının da basıldığını, uzun ad kesilmeden alta kaydığını gösterir
 */
export function TestReceipt({ boot, printer }: { boot: BootstrapDTO; printer: string | null }) {
  return (
    <div className="rc">
      <Header boot={boot} title="DENEME FİŞİ" />
      <div className="rc-block">
        <Row l="Tarih" r={fmtDateTime(Date.now())} />
        {printer && <Row l={`Yazıcı ${printer}`} />}
      </div>
      <Hr />
      <div className="rc-items">
        <div className="rc-item">
          <span className="rc-qty">1x</span>
          <span className="rc-item-name">Örnek ürün</span>
          <span className="rc-r">0,00</span>
        </div>
        <div className="rc-item">
          <span className="rc-qty">12x</span>
          <span className="rc-item-name">Uzun adlı örnek ürün: satıra sığmayan ad kesilmez, alta kayar</span>
          <span className="rc-r">0,00</span>
          <span className="rc-item-sub">Seçenek ve not girintili yazılır</span>
        </div>
      </div>
      <div className="rc-total">
        <span>TOPLAM</span>
        <span className="rc-r">0,00 TL</span>
      </div>
      <div className="rc-foot">
        <div className="rc-strong">Yazıcı çalışıyor</div>
        <div className="rc-foot-note">Kalın çizgiler kenardan kenara basıldıysa kâğıt genişliği doğru</div>
      </div>
    </div>
  );
}
