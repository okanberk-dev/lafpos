import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Printer } from 'lucide-react';
import { useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { Badge, Card } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Field';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { printNow, TestReceipt } from '@/lib/print';
import { toast } from '@/lib/toast';

interface PrinterView {
  reportedAt: number | null;
  printers: { name: string; port: string | null; driver: string | null; isDefault: boolean; offline: boolean }[];
  chosen: string | null;
  effective: string | null;
  auto: boolean;
}

const VIRTUAL = /pdf|xps|onenote|fax|faks|send to|document writer|anydesk|teamviewer|microsoft print/i;

/**
 * Yönetim › Ayarlar ve yedek › Fiş yazıcısı (Windows kurulumu; server/lib/yazici.ts). Kasa ekranı açılırken kısayol
 * bilgisayardaki yazıcıları bildirir; burada biri seçilir (ya da tek fiş yazıcısı kendiliğinden seçilir) ve kasa ekranı
 * açılırken Windows'un varsayılan yazıcısı yapılır. Chrome'un sessiz yazdırması fişi, Z'yi ve X'i ona basar
 */
export function PrinterCard() {
  const qc = useQueryClient();
  const boot = useBoot();
  const q = useQuery({ queryKey: ['admin', 'yazici'], queryFn: () => get<PrinterView>('/admin/yazici') });
  const [saving, setSaving] = useState<string | null>(null);
  const [savingOpt, setSavingOpt] = useState(false);
  const d = q.data;
  /** Ödeme sonrası fişler (ayar, herkese giden: kasa ekranı ödemeden sonra ona bakar) */
  const setOpt = async (patch: { receiptStoreCopy?: boolean; receiptInfoSlip?: boolean; receiptDirect?: boolean }, done: string) => {
    if (savingOpt) return;
    setSavingOpt(true);
    try {
      await put('/admin/settings', patch);
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.ok(done);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSavingOpt(false);
    }
  };

  const choose = async (name: string | null) => {
    if (saving) return;
    setSaving(name ?? '');
    try {
      const next = await put<PrinterView>('/admin/yazici', { name });
      qc.setQueryData(['admin', 'yazici'], next);
      toast.ok(name ? `Fiş yazıcısı: ${name}. Kasa ekranı bir sonraki açılışta buna basar` : 'Fiş yazıcısı kendiliğinden seçilecek');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };
  /** Deneme fişi de ayardaki yoldan: doğrudan basılamadıysa söylenir (tarayıcıdan basıldı) */
  const testPrint = async () => {
    try {
      const how = await printNow(<TestReceipt boot={boot} printer={d?.effective ?? null} />);
      if (how === 'direct') toast.ok('Deneme fişi yazıcıya doğrudan gönderildi');
      else if (boot.settings.receiptDirect) toast.warn('Yazıcıya doğrudan ulaşılamadı; fiş tarayıcıdan basıldı. Yazıcının ağ adresini ve açık olduğunu kontrol edin');
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const real = (d?.printers ?? []).filter((p) => !VIRTUAL.test(`${p.name} ${p.driver ?? ''} ${p.port ?? ''}`));
  const others = (d?.printers ?? []).filter((p) => !real.includes(p));

  return (
    <Card
      title="Fiş yazıcısı"
      subtitle="Kablolu (USB) ya da ağdaki yazıcı; fiş, Z ve X önizlemesiz buradan çıkar"
      actions={d ? <Badge tone={d.effective ? 'success' : 'warning'} dot>{d.effective ? (d.auto ? 'Kendiliğinden seçildi' : 'Seçildi') : 'Seçilmedi'}</Badge> : undefined}
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError && !d ? (
        <ErrorState compact title="Yazıcılar alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : d ? (
        <div className="space-y-3 text-sm">
          {!d.reportedAt ? (
            <p className="text-[13px] leading-5 text-[var(--admin-text-mute)]">
              Kasa bilgisayarındaki yazıcılar kasa ekranı açılırken burada listelenir (masaüstündeki LafPOS Kasa). Yazıcıyı USB ile takın; Windows sürücüsünü kurduktan sonra kasa
              ekranını kapatıp açın
            </p>
          ) : (
            <>
              <ul className="divide-y divide-[var(--admin-divider)] rounded-[var(--r-tile)] ring-1 ring-inset ring-[var(--admin-border)]">
                {[...real, ...others].map((p) => {
                  const on = d.effective === p.name;
                  const virtual = !real.includes(p);
                  return (
                    <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                      <Printer aria-hidden="true" className={cn('size-4 shrink-0', virtual ? 'text-[var(--admin-text-mute)]' : 'text-[var(--admin-text-soft)]')} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block font-medium [overflow-wrap:anywhere]', virtual ? 'text-[var(--admin-text-mute)]' : 'text-[var(--admin-text)]')}>{p.name}</span>
                        <span className="block text-xs text-[var(--admin-text-mute)] [overflow-wrap:anywhere]">
                          {[p.port, p.offline ? 'çevrim dışı' : null, virtual ? 'kâğıda basmaz' : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {on ? (
                        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--admin-success)]">
                          <CheckCircle2 aria-hidden="true" className="size-4" /> Fiş buradan
                        </span>
                      ) : (
                        !virtual && (
                          <Button size="sm" variant="soft" loading={saving === p.name} disabled={!!saving} onClick={() => void choose(p.name)}>
                            Bunu kullan
                          </Button>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-[var(--admin-text-mute)]">
                Son bildirim {fmtDateTime(d.reportedAt)}.{' '}
                {d.effective
                  ? 'Kasa ekranı açılırken bu yazıcı Windows’un varsayılan yazıcısı yapılır.'
                  : real.length
                    ? 'Birden çok yazıcı var: fişin çıkacağını seçin.'
                    : 'Kâğıda basan yazıcı yok: yazıcının USB kablosunu ve sürücüsünü kontrol edin.'}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-3 max-sm:[&>*]:grow">
            <Button icon={<Printer className="size-4" />} onClick={() => void testPrint()}>
              Deneme fişi yazdır
            </Button>
            {d.chosen && (
              <Button variant="ghost" disabled={!!saving} onClick={() => void choose(null)}>
                Kendiliğinden seçilsin
              </Button>
            )}
          </div>
          <p className="text-xs text-[var(--admin-text-mute)]">
            {boot.settings.receiptDirect
              ? 'Doğrudan basmada fiş hangi cihazdan istenirse istensin bu yazıcıdan çıkar; yazıcıya ulaşılamazsa o cihazın yazdırma penceresi açılır'
              : 'Deneme fişini kasa bilgisayarında basın: telefonda ya da tablette basılırsa o cihazın yazdırma penceresi açılır'}
          </p>
          {/* Ödemeden sonra kendiliğinden çıkanlar: yalnız kasa bilgisayarında ve yazıcı bulunmuşken (yoksa sessizce atlanır) */}
          <div className="space-y-2 border-t border-[var(--admin-divider)] pt-3">
            <Toggle
              block
              checked={boot.settings.receiptDirect}
              disabled={savingOpt}
              onChange={(v) => void setOpt({ receiptDirect: v }, v ? 'Fişler doğrudan yazıcıya gidecek' : 'Fişler tarayıcının yazdırmasıyla basılacak')}
              label="Fişi doğrudan yazıcıya gönder (yazdırma penceresi açılmaz)"
              hint="ağdaki fiş yazıcısına (IP adresli port); ulaşılamazsa fiş tarayıcıdan basılır, kaybolmaz. Masa kartları hep tarayıcıdan"
            />
            <Toggle
              block
              checked={boot.settings.receiptStoreCopy}
              disabled={savingOpt}
              onChange={(v) => void setOpt({ receiptStoreCopy: v }, v ? 'Ödemeden sonra işyeri nüshası çıkacak' : 'İşyeri nüshası çıkmayacak')}
              label="Ödeme sonrası işyeri nüshası"
              hint="bar ve hazırlık için: adisyon no, kalemler ve seçenekler, toplam, ödeme türleri, yazarkasa fiş no"
            />
            <Toggle
              block
              checked={boot.settings.receiptInfoSlip}
              disabled={savingOpt}
              onChange={(v) => void setOpt({ receiptInfoSlip: v }, v ? 'Ödemeden sonra müşteri nüshası çıkacak' : 'Müşteri nüshası çıkmayacak')}
              label="Ödeme sonrası müşteri nüshası"
              hint="sipariş numarası çok büyük (çağrı için), kalemler; yazarkasa bağlıyken de basılır, “mali değeri yoktur” yazar"
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
