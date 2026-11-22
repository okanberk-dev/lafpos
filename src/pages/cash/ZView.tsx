import { Check, ClipboardCopy, Download, Printer, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { tl } from '@shared/money';
import { fmtDateLong, fmtDateTime, fmtTime, istanbulParts } from '@shared/time';
import type { BusinessDayDTO, ZSummary } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, Stat } from '@/components/ui/misc';
import { errorMessage, getToken, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { type DayAnswer, pushToast } from '@/lib/lafmaliyet';
import { printNow, ZReceipt } from '@/lib/print';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { signedTL } from './CashCount';

/** lafmaliyet Kasa raporu formundaki etiketler (aynı sırayla) */
const LAF_FIELDS: [string, string][] = [
  ['z_no', 'Z no'],
  ['receipts', 'Fiş sayısı'],
  ['z_total', 'Z toplam'],
  ['cash', 'Nakit'],
  ['card', 'Kredi kartı'],
  ['meal_card', 'Yemek kartı'],
  ['online', 'Online'],
  ['other', 'Diğer'],
  ['off_revenue', 'Ödenmez / ikram / zayi'],
  ['discounts', 'İndirimler'],
  ['opening_cash', 'Açılış kasası'],
  ['cash_out', 'Kasadan çıkan'],
  ['counted_cash', 'Sayılan nakit'],
  ['handed_over', 'Teslim edilen'],
  ['cash_diff', 'Kasa farkı'],
];

const fmtLaf = (v: unknown) => (v == null ? '' : typeof v === 'number' ? v.toLocaleString('tr-TR', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }) : String(v));

/**
 * Z raporu (kapanmış gün) ya da ara rapor (X, açık gün; `title` verilir, tarih sayfa başlığında). `children` rakam
 * şeridinin hemen altına gelir (kasa hareketleri ve vardiya devirleri: düğmelerinin yakınında, dökümden önce).
 */
export function ZView({ day, summary, lafmaliyet, title, children }: { day: BusinessDayDTO; summary: ZSummary; lafmaliyet: Record<string, unknown> | null; title?: string; children?: ReactNode }) {
  const boot = useBoot();
  const can = useCan();
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const copy = async () => {
    if (!lafmaliyet) return;
    const text = LAF_FIELDS.map(([k, label]) => `${label}\t${fmtLaf(lafmaliyet[k])}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.warn('Pano kullanılamıyor; değerleri tablodan okuyun');
    }
  };
  const download = async () => {
    const res = await fetch(`/api/cash/days/${day.id}/lafmaliyet.json`, { headers: { authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lafpos-z-${day.date}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const send = async () => {
    setSending(true);
    try {
      const r = await post<{ answer?: DayAnswer | null }>(`/sync/lafmaliyet/gun/${day.id}/push`);
      toast.ok(pushToast(r?.answer));
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const d = summary.cashDiff;
  // Kurulum modunda (ya da eğitim işaretinden önce) kapanan gün lafmaliyet'e gitmez (docs/03-ENTEGRASYON.md §4.3)
  const trainingDay = !!day.closedAt && day.trainingDay !== false;
  // Günün içindeki an yalnız saatiyle; gece yarısından sonraki kapanış gibi başka takvim gününe düşen an tarihiyle
  const at = (ms: number) => (istanbulParts(ms).date === day.date ? fmtTime(ms) : fmtDateTime(ms));
  // Ara raporda (başlık verilmiş, gün açık) tarih ve açılış sayfanın başlığında yazılı: tekrarlanmaz
  const showMeta = !!day.closedAt || !title;
  const paidTotal = summary.payments.reduce((a, p) => a + p.amount, 0);
  const ikram = summary.complimentary - (summary.odenmez ?? 0) - (summary.zayi ?? 0);
  const canPush = boot.integrations.lafmaliyetPush && !!day.closedAt && !trainingDay && (can('kasa.gun') || can('senkron.yonet'));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title ?? `Z ${day.zNo}`}</h2>
          {showMeta && <p className="text-pretty text-[13px] text-muted">{joinMeta([fmtDateLong(day.date), `açılış ${at(day.openedAt)}`, day.closedAt && `kapanış ${at(day.closedAt)}`])}</p>}
        </div>
        <Button icon={<Printer className="size-4" />} onClick={() => printNow(<ZReceipt boot={boot} date={day.date} zNo={day.zNo} s={summary} closedAt={day.closedAt} />)}>
          Yazdır
        </Button>
      </div>

      {/* Telefonda büyüyebilen iki tutar (net ciro, beklenen nakit) tam satır, adisyon ve dördüncü karo yan yana: 2 / 2 / 1+1;
          beş haneli tutar yarım karonun kenarına dayanır. Tablette ve bilgisayarda sıra değişmez */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net ciro" value={tl(summary.netSales)} strong className="max-sm:col-span-2" />
        <Stat label="Adisyon" value={`${summary.receipts}`} hint={summary.receipts ? `ort. ${tl(Math.round(summary.netSales / summary.receipts))}` : undefined} className="max-sm:order-1" />
        <Stat label="Beklenen nakit" value={tl(summary.expectedCash)} className="max-sm:col-span-2" />
        {day.closedAt ? (
          <Stat
            label="Kasa farkı"
            value={d == null ? '—' : signedTL(d)}
            hint={d == null ? 'Sayılmadı' : d > 0 ? 'Kasada fazla' : d < 0 ? 'Kasada eksik' : 'Kasa tuttu'}
            tone={d == null ? undefined : d === 0 ? 'ok' : 'bad'}
            className="max-sm:order-1"
          />
        ) : (
          // Açık günde sayım yalnız gün sonunda: fark karosu hep boş kalırdı; yerine beklenen nakdin başlangıcı
          <Stat label="Açılış nakdi" value={tl(summary.openingCash)} hint="Beklenen nakde dahil" className="max-sm:order-1" />
        )}
      </div>

      {children}

      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        <Card title="Ödeme türleri">
          {summary.payments.length === 0 ? (
            <EmptyState compact title={day.closedAt ? 'Bu gün ödeme alınmadı' : 'Henüz ödeme alınmadı'} />
          ) : (
            <ul className="divide-y divide-[var(--admin-divider)] text-sm">
              {summary.payments.map((p) => (
                <li key={p.methodId} className="flex justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    {p.name} <span className="text-muted">({p.count})</span>
                  </span>
                  <span className="tabular whitespace-nowrap font-medium">{tl(p.amount)}</span>
                </li>
              ))}
              {summary.payments.length > 1 && (
                <li className="flex justify-between gap-3 px-4 py-2 font-semibold">
                  <span>Toplam</span>
                  <span className="tabular whitespace-nowrap">{tl(paidTotal)}</span>
                </li>
              )}
              {summary.tips > 0 && (
                <li className="flex justify-between gap-3 px-4 py-2 text-muted">
                  <span>Bahşiş (ciro dışı)</span>
                  <span className="tabular whitespace-nowrap font-medium">{tl(summary.tips)}</span>
                </li>
              )}
              {/* Mali fişi yazarkasada kesilmeyen kart ve nakit (shared/order-calc.ts offDeviceTotals); eski Z'de yok, satır da yok */}
              {summary.offDevice && (
                <>
                  <Group>Yazarkasadan geçmeyen</Group>
                  <Line l="Kart" k={summary.offDevice.card} />
                  <Line l="Nakit" k={summary.offDevice.cash} />
                  <li className="text-pretty px-4 py-2 text-xs text-muted">Cihaza gitmeden LafPOS’a yazılan ödemeler, bahşiş hariç; mali fişi yazarkasada ayrıca kesilir</li>
                </>
              )}
            </ul>
          )}
        </Card>
        <Card title="Satış ve kasa dökümü">
          <ul className="divide-y divide-[var(--admin-divider)] text-sm">
            <Group>Satış</Group>
            <Line l="Brüt satış" k={summary.gross} />
            <Line l="İndirim" k={summary.discounts} minus />
            <Line l="İkram (ciro dışı)" k={ikram} />
            {(summary.odenmez ?? 0) > 0 && <Line l="Ödenmez (ciro dışı)" k={summary.odenmez ?? 0} />}
            {/* Ödenmez dökümü kişiyle (kimin adına); eski Z'lerde yok. Personel adı maliyet yetkisi olmayana "Personel" */}
            {(summary.odenmezPeople ?? []).map((p) => (
              <li key={`${p.kind ?? 'yok'}:${p.id ?? p.name}`} className="flex justify-between gap-3 py-1.5 pl-8 pr-4 text-[13px] text-muted">
                <span className="min-w-0 truncate">
                  {p.name} adına · {p.qty} adet
                </span>
                <span className="tabular whitespace-nowrap">{tl(p.amount)}</span>
              </li>
            ))}
            {(summary.zayi ?? 0) > 0 && <Line l="Zayi (ciro dışı)" k={summary.zayi ?? 0} />}
            <Line l={summary.voidAfterSendCount > 0 ? `İptal · ${summary.voidAfterSendCount} kalem hazırlandıktan sonra` : 'İptal'} k={summary.voided} />
            {summary.onlineOrders > 0 && <Line l={`Online (sitede ödendi, ${summary.onlineOrders})`} k={summary.onlineTotal} />}
            <Group>Kasa</Group>
            <Line l="Açılış nakdi" k={summary.openingCash} />
            <Line l="Kasa girişi" k={summary.cashIn} />
            <Line l="Harcama" k={summary.cashOut} />
            <Line l="Teslim" k={summary.handedOver} />
            {/* Kart ve havaleyle alınan tahsilat da bu tutarda (çekmeceye yalnız nakdi girer, beklenen nakit onu sayar) */}
            {summary.cariCollections > 0 && <Line l="Açık hesap tahsilatı (tüm ödeme türleri)" k={summary.cariCollections} />}
            {summary.kdv.length > 0 && <Group>KDV</Group>}
            {summary.kdv.map((k) => (
              <Line key={k.rate} l={`%${k.rate} · matrah ${tl(k.base)}`} k={k.kdv} />
            ))}
          </ul>
        </Card>
      </div>

      {lafmaliyet && (
        <Card
          title="lafmaliyet raporu"
          actions={
            // Telefonda düğmeler yalnız ikon (başlık kırpılmasın); ad ekran okuyucuda kalır
            <div className="flex gap-1.5">
              <Button size="sm" icon={copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />} onClick={copy}>
                <span className="max-sm:sr-only">{copied ? 'Kopyalandı' : 'Kopyala'}</span>
              </Button>
              <Button size="sm" icon={<Download className="size-4" />} aria-label="JSON indir" title="JSON indir" onClick={download}>
                <span className="max-sm:sr-only">JSON</span>
              </Button>
              {canPush && (
                <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={sending} onClick={send}>
                  <span className="max-sm:sr-only">Gönder</span>
                </Button>
              )}
            </div>
          }
        >
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 text-sm min-[480px]:grid-cols-2 lg:grid-cols-3">
            {LAF_FIELDS.map(([k, label]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-dashed border-line py-1">
                <span className="text-muted">{label}</span>
                <span className="tabular font-medium">{fmtLaf(lafmaliyet[k]) || '—'}</span>
              </div>
            ))}
          </div>
          <p className="px-4 pb-3 text-xs text-muted">
            Alanlar lafmaliyet’teki Kasa raporu formuyla aynı sırada. “Kopyala” ile alıp forma yapıştırabilirsiniz;{' '}
            {trainingDay
              ? day.trainingDay
                ? 'bu gün kurulum modunda kapandı (eğitim günü), lafmaliyet’e kendiliğinden gitmez'
                : 'bu gün eğitim işareti tutulmadan önce kapandı, lafmaliyet’e kendiliğinden gitmez'
              : 'bağlantı kurulunca kendiliğinden gider'}
          </p>
        </Card>
      )}

      {summary.topProducts.length > 0 && (
        <Card title="En çok satanlar">
          <ul className="divide-y divide-[var(--admin-divider)] text-sm">
            {summary.topProducts.slice(0, 10).map((p) => (
              <li key={p.name} className="flex justify-between gap-3 px-4 py-2">
                <span className="min-w-0">
                  {p.name} <span className="text-muted">× {p.qty}</span>
                </span>
                <span className="tabular whitespace-nowrap font-medium">{tl(p.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Dökümün bölüm etiketi (Satış, Kasa, KDV): kuyu zeminde küçük gri yazı, satırlarla aynı liste içinde */
const Group = ({ children }: { children: ReactNode }) => <li className="bg-surface-2 px-4 pb-1 pt-2.5 text-xs font-medium text-muted">{children}</li>;

/** Döküm satırı: sıfır tutarlı satır soluk (yapı sabit kalır, göz dolu satırlara gider); `minus` düşülen tutar (yalnız sıfırdan büyükse eksi) */
const Line = ({ l, k, minus }: { l: string; k: number; minus?: boolean }) => (
  <li className={cn('flex justify-between gap-3 px-4 py-2', k === 0 && 'text-muted')}>
    <span className={cn('min-w-0', k !== 0 && 'text-ink-2')}>{l}</span>
    <span className="tabular whitespace-nowrap font-medium">{minus && k > 0 ? `−${tl(k)}` : tl(k)}</span>
  </li>
);
