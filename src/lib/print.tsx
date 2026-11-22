import { type ReactNode, useEffect } from 'react';
import { create } from 'zustand';
import { COMP_LABEL } from '@shared/comp';
import { tlPlain } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import type { BootstrapDTO, OrderDTO, PublicSettings } from '@shared/types';
import type { ZSummary } from '@shared/types';

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
 * Tarayıcıdan 80 mm termal yazıcıya çıktı (kasa bilgisayarında kiosk Chrome, XP-80C gibi). İçerik `.print-area`ya
 * çizilir, `window.print()` çağrılır; sayfanın geri kalanı yazdırmada gizlidir. Fişin bütün görünümü index.css'teki
 * `.rc-*` sınıflarındadır: 80 mm kâğıtta 72 mm ortalı yazı alanı, yalnız siyah (gri ve zemin termal kâğıtta noktalı
 * basılır), sistemin eş aralıklı yazısı (yazdırma anında yüklenmesi gereken yazı tipi yok), sütunlu rakam. Tutarlar
 * sunucunun DTO'sundan gelir; burada yeni hesap yok
 */
const usePrint = create<{ content: ReactNode | null; sheet: boolean; set: (c: ReactNode | null, sheet?: boolean) => void }>((set) => ({ content: null, sheet: false, set: (content, sheet = false) => set({ content, sheet }) }));

/**
 * `sheet`: 80 mm fiş değil A4 sayfa (masa kartları); index.css `.print-sheet`. Dönen söz yazdırma komutu verilince
 * biter (kiosk Chrome'da `window.print()` fişi yazıcıya gönderip döner): işyeri nüshasının "basıldı" onayı bundan sonra
 * gider. Yazdırılamazsa reddedilir
 */
export function printNow(content: ReactNode, opts: { sheet?: boolean } = {}): Promise<void> {
  usePrint.getState().set(content, !!opts.sheet);
  // İçerik çizilsin diye bir kare bekle
  return new Promise((done, fail) =>
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
}

/**
 * Birkaç fişi ayrı yazdırma işleri olarak basar: termal yazıcı her işin sonunda keser (saha, 22 Kas 2026: iki nüsha
 * böyle ayrı kâğıt çıkıyor). Her iş `afterprint` olayıyla (en çok 6 sn) biter, sonraki kısa bir aradan sonra gider
 */
export async function printEach(parts: ReactNode[]): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
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
    await printNow(parts[i]);
    await finished;
  }
}

export function PrintHost() {
  const content = usePrint((s) => s.content);
  const sheet = usePrint((s) => s.sheet);
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
            <span className="rc-r">{i.complimentary ? COMP_LABEL[i.compKind ?? 'ikram'].toLocaleUpperCase('tr-TR') : tlPlain(i.qty * i.unitPrice)}</span>
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
 * İşyeri nüshası: ödemeden sonra fiş yazıcısından çıkan kısa kayıt (kalem dökümü yok). Müşterinin fişini yazarkasa
 * basar; bu kâğıt kasada kalır. `device`: yazarkasanın fiş ve Z no'su (cihazdan geldiyse)
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
      {/* Bar ve hazırlık için kalem dökümü (seçenekler girintili) */}
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
              <span className="rc-r">{tlPlain(i.qty * i.unitPrice)}</span>
              {i.optionsText && <span className="rc-item-sub">{i.optionsText}</span>}
              {i.note && <span className="rc-item-sub">Not: {i.note}</span>}
            </div>
          ))}
      </div>
      <Hr />
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

/** Birden çok fiş tek yazdırmada (işyeri nüshası ve bilgi fişi): aralarında kâğıt kesilir */
export const PrintCut = () => <div className="rc-cut" aria-hidden="true" />;

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
      <div className="rc-foot">LafPOS yönetim raporudur, mali Z değildir</div>
    </div>
  );
}

/** Cihazda alınan banka gün sonunun kâğıdı (`POST /okc/eod/slip`): bankalar, işlem sayısı, toplam; varsa LafPOS kıyası */
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
      {/* Kayıt için kıyas: Pavo'nun (bankanın) kart toplamı ile LafPOS'ta kartla alınan; fark çıkmamalı */}
      <div className="rc-caption">PAVO - LAFPOS KARŞILAŞTIRMA</div>
      <Row l="Pavo kart toplamı" r={slip.grandTotalKurus != null ? tlPlain(slip.grandTotalKurus) : '-'} />
      <Row l="LafPOS kart toplamı" r={slip.dayCardKurus != null ? tlPlain(slip.dayCardKurus) : '-'} />
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
