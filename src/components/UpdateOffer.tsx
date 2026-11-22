import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { onLive } from '@/lib/live';
import { toast } from '@/lib/toast';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

type Choice = 'simdi' | 'gunsonu';
interface Offer {
  durum: string | null;
  mesaj: string | null;
  yeni: { surum: string; build: number } | null;
  secim: Choice | null;
  dayOpen: boolean;
  canRequest: boolean;
  mesgul: boolean;
}

const KEY = ['guncelleme', 'teklif'];

/**
 * Kasada güncelleme teklifi (sahibin isteği, 22 Kas 2026): yeni sürüm indirilmiş ve gün açıkken bekliyorsa iki seçenek
 * sorulur. "Şimdi güncelle": satış ve ödeme yokken hemen kurulur, LafPOS kendiliğinden yeniden açılır ve herkes kaldığı
 * yerden devam eder (src/lib/buildWatch.ts). "Gün sonunda güncelle": gün kapatılınca kurulur (eski davranış). Seçim
 * sürüme bağlıdır ve kasada saklanır; Merkez'den "Güncellemeyi şimdi gönder" de aynı pencereyi çıkarır. Kasayı yöneten
 * (gün açıp kapatan) ya da ayar yetkisi olan görür
 */
export function UpdateOffer() {
  const can = useCan();
  const allowed = can('ayar.yonet') || can('kasa.gun');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => get<Offer>('/admin/guncelleme/teklif'),
    enabled: allowed,
    staleTime: 20_000,
    // Kurulum sürerken sık, değilse dakikada bir (bu bilgisayardaki dosyadan okunur, dışarıya istek gitmez)
    refetchInterval: (query) => (query.state.data?.secim === 'simdi' ? 5_000 : 60_000),
  });
  useEffect(() => {
    if (!allowed) return;
    return onLive((e) => {
      if (e.topic === 'settings' && e.kind === 'guncelleme') void qc.invalidateQueries({ queryKey: KEY });
    });
  }, [allowed, qc]);
  // "Sonra sor": bu cihazda bu sürüm için pencere kapatıldı (sayfa yenilenince yeniden sorulur)
  const [later, setLater] = useState<number | null>(null);
  const choose = useMutation({
    mutationFn: (secim: Choice) => post<Offer>('/admin/guncelleme/secim', { secim }),
    onSuccess: (d, secim) => {
      qc.setQueryData(KEY, d);
      if (secim === 'gunsonu') toast.ok('Güncelleme gün sonunda kurulacak');
    },
    onError: (e) => toast.err(errorMessage(e)),
  });

  const d = q.data;
  const installing = !!d?.yeni && d.secim === 'simdi' && (d.durum === 'bekliyor' || d.durum === 'kuruluyor' || d.durum === 'indiriliyor');
  // Kurulum başarısız olup eski sürüme dönüldüyse kasiyere söylenir (pencere kapanır, satış sürer)
  const wasInstalling = useRef(false);
  useEffect(() => {
    if (wasInstalling.current && !installing && d && (d.durum === 'geri-dondu' || d.durum === 'hata')) toast.err(d.mesaj || 'Güncelleme kurulamadı; eski sürüm çalışıyor');
    wasInstalling.current = installing;
  }, [installing, d]);

  if (!allowed || !d?.yeni) return null;
  const ask = d.durum === 'bekliyor' && d.dayOpen && d.secim == null && later !== d.yeni.build;
  if (!ask && !installing) return null;

  if (installing) {
    return (
      <Modal open onClose={() => undefined} persistent hideClose size="sm" title="Güncelleme kuruluyor">
        <div data-guncelleme className="flex items-start gap-3 text-sm leading-6 text-ink-2">
          <Loader2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 animate-spin text-[var(--admin-primary)] motion-reduce:animate-none" />
          <p role="status">
            {d.mesgul ? 'Satış ya da ödeme bitince kurulacak. ' : ''}
            LafPOS kısa süre kapanıp kendiliğinden yeniden açılır. Açık masalar, gönderilmemiş sepetler ve oturumunuz korunur; kaldığınız ekrandan devam edersiniz
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={() => setLater(d.yeni!.build)}
      persistent
      hideClose
      size="sm"
      title="Yeni sürüm hazır"
      subtitle={`LafPOS ${d.yeni.surum} indirildi. Ne zaman kurulsun?`}
      footer={
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <Button variant="secondary" block icon={<CalendarClock className="size-4" />} loading={choose.isPending && choose.variables === 'gunsonu'} disabled={choose.isPending} onClick={() => choose.mutate('gunsonu')}>
            Gün sonunda güncelle
          </Button>
          <Button variant="primary" block icon={<Download className="size-4" />} loading={choose.isPending && choose.variables === 'simdi'} disabled={choose.isPending || !d.canRequest} onClick={() => choose.mutate('simdi')}>
            Şimdi güncelle
          </Button>
        </div>
      }
    >
      <div data-guncelleme className="grid gap-2 text-sm leading-6 text-ink-2">
        <p>
          <strong className="font-semibold text-ink">Şimdi güncelle:</strong> LafPOS bir dakika kadar kapanıp kendiliğinden açılır. Açık masalar, sepetler ve oturum korunur. Satış ya da ödeme sürerken kurulmaz
        </p>
        <p>
          <strong className="font-semibold text-ink">Gün sonunda güncelle:</strong> gün kapatılınca (Z raporundan sonra) kurulur
        </p>
        {!d.canRequest && <p className="text-xs text-muted">Bu kurulumda otomatik güncelleyici yok; sürüm elle kurulur</p>}
      </div>
    </Modal>
  );
}
