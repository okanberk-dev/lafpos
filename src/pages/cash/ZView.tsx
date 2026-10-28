import { Check, ClipboardCopy, Download, Printer, Send } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { fmtDateLong, fmtDateTime } from '@shared/time';
import type { BusinessDayDTO } from '@shared/types';
import type { ZSummary } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, Stat } from '@/components/ui/misc';
import { errorMessage, getToken, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { type DayAnswer, pushToast } from '@/lib/lafmaliyet';
import { printNow, ZReceipt } from '@/lib/print';
import { toast } from '@/lib/toast';

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

export function ZView({ day, summary, lafmaliyet, title }: { day: BusinessDayDTO; summary: ZSummary; lafmaliyet: Record<string, unknown> | null; title?: string }) {
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title ?? `Z ${day.zNo}`}</h2>
          <p className="text-[13px] text-muted">
            {fmtDateLong(day.date)} · açılış {fmtDateTime(day.openedAt)}
            {day.closedAt && ` · kapanış ${fmtDateTime(day.closedAt)}`}
          </p>
        </div>
        <Button icon={<Printer className="size-4" />} onClick={() => printNow(<ZReceipt boot={boot} date={day.date} zNo={day.zNo} s={summary} closedAt={day.closedAt} />)}>
          Yazdır
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net ciro" value={tl(summary.netSales)} strong />
        <Stat label="Adisyon" value={`${summary.receipts}`} hint={summary.receipts ? `ort. ${tl(Math.round(summary.netSales / summary.receipts))}` : undefined} />
        <Stat label="Beklenen nakit" value={tl(summary.expectedCash)} />
        <Stat label="Kasa farkı" value={d == null ? '—' : tl(d)} hint={d == null ? 'Sayılmadı' : undefined} tone={d == null ? undefined : d === 0 ? 'ok' : 'bad'} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Ödeme türleri">
          <ul className="divide-y divide-line">
            {summary.payments.map((p) => (
              <li key={p.methodId} className="flex justify-between px-4 py-2 text-sm">
                <span>
                  {p.name} <span className="text-muted">({p.count})</span>
                </span>
                <span className="tabular font-semibold">{tl(p.amount)}</span>
              </li>
            ))}
            {summary.tips > 0 && (
              <li className="flex justify-between px-4 py-2 text-sm text-muted">
                <span>Bahşiş (ciro dışı)</span>
                <span className="tabular">{tl(summary.tips)}</span>
              </li>
            )}
            {summary.payments.length === 0 && (
              <li>
                <EmptyState compact title="Bu gün ödeme alınmadı" />
              </li>
            )}
          </ul>
        </Card>
        <Card title="Kontrol">
          <ul className="divide-y divide-line text-sm">
            <Line l="Brüt satış" r={tl(summary.gross)} />
            <Line l="İndirim" r={`−${tl(summary.discounts)}`} />
            <Line l="İkram (ciro dışı)" r={tl(summary.complimentary - (summary.odenmez ?? 0) - (summary.zayi ?? 0))} />
            {(summary.odenmez ?? 0) > 0 && <Line l="Ödenmez (ciro dışı)" r={tl(summary.odenmez ?? 0)} />}
            {(summary.zayi ?? 0) > 0 && <Line l="Zayi (ciro dışı)" r={tl(summary.zayi ?? 0)} />}
            <Line l={`İptal (${summary.voidAfterSendCount} hazırlandıktan sonra)`} r={tl(summary.voided)} />
            <Line l="Kasa girişi" r={tl(summary.cashIn)} />
            <Line l="Harcama" r={tl(summary.cashOut)} />
            <Line l="Teslim" r={tl(summary.handedOver)} />
            {summary.cariCollections > 0 && <Line l="Açık hesap tahsilatı" r={tl(summary.cariCollections)} />}
            {summary.onlineOrders > 0 && <Line l={`Online (sitede ödendi, ${summary.onlineOrders})`} r={tl(summary.onlineTotal)} />}
            {summary.kdv.map((k) => (
              <Line key={k.rate} l={`KDV %${k.rate} (matrah ${tl(k.base)})`} r={tl(k.kdv)} />
            ))}
          </ul>
        </Card>
      </div>

      {lafmaliyet && (
        <Card
          title="lafmaliyet Kasa raporu"
          actions={
            <div className="flex gap-1.5">
              <Button size="sm" icon={copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />} onClick={copy}>
                {copied ? 'Kopyalandı' : 'Kopyala'}
              </Button>
              <Button size="sm" icon={<Download className="size-4" />} onClick={download}>
                JSON
              </Button>
              {boot.integrations.lafmaliyetPush && day.closedAt && !trainingDay && (can('kasa.gun') || can('senkron.yonet')) && (
                <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={sending} onClick={send}>
                  Gönder
                </Button>
              )}
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-4 py-3 text-sm sm:grid-cols-3">
            {LAF_FIELDS.map(([k, label]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-dashed border-line py-1">
                <span className="text-muted">{label}</span>
                <span className="tabular font-medium">{fmtLaf(lafmaliyet[k]) || '—'}</span>
              </div>
            ))}
          </div>
          <p className="px-4 pb-3 text-xs text-muted">
            Alanlar lafmaliyet’teki formla aynı sırada. “Kopyala” ile alıp forma yapıştırabilirsiniz;{' '}
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
          <ul className="divide-y divide-line text-sm">
            {summary.topProducts.slice(0, 10).map((p) => (
              <li key={p.name} className="flex justify-between px-4 py-2">
                <span>
                  {p.name} <span className="text-muted">× {p.qty}</span>
                </span>
                <span className="tabular">{tl(p.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const Line = ({ l, r }: { l: string; r: string }) => (
  <li className="flex justify-between gap-3 px-4 py-2">
    <span className="text-ink-2">{l}</span>
    <span className="tabular whitespace-nowrap">{r}</span>
  </li>
);
