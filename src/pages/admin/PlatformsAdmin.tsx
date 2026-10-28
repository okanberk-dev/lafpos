import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, ChevronRight, PackageSearch, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { tl } from '@shared/money';
import {
  AUTO_ACCEPT_MAX_DEFAULT,
  AUTO_ACCEPT_MAX_LIMIT,
  PLATFORM_LABEL,
  PLATFORM_MODE_LABEL,
  PLATFORM_STATUS_LABEL,
  PLATFORMS,
  type PlatformId,
  type PlatformLiveStatus,
  type PlatformMode,
  type PlatformProductDTO,
  type PlatformSettings,
} from '@shared/platforms';
import { fmtDateTime, fmtTime } from '@shared/time';
import { Badge, Card, CARD, CODE, EmptyState, PageHeader, Segmented } from '@/components/admin/ui';
import { PlatformBadge } from '@/components/PlatformBadge';
import { type PlatformsData, usePlatforms } from '@/components/PlatformInbox';
import { Button } from '@/components/ui/Button';
import { Field, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { ErrorState, ListSkeleton, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { toast } from '@/lib/toast';

/** Ayar adları kitin eş genişlikli kodu (`CODE`) ile, virgülle */
function Env({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && ', '}
          <code className={CODE}>{n}</code>
        </span>
      ))}
    </>
  );
}

/**
 * Gerçek bağlantı için gerekenler (calisma/arastirma/paket-platformlari, 27 Ekim 2026; docs/PAKET-PLATFORMLARI.md).
 * Kartın ana akışında değil, "Gerçek bağlantı için ne gerekir" açılırında; anahtarı tamam canlı platformda gösterilmez.
 */
const LIVE_NEEDS: Record<PlatformId, ReactNode> = {
  yemeksepeti: (
    <>
      Delivery Hero’dan POS entegrasyonu: middleware adresi, kullanıcı adı, parola, restoranın POS kimliği ve JWT anahtarı. Kasa bilgisayarının{' '}
      <code className={CODE}>.env</code> dosyasına <Env names={['YEMEKSEPETI_MW_URL', 'YEMEKSEPETI_USERNAME', 'YEMEKSEPETI_PASSWORD', 'YEMEKSEPETI_REMOTE_ID']} />, Vercel’e{' '}
      <Env names={['YEMEKSEPETI_PLUGIN_SECRET']} /> yazılır; LafPOS yeniden başlatılınca Canlı seçilir. Siparişler LafPOS Uzaktan’a gelir, kasa 20 saniyede bir çeker.
    </>
  ),
  getir: (
    <>
      Getir’den POS entegrasyonu: test ve canlı için uygulama anahtarı ve restoran anahtarı. Kasa bilgisayarının <code className={CODE}>.env</code> dosyasına{' '}
      <Env names={['GETIR_APP_SECRET_KEY', 'GETIR_RESTAURANT_SECRET_KEY']} /> (test ortamı için <Env names={['GETIR_API_URL']} />), Vercel’e bizim ürettiğimiz{' '}
      <Env names={['GETIR_WEBHOOK_SECRET']} /> yazılır; Getir’e sipariş ve iptal adresleri bu anahtarla verilir. LafPOS yeniden başlatılınca Canlı seçilir. Siparişler
      LafPOS Uzaktan’a gelir, kasa 20 saniyede bir çeker, yedek olarak Getir’den de okur. Getir’in yemek işi Uber’e geçti: siparişler ileride Trendyol Go’dan da
      gelebilir.
    </>
  ),
  trendyol: (
    <>
      Satıcı panelinden satıcı no, API anahtarı ve gizli anahtar kasa bilgisayarının <code className={CODE}>.env</code> dosyasına (
      <Env names={['TRENDYOL_SUPPLIER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET']} />) yazılır; LafPOS yeniden başlatılınca Canlı seçilir. Uber Eats Türkiye
      siparişleri de buradan gelir, kasa 20 saniyede bir yoklar.
    </>
  ),
  migros: 'Belgeler herkese açık değil; Migros Yemek ile görüşme gerekir.',
};

const MODE_TONE: Record<PlatformMode, 'neutral' | 'info' | 'success'> = { kapali: 'neutral', deneme: 'info', canli: 'success' };

export default function PlatformsAdmin() {
  const data = usePlatforms();
  const can = useCan();
  const header = <PageHeader title="Paket platformları" description="Platform siparişleri kasaya düşer, onaylanınca bara gider; tahsilat platformda" />;
  if (!data.data)
    return (
      <>
        {header}
        {data.isError ? (
          <ErrorState className={CARD} title="Platform durumu alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="grid items-start gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-52 rounded-2xl" />
            ))}
          </div>
        )}
      </>
    );
  const recent = data.data.orders.filter((o) => o.status !== 'bekliyor').slice(0, 20);
  return (
    <>
      {header}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {PLATFORMS.map((p) => (
          <PlatformCard
            key={p}
            platform={p}
            settings={data.data!.settings[p]}
            live={data.data!.live?.[p]}
            acceptors={data.data!.acceptors ?? []}
            canEdit={can('senkron.yonet') || can('ayar.yonet')}
            canTest={can('paket.yonet')}
          />
        ))}
      </div>
      <ProductMapping canEdit={can('menu.yonet') || can('senkron.yonet')} />
      <Card title="Son 12 saat" subtitle="Kabul, ret ve platform iptalleri" className="mt-4" flush>
        {recent.length === 0 ? (
          <EmptyState bare icon={<Bike />} title="Son 12 saatte platform siparişi yok">
            Kabul edilen ya da reddedilen siparişler burada listelenir
          </EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--admin-divider)]">
            {recent.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <PlatformBadge platform={o.platform} code={o.payload.code} />
                <span className="tabular text-[var(--admin-text-mute)]">{fmtTime(o.receivedAt)}</span>
                <span className="tabular">{tl(o.payload.customerTotal)}</span>
                <span className="flex-1" />
                <Badge tone={o.status === 'kabul' ? 'success' : o.status === 'ret' ? 'warning' : 'neutral'}>{PLATFORM_STATUS_LABEL[o.status]}</Badge>
                {o.reason && <span className="text-xs text-[var(--admin-text-mute)]">{o.reason}</span>}
                {o.decidedBy && <span className="text-xs text-[var(--admin-text-mute)]">{o.decidedBy}</span>}
                {o.lastError && <span className="w-full text-xs text-[var(--admin-danger-ink)]">{o.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Ürün eşleme: platformdan gelen her kalem (kimliğiyle) burada; eşlenmeyen ada göre eşlenir, kasada yoksa "Platform ürünü" olur */
function ProductMapping({ canEdit }: { canEdit: boolean }) {
  const boot = useBoot();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platforms', 'products'], queryFn: () => get<{ products: PlatformProductDTO[] }>('/platforms/products') });
  const rows = q.data?.products ?? [];
  // Menüde gizli ürün de seçilebilir (eşleme onu açar); kasada karşılığı olmayan kalemin gizli satırı hariç
  const products = [...boot.products].filter((p) => p.posName !== 'PLATFORM ÜRÜNÜ').sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, 'tr'));
  const save = async (row: PlatformProductDTO, productId: string | null) => {
    try {
      await put(`/platforms/products/${row.id}`, { productId });
      qc.invalidateQueries({ queryKey: ['platforms'] });
      toast.ok(productId ? `${row.name} eşlendi` : `${row.name} eşlemesi kaldırıldı`);
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const unmatched = rows.filter((r) => !r.productId).length;
  return (
    <Card title="Ürün eşleme" subtitle="Platformdan gelen kalem kasadaki ürüne bağlanır; bağlanmayan ada göre eşlenir, kasada yoksa kabulde “Platform ürünü” satırı olur" className="mt-4" flush actions={unmatched > 0 ? <Badge tone="warning">{unmatched} eşlenmemiş</Badge> : undefined}>
      {q.isPending ? (
        <ListSkeleton rows={3} />
      ) : q.isError && !q.data ? (
        <ErrorState compact title="Platform ürünleri alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState bare icon={<PackageSearch />} title="Henüz platformdan ürün gelmedi">
          İlk siparişle gelen ürünleri burada kasadaki ürünlerle eşleştirirsiniz
        </EmptyState>
      ) : (
        <ul className="divide-y divide-[var(--admin-divider)]">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <PlatformBadge platform={r.platform} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.name}</span>
                <span className="block truncate text-xs text-[var(--admin-text-mute)]">#{r.externalId} · son {fmtTime(r.lastSeenAt)}</span>
              </span>
              <label className="w-full sm:w-64">
                <span className="sr-only">{r.name} için kasadaki ürün</span>
                <Select value={r.productId ?? ''} disabled={!canEdit} onChange={(e) => void save(r, e.target.value || null)} className="[[data-area=admin]_&]:pointer-fine:h-9">
                  <option value="">Ada göre eşlenir</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.hidden ? `${p.name} (menüde gizli)` : p.name}
                    </option>
                  ))}
                </Select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PlatformCard({
  platform,
  settings,
  live,
  acceptors,
  canEdit,
  canTest,
}: {
  platform: PlatformId;
  settings: PlatformsData['settings'][PlatformId];
  live?: PlatformLiveStatus;
  acceptors: { id: string; name: string }[];
  canEdit: boolean;
  canTest: boolean;
}) {
  const qc = useQueryClient();
  const boot = useBoot();
  const [testing, setTesting] = useState(false);
  // Seçilen kişi sonradan kapatıldıysa ya da yetkisi alındıysa listede adıyla durur: otomatik kabul onun adına çalışmaz
  const acceptorId = settings.autoAcceptUserId ?? '';
  const staleAcceptor = acceptorId && !acceptors.some((a) => a.id === acceptorId) ? (boot.users.find((u) => u.id === acceptorId)?.name ?? 'Silinmiş kişi') : null;
  const save = async (patch: Partial<PlatformSettings>) => {
    try {
      await put(`/platforms/${platform}`, patch);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
      toast.ok(`${PLATFORM_LABEL[platform]} kaydedildi`);
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const res = await post<{ id: string; autoAccepted?: boolean }>(`/platforms/${platform}/test-order`);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      toast.ok(res.autoAccepted ? 'Deneme siparişi geldi ve otomatik kabul edildi' : 'Deneme siparişi geldi: üstteki şeritten onaylayın');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card title={<PlatformBadge platform={platform} />} actions={<Badge tone={MODE_TONE[settings.mode]} dot>{PLATFORM_MODE_LABEL[settings.mode]}</Badge>}>
      <div className="space-y-3">
        <Segmented
          label={`${PLATFORM_LABEL[platform]} modu`}
          value={settings.mode}
          onChange={(mode) => canEdit && save({ mode })}
          options={[
            { value: 'kapali', label: 'Kapalı' },
            { value: 'deneme', label: 'Deneme' },
            ...(live?.supported ? [{ value: 'canli' as const, label: 'Canlı' }] : []),
          ]}
        />
        {live?.supported && !live.configured && <p className="text-xs text-[var(--admin-warning)]">Canlı bağlantının anahtarları bu kasada tanımlı değil</p>}
        {settings.mode === 'canli' && live && (
          <p className={live.lastError ? 'text-xs text-[var(--admin-danger-ink)]' : 'text-xs text-[var(--admin-success)]'}>
            {live.lastError ?? (live.lastPollAt ? `Son yoklama ${fmtDateTime(live.lastPollAt)}` : 'Henüz yoklanmadı')}
            {live.openOrders > 0 && ` · ${live.openOrders} açık sipariş`}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hazırlık süresi (dk)" hint="5–120">
            <NumberInput value={settings.prepMinutes} min={5} max={120} fallback={20} disabled={!canEdit} onCommit={(prepMinutes) => void save({ prepMinutes })} />
          </Field>
          {/* Oran maliyettir: yalnız ayarı yöneten ya da maliyeti gören alır (sunucu ötekilere göndermez) */}
          {settings.commissionPct != null && (
            <Field label="Tahmini komisyon (%)" hint="0–60">
              <NumberInput decimals={2} value={settings.commissionPct} min={0} max={60} fallback={0} disabled={!canEdit} onCommit={(commissionPct) => void save({ commissionPct })} />
            </Field>
          )}
        </div>
        <div className="space-y-3 border-t border-[var(--admin-divider)] pt-3">
          <Toggle
            block
            checked={settings.autoAccept}
            disabled={!canEdit}
            onChange={(autoAccept) => void save({ autoAccept })}
            label="Otomatik kabul"
            hint="Yalnız Canlı modda; tutarı tutan, bütün ürünleri eşleşmiş, ödemesi platformda alınmış siparişler. Diğerleri elle kabul bekler"
          />
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="Kabul eden">
              <Select value={acceptorId} disabled={!canEdit} onChange={(e) => void save({ autoAcceptUserId: e.target.value || null })}>
                <option value="">Seçilmedi</option>
                {acceptors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {staleAcceptor && <option value={acceptorId}>{staleAcceptor} (etkin değil ya da yetkisiz)</option>}
              </Select>
            </Field>
            <Field label="En yüksek tutar (₺)">
              <NumberInput
                value={Math.round(settings.autoAcceptMaxKurus / 100)}
                min={1}
                max={AUTO_ACCEPT_MAX_LIMIT / 100}
                fallback={AUTO_ACCEPT_MAX_DEFAULT / 100}
                disabled={!canEdit}
                onCommit={(lira) => void save({ autoAcceptMaxKurus: lira * 100 })}
              />
            </Field>
          </div>
          {settings.autoAccept && staleAcceptor && <p className="text-xs text-[var(--admin-warning)]">Kabul eden kişi etkin değil ya da paket yetkisi yok: siparişler elle kabul bekler</p>}
          {settings.autoAccept && settings.mode === 'deneme' && <p className="text-xs text-[var(--admin-text-mute)]">Deneme modunda deneme siparişleri de otomatik kabul edilir; platforma bir şey gitmez</p>}
        </div>
        {settings.mode === 'deneme' && canTest && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button variant="soft" icon={<Send className="size-4" />} loading={testing} onClick={() => void test()}>
              Deneme siparişi gönder
            </Button>
            <span className="text-xs text-[var(--admin-text-mute)]">Deneme siparişi gerçek satış gibi ciroya girer</span>
          </div>
        )}
        {/* Kurulum metni yalnız henüz canlı olmayan (ya da canlıda anahtarı eksik) platformda */}
        {(settings.mode !== 'canli' || (live?.supported && !live.configured)) && (
          <details className="group text-xs">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-[var(--admin-primary)] pointer-fine:min-h-0 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              Gerçek bağlantı için ne gerekir
            </summary>
            <p className="mt-1.5 text-[var(--admin-text-mute)]">{LIVE_NEEDS[platform]}</p>
          </details>
        )}
      </div>
    </Card>
  );
}
