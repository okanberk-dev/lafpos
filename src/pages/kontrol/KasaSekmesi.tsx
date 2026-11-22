import { useState } from 'react';
import { SERVICE_MODE_HINT, SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode } from '@shared/service-mode';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Badge, Card } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { BekliyorRozeti, KasaGuncelDegil, NEDEN, NOT, type SekmeProps } from './ortak';

/**
 * Kasa: servis modu (Yönetim › Ayarlar › Servis modu'nun uzaktaki hâli; `ayar.servis`). Seçim gönderilene dek yalnız
 * ekranda; bekleyen istek "Bekliyor" rozetiyle görünür, kasa uygulayınca özet yeni modu getirir
 */
export function KasaSekmesi({ panel, durum, genel, neden, bekleyen, gonder }: SekmeProps) {
  const [secim, setSecim] = useState<ServiceMode | null>(null);
  const [bekle, setBekle] = useState(false);
  if (!durum) return <KasaGuncelDegil bagli={panel.kasa !== null} />;
  const isler = bekleyen.get('servis');
  const istenen = isler?.at(-1)?.hedef.mod;
  const simdiki = durum.servisModu;
  // Ekranda seçili görünen: elle seçilen, yoksa bekleyen istek, yoksa kasadaki mod
  const hedef = istenen ?? simdiki;
  const gorunen = secim ?? hedef;
  const kapali = neden('ayar.servis');

  const uygula = async () => {
    if (!secim || secim === hedef || bekle) return;
    const ok = await confirmDialog({
      title: `Servis modu “${SERVICE_MODE_LABEL[secim]}” olsun mu`,
      body: 'Kasa en geç 5 dakikada geçer; açılış ekranı, menü ve tezgâh satışının akışı buna göre değişir',
      confirmLabel: 'Servis modunu değiştir',
      tone: 'primary',
    });
    if (!ok) return;
    setBekle(true);
    try {
      await gonder({ tur: 'ayar.servis', veri: { mod: secim } });
      setSecim(null);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBekle(false);
    }
  };

  return (
    <Card
      title="Servis modu"
      subtitle="İşletmenin siparişi nasıl aldığı: açılış ekranı, menü ve tezgâh satışının akışı"
      actions={
        <Button variant="primary" disabled={!!kapali || !secim || secim === hedef} title={kapali ?? undefined} loading={bekle} onClick={() => void uygula()}>
          Servis modunu değiştir
        </Button>
      }
    >
      {kapali && kapali !== genel && <p className={cn('border-b border-[var(--admin-divider)] px-5 py-2.5', NEDEN)}>{kapali}</p>}
      <fieldset className="grid gap-2 p-5 sm:grid-cols-2" disabled={!!kapali}>
        <legend className="sr-only">Servis modu</legend>
        {SERVICE_MODES.map((m) => {
          const on = gorunen === m;
          return (
            <label
              key={m}
              className={cn(
                'flex min-h-11 items-start gap-3 rounded-[var(--r-tile)] border px-4 py-3 transition-colors duration-150',
                on ? 'border-[var(--admin-primary)] bg-[var(--admin-primary-soft)]' : 'border-[var(--admin-border)] bg-surface',
                kapali ? 'cursor-default' : 'cursor-pointer hover:border-[var(--admin-border-strong)]',
              )}
            >
              <input type="radio" name="servis-modu" value={m} checked={on} onChange={() => setSecim(m)} className="mt-0.5 size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-ink">{SERVICE_MODE_LABEL[m]}</span>
                  {m === simdiki && <Badge>Kasada şu an</Badge>}
                  {m === istenen && m !== simdiki && <BekliyorRozeti isler={isler} />}
                </span>
                <span className="mt-0.5 block text-pretty text-[13px] leading-5 text-muted">{SERVICE_MODE_HINT[m]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className={cn('border-t border-[var(--admin-divider)] px-5 py-3', NOT)}>Ödeme kuralları ve bara gidiş her modda aynıdır; değişen açılış ekranı, menü ve tezgâh satışının akışıdır</p>
    </Card>
  );
}
