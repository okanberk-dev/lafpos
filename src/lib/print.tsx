import { type ReactNode, useEffect } from 'react';
import { create } from 'zustand';
import { tlPlain } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import type { ZSummary } from '@shared/types';
import { callFor, callText, numaratorLabel, serviceModeOf } from '@shared/service-mode';

/**
 * Tarayıcıdan 80 mm termal yazıcıya çıktı. İçerik `.print-area`ya çizilir, `window.print()` çağrılır;
 * sayfanın geri kalanı yazdırmada gizlidir (index.css @media print).
 */
const usePrint = create<{ content: ReactNode | null; sheet: boolean; set: (c: ReactNode | null, sheet?: boolean) => void }>((set) => ({ content: null, sheet: false, set: (content, sheet = false) => set({ content, sheet }) }));

/** `sheet`: 80 mm fiş değil A4 sayfa (masa kartları); index.css `.print-sheet` */
export function printNow(content: ReactNode, opts: { sheet?: boolean } = {}) {
  usePrint.getState().set(content, !!opts.sheet);
  // İçerik çizilsin diye bir kare bekle
  requestAnimationFrame(() => setTimeout(() => window.print(), 30));
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

const Row = ({ l, r, bold }: { l: ReactNode; r?: ReactNode; bold?: boolean }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: bold ? 700 : 400 }}>
    <span>{l}</span>
    {r !== undefined && <span style={{ whiteSpace: 'nowrap' }}>{r}</span>}
  </div>
);
const Hr = () => <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />;

function Header({ boot, title }: { boot: BootstrapDTO; title: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{boot.settings.businessName}</div>
      {boot.settings.receiptHeader && <div style={{ whiteSpace: 'pre-line' }}>{boot.settings.receiptHeader}</div>}
      {boot.settings.businessAddress && <div>{boot.settings.businessAddress}</div>}
      <div style={{ marginTop: 4, fontWeight: 700 }}>{title}</div>
    </div>
  );
}

/** Adisyon / hesap fişi. Mali değeri yoktur: mali fiş ÖKC'den (yazarkasa) kesilir. */
/** Adisyon (bilgi fişi). `share`: paylaşımlı hesapta kişinin payı da basılır */
export function BillReceipt({ order, boot, sizeLabel, share }: { order: OrderDTO; boot: BootstrapDTO; sizeLabel: (s: string) => string; share?: { no: number; of: number; amount: number } }) {
  const t = order.totals;
  const live = order.items.filter((i) => !i.voided);
  // Self ve yarı self servis: müşterinin numarası ya da masası fişte büyük (numara çağrılınca alır)
  const call = order.tableName ? null : callFor(order, serviceModeOf(boot.settings));
  const place = order.tableName ?? (order.numarator ? numaratorLabel(order.numarator) : order.type === 'tezgah' ? 'Tezgâh' : order.type === 'gelal' ? 'Gel-al' : 'Paket');
  return (
    <div>
      <Header boot={boot} title="ADİSYON" />
      {call && <div style={{ textAlign: 'center', fontSize: 26, fontWeight: 700, margin: '4px 0' }}>{callText(call)}</div>}
      <Hr />
      <Row l={`${place} · #${order.no}`} r={fmtDateTime(Date.now())} />
      {order.waiterName && <Row l={`Garson: ${order.waiterName}`} r={`${order.guests} kişi`} />}
      {order.customer && <Row l={`Müşteri: ${order.customer.name}`} />}
      <Hr />
      {live.map((i) => (
        <div key={i.id} style={{ marginBottom: 2 }}>
          <Row l={`${i.qty} x ${i.name}${i.size !== 'TEK' ? ` ${sizeLabel(i.size)}` : ''}`} r={i.complimentary ? 'İKRAM' : tlPlain(i.qty * i.unitPrice)} />
          {i.optionsText && <div style={{ paddingLeft: 12, fontSize: 10 }}>{i.optionsText}</div>}
          {i.discount > 0 && <Row l={<span style={{ paddingLeft: 12 }}>İndirim</span>} r={`-${tlPlain(i.discount)}`} />}
        </div>
      ))}
      <Hr />
      {t.lineDiscounts + t.orderDiscount > 0 && (
        <>
          <Row l="Ara toplam" r={tlPlain(t.gross)} />
          <Row l={`İndirim${order.discountReason ? ` (${order.discountReason})` : ''}`} r={`-${tlPlain(t.lineDiscounts + t.orderDiscount)}`} />
        </>
      )}
      {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tlPlain(t.service)} />}
      <Row l="TOPLAM" r={`${tlPlain(t.total)} TL`} bold />
      {order.paid > 0 && order.paid < order.total && (
        <>
          <Row l="Ödenen" r={tlPlain(order.paid)} />
          <Row l="Kalan" r={tlPlain(order.total - order.paid)} bold />
        </>
      )}
      {share && (
        <>
          <Hr />
          <Row l={`PAYINIZ (${share.no}/${share.of})`} r={`${tlPlain(share.amount)} TL`} bold />
          <div style={{ fontSize: 10 }}>Hesap {share.of} kişiye eşit bölündü</div>
        </>
      )}
      <div style={{ marginTop: 4, fontSize: 10 }}>
        {t.kdv.map((k) => (
          <Row key={k.rate} l={`KDV %${k.rate} matrah ${tlPlain(k.base)}`} r={tlPlain(k.kdv)} />
        ))}
      </div>
      <Hr />
      <div style={{ textAlign: 'center', fontSize: 10 }}>
        <div style={{ fontWeight: 700 }}>BİLGİ FİŞİDİR · MALİ DEĞERİ YOKTUR</div>
        {boot.settings.receiptFooter && <div style={{ whiteSpace: 'pre-line', marginTop: 4 }}>{boot.settings.receiptFooter}</div>}
      </div>
    </div>
  );
}

/** Gün sonu (Z) çıktısı */
export function ZReceipt({ boot, date, zNo, s, closedAt }: { boot: BootstrapDTO; date: string; zNo: number; s: ZSummary; closedAt: number | null }) {
  return (
    <div>
      <Header boot={boot} title={`GÜN SONU · Z ${zNo}`} />
      <Hr />
      <Row l="İş günü" r={date} />
      <Row l="Yazdırma" r={fmtDateTime(closedAt ?? Date.now())} />
      <Hr />
      <Row l="Brüt satış" r={tlPlain(s.gross)} />
      <Row l="İndirim" r={`-${tlPlain(s.discounts)}`} />
      {s.service > 0 && <Row l="Servis" r={tlPlain(s.service)} />}
      <Row l="NET CİRO" r={tlPlain(s.netSales)} bold />
      <Row l="Adisyon / kişi" r={`${s.receipts} / ${s.guests}`} />
      <Hr />
      {s.payments.map((p) => (
        <Row key={p.methodId} l={`${p.name} (${p.count})`} r={tlPlain(p.amount)} />
      ))}
      {s.tips > 0 && <Row l="Bahşiş" r={tlPlain(s.tips)} />}
      <Hr />
      {s.kdv.map((k) => (
        <Row key={k.rate} l={`KDV %${k.rate} matrah ${tlPlain(k.base)}`} r={tlPlain(k.kdv)} />
      ))}
      <Hr />
      <Row l="İkram" r={tlPlain(s.complimentary - (s.odenmez ?? 0))} />
      {(s.odenmez ?? 0) > 0 && <Row l="Ödenmez" r={tlPlain(s.odenmez ?? 0)} />}
      <Row l={`İptal (${s.voidAfterSendCount} hazırlandıktan sonra)`} r={tlPlain(s.voided)} />
      <Hr />
      <Row l="Açılış nakiti" r={tlPlain(s.openingCash)} />
      <Row l="Kasa girişi" r={tlPlain(s.cashIn)} />
      <Row l="Harcama" r={`-${tlPlain(s.cashOut)}`} />
      <Row l="Teslim" r={`-${tlPlain(s.handedOver)}`} />
      {s.cariCollections > 0 && <Row l="Açık hesap tahsilatı" r={tlPlain(s.cariCollections)} />}
      <Row l="Beklenen nakit" r={tlPlain(s.expectedCash)} bold />
      {s.countedCash != null && <Row l="Sayılan nakit" r={tlPlain(s.countedCash)} />}
      {s.cashDiff != null && <Row l="FARK" r={tlPlain(s.cashDiff)} bold />}
      {s.onlineOrders > 0 && (
        <>
          <Hr />
          <Row l={`Online sipariş (sitede ödendi) ${s.onlineOrders}`} r={tlPlain(s.onlineTotal)} />
        </>
      )}
      <Hr />
      <div style={{ textAlign: 'center', fontSize: 10 }}>LafPOS yönetim raporudur, mali Z değildir</div>
    </div>
  );
}
