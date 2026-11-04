import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bike, PackageCheck, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { AUTO_SKIP_PREFIX, COURIER_LABEL, PLATFORM_LABEL, type PlatformLiveStatus, type PlatformOrderDTO, type PlatformSettings, type PlatformId, REJECT_REASONS } from '@shared/platforms';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Notice } from '@/components/ui/misc';
import { ApiError, errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { beep } from '@/lib/sound';
import { toast } from '@/lib/toast';
import { PlatformBadge } from './PlatformBadge';

export interface PlatformsData {
  /** Komisyon oranı yalnız maliyeti gören ya da ayarı yöneten kişiye gelir (garson ve raporcu almaz) */
  settings: Record<PlatformId, Omit<PlatformSettings, 'commissionPct'> & { commissionPct?: number }>;
  orders: PlatformOrderDTO[];
  /** Canlı bağlantı durumu (eski sunucu göndermez) */
  live?: Record<PlatformId, PlatformLiveStatus>;
  /** Otomatik kabulde kabul eden olarak seçilebilecek kişiler: etkin ve paket yetkili (eski sunucu göndermez) */
  acceptors?: { id: string; name: string }[];
}

export function usePlatforms(enabled = true) {
  return useQuery({ queryKey: ['platforms'], queryFn: () => get<PlatformsData>('/platforms'), enabled, refetchInterval: 30_000 });
}

const left = (expiresAt: number | null, now: number) => {
  if (expiresAt == null) return null;
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Son dakika: geri sayım kırmızı (süre dolunca sipariş platformda iptal olur, Getir restoranı kapatır) */
const URGENT_MS = 60_000;

/**
 * Kabul süresinin geri sayımı: saatle karışmasın diye kum saati ve "kaldı" (şeritte "14:58" raydaki saat 14:14'ün
 * yanında saat sanılıyordu); son dakikada kırmızı. `short`: telefonun dar şeridinde "kaldı" yalnız ekran okuyucuya
 * (saat orada yok; asıl ileti "onay bekliyor" kırpılmasın)
 */
function Countdown({ expiresAt, now, calm = 'text-ink-2', short, className }: { expiresAt: number; now: number; calm?: string; short?: boolean; className?: string }) {
  return (
    <span className={cn('tabular inline-flex shrink-0 items-center gap-1 font-semibold', expiresAt - now < URGENT_MS ? 'text-danger-ink' : calm, className)}>
      <Timer aria-hidden="true" className="size-4" />
      {left(expiresAt, now)}
      <span className={cn(short && 'max-sm:sr-only')}> kaldı</span>
    </span>
  );
}

/** Kartın içindeki uyarı: Notice'in sıkı ölçüsü (pencerede 13 px) */
const NOTE = 'mt-2 px-3 py-2 text-[13px]';

/**
 * Paket platformlarından onay bekleyen siparişler: her ekranın üstünde şerit, dokununca kabul / ret. Platformun kabul
 * süresi geri sayılır (Getir 5 dk, Yemeksepeti ~15 dk); süre dolunca sipariş platformda iptal olur.
 */
export function PlatformInbox() {
  const can = useCan();
  const allowed = can('paket.yonet');
  const data = usePlatforms(allowed);
  const [open, setOpen] = useState(false);
  const now = useTick(1000);

  useEffect(() => {
    if (!allowed) return;
    return onLive((e) => {
      if (e.topic === 'delivery' && e.kind === 'platform.new') {
        beep('yeni');
        if (e.message) toast.info(e.message);
      }
      // Otomatik kabul: bildirim yalnız onda gelir (elle kabul eden zaten ekranda)
      if (e.topic === 'delivery' && e.kind === 'platform.accepted' && e.message) toast.ok(e.message);
    });
  }, [allowed]);

  // Onay bekleyenler ve platformun iptal ettiği ama kasada ödemesi olan (ödeme geri alınınca kendiliğinden kapanır)
  const all = data.data?.orders ?? [];
  // Önce onay bekleyenler, süresi en yakın olan başta; sonra platformun iptal ettiği ama kasada ödemesi olanlar
  const due = (o: PlatformOrderDTO) => (o.announced || o.payload.preAccepted || o.expiresAt == null ? Number.MAX_SAFE_INTEGER : o.expiresAt);
  const waitingOrders = all.filter((o) => o.status === 'bekliyor').sort((a, b) => due(a) - due(b));
  const cancelOrders = all.filter((o) => o.status !== 'bekliyor' && o.cancelPending);
  const pending = [...waitingOrders, ...cancelOrders];
  if (!allowed || !pending.length) return null;
  const first = pending[0]!;
  const waiting = waitingOrders.length;
  return (
    <>
      {/* Şerit: telefonda üst şeridin altında tam genişlik; tablet ve bilgisayarda ekranın kartları gibi yuvarlak, altında
          boşlukla (bar kartına yapışıktı). Yazı mürekkepte, renk ikonda ve geri sayımda (kitin Notice dili) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full shrink-0 items-center gap-2 border-b border-warning-line bg-warning-soft px-4 py-1.5 text-left text-sm text-ink transition-[filter] duration-150 hover:brightness-[0.98] active:brightness-95 md:mb-3 md:rounded-2xl md:border"
      >
        <Bell aria-hidden="true" className="size-4 shrink-0 text-warning-ink" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {waiting === 0 ? 'Platform iptal etti: kasadaki ödemeyi geri alın' : waiting === 1 ? 'Platform siparişi onay bekliyor' : `${waiting} platform siparişi onay bekliyor`}
          {waiting > 0 && cancelOrders.length > 0 && <span className="font-normal"> · {cancelOrders.length} iptal: ödemeyi geri alın</span>}
          <span className="font-normal text-ink-2 max-sm:hidden">
            {' '}
            · {PLATFORM_LABEL[first.platform]} {first.payload.code} · {tl(first.payload.customerTotal)}
          </span>
        </span>
        {first.expiresAt && first.status === 'bekliyor' && !first.announced && !first.payload.preAccepted && <Countdown expiresAt={first.expiresAt} now={now} calm="text-warning-ink" short />}
        <span className="shrink-0 font-semibold underline underline-offset-2">Gör</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={waiting && cancelOrders.length ? 'Platform siparişleri' : waiting ? 'Onay bekleyen platform siparişleri' : 'Platformun iptal ettiği siparişler'} size="md">
        <div className="space-y-3 p-4">
          {pending.map((o) => (
            <PendingCard key={o.id} order={o} now={now} defaultPrep={data.data?.settings[o.platform].prepMinutes ?? 20} onDone={() => pending.length === 1 && setOpen(false)} />
          ))}
        </div>
      </Modal>
    </>
  );
}

function PendingCard({ order, now, defaultPrep, onDone }: { order: PlatformOrderDTO; now: number; defaultPrep: number; onDone: () => void }) {
  const qc = useQueryClient();
  const canClose = useCan()('siparis.iptal');
  const [prep, setPrep] = useState(defaultPrep);
  const [rejecting, setRejecting] = useState(false);
  // Ret iki adım: neden seçilir, adı konmuş kırmızı düğme gönderir (yanlış dokunuş ödenmiş siparişi geri dönüşsüz reddetmesin)
  const [reason, setReason] = useState<(typeof REJECT_REASONS)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  // Reddet otomatik kabulün platform çağrısına denk geldi (409 `auto_accepting`): ret gitmedi. Hata değil, kartta bilgi;
  // kaydın notu değişince (otomatik kabul edilmedi) eskir
  const [autoNote, setAutoNote] = useState<{ text: string; lastError: string | null } | null>(null);
  const p = order.payload;
  const preps = [...new Set([10, 15, 20, 30, 45, defaultPrep])].sort((a, b) => a - b);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'auto_accepting') {
        setRejecting(false);
        setAutoNote({ text: e.message, lastError: order.lastError ?? null });
        // Kabul edilince kart kapanır: ileti bildirimde de kalır
        toast.info(e.message);
      } else toast.err(errorMessage(e));
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    }
  };
  // Platform kabul etti, adisyon açılamadı: süre işlemez, Kabul yalnız adisyonu açmayı yeniden dener
  const expiresAt = order.announced || order.cancelPending || p.preAccepted ? null : order.expiresAt;
  return (
    <section className="rounded-xl border border-line p-3">
      {/* Üst satır kim ve ne kadar süre kaldı; altında ayrıntı. Geliş saati adıyla: geri sayımla iki çıplak saat yan yana
          duruyordu */}
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={order.platform} code={p.code} />
        {p.scheduledFor && (
          <Badge tone="warning">İleri tarihli · {new Date(p.scheduledFor).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Badge>
        )}
        <span className="flex-1" />
        {expiresAt != null && <Countdown expiresAt={expiresAt} now={now} className="text-sm" />}
      </div>
      <p className="mt-1.5 text-sm text-muted">
        {p.courier === 'platform' ? <Bike aria-hidden="true" className="mr-1 inline size-4 align-[-3px]" /> : <PackageCheck aria-hidden="true" className="mr-1 inline size-4 align-[-3px]" />}
        {COURIER_LABEL[p.courier]} · {p.paymentLabel} · geliş {fmtTime(p.placedAt)}
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {p.lines.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className="tabular w-7 shrink-0 font-semibold">{l.qty}×</span>
            <span className="min-w-0 flex-1">
              {l.name}
              {(l.modifiers.length > 0 || l.note) && <span className="block text-xs text-muted">{[...l.modifiers, l.note].filter(Boolean).join(' · ')}</span>}
            </span>
            <span className="tabular shrink-0 text-ink-2">{tl(l.unitPrice * l.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-sm">
        {p.restaurantDiscount > 0 && <Row l="Kampanya (bizden)" r={`−${tl(p.restaurantDiscount)}`} />}
        {p.platformDiscount > 0 && <Row l="Kampanya (platformdan)" r={`−${tl(p.platformDiscount)}`} />}
        <Row l="Müşteri öder" r={tl(p.customerTotal)} strong />
      </div>
      {(p.customer.name || p.note || p.customer.address) && (
        <p className="mt-2 text-xs text-muted">{[p.customer.name, p.customer.address, p.customer.phone, p.note].filter(Boolean).join(' · ')}</p>
      )}
      {/* Uyarılar kitin Notice'i: yumuşak zemin ve durum çizgisi, yazı mürekkepte, renk ikonda */}
      {order.unmatched.length > 0 && (
        <Notice tone="warn" className={NOTE}>
          Kasada karşılığı olmayan: {order.unmatched.join(', ')}. Kabulde "Platform ürünü" satırı olur, adı notta yazar
        </Notice>
      )}
      {order.soldOut.length > 0 && (
        <Notice tone="danger" className={NOTE}>
          Kasada tükenmiş: {order.soldOut.join(', ')}. Ürünü satışa açın ya da "Ürün tükendi" ile reddedin
        </Notice>
      )}
      {autoNote && autoNote.lastError === (order.lastError ?? null) && (
        <Notice tone="info" role="status" className={NOTE}>
          {autoNote.text}
        </Notice>
      )}
      {/* Otomatik kabul edilmedi: hata değil, nedeni ve elle kabul bekliyor */}
      {order.lastError?.startsWith(AUTO_SKIP_PREFIX) ? (
        <Notice tone="info" className={NOTE}>
          {order.lastError}
        </Notice>
      ) : (
        order.lastError && (
          <Notice tone="danger" role="alert" className={NOTE}>
            {order.lastError}
          </Notice>
        )
      )}
      {order.cancelPending ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-ink-2">
            {PLATFORM_LABEL[order.platform]} bu siparişi iptal etti{order.orderNo ? `; adisyon #${order.orderNo}` : ''}. Kasada alınan ödemeyi yetkili onayıyla geri alın: adisyon kendiliğinden iptal olur
          </p>
          {canClose && (
            <Button size="sm" disabled={busy} onClick={() => run(() => post(`/platforms/orders/${order.id}/cancel-close`), 'İptal kayda alındı; hesabı elle düzeltin')}>
              Ödeme geri alınamıyor: iptali kayda al
            </Button>
          )}
        </div>
      ) : rejecting ? (
        <div className="mt-3 space-y-2.5">
          <p className="text-sm font-medium">Neden reddediyorsunuz?</p>
          {/* Hazır neden ve süre kitin mürekkep çipi (adisyondaki iptal ve indirim nedeniyle aynı): seçili tikli */}
          <div role="group" aria-label="Ret nedeni" className="flex flex-wrap gap-1.5">
            {REJECT_REASONS.map((r) => (
              <Chip key={r} tone="ink" on={reason === r} disabled={busy} onClick={() => setReason(r)}>
                {r}
              </Chip>
            ))}
          </div>
          {/* Onay penceresinin dili: Vazgeç ve eylemi adlandıran kırmızı düğme; neden seçilmeden gitmez */}
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => setRejecting(false)}>
              Vazgeç
            </Button>
            <Button variant="danger" disabled={!reason} loading={busy} onClick={() => reason && run(() => post(`/platforms/orders/${order.id}/reject`, { reason }), 'Sipariş reddedildi')}>
              Siparişi reddet
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {!order.announced && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Hazırlık süresi">
              <span className="mr-1 text-sm text-muted">Hazırlık</span>
              {preps.map((m) => (
                <Chip key={m} tone="ink" on={prep === m} onClick={() => setPrep(m)}>
                  {m} dk
                </Chip>
              ))}
            </div>
          )}
          {p.test && <p className="text-xs text-muted">Platformun test siparişi: mutfağa düşmesin diye kabul edilmez, yalnız reddedilir</p>}
          {p.preAccepted && <p className="text-xs text-muted">Platformun tabletinde kabul edildi: Kabul adisyonu açar; ret ve iptal tabletten yapılır</p>}
          <div className={cn('grid gap-2', !p.test && !p.preAccepted ? 'grid-cols-2' : 'grid-cols-1')}>
            {!p.preAccepted && (
              <Button
                disabled={busy}
                onClick={() => {
                  setReason(null);
                  setRejecting(true);
                }}
              >
                Reddet
              </Button>
            )}
            {!p.test && (
              <Button variant="primary" loading={busy} onClick={() => run(() => post(`/platforms/orders/${order.id}/accept`, { prepMinutes: prep }), `${PLATFORM_LABEL[order.platform]} ${p.code} kabul edildi`)}>
                {order.announced || p.preAccepted ? 'Adisyonu aç' : `Kabul et · ${prep} dk`}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ l, r, strong }: { l: string; r: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between', strong && 'font-semibold')}>
      <span>{l}</span>
      <span className="tabular">{r}</span>
    </div>
  );
}
