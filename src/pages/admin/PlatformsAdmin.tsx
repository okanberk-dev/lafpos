import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { tl } from '@shared/money';
import { PLATFORM_LABEL, PLATFORM_MODE_LABEL, PLATFORM_STATUS_LABEL, PLATFORMS, type PlatformId, type PlatformLiveStatus, type PlatformMode, type PlatformProductDTO, type PlatformSettings } from '@shared/platforms';
import { fmtDateTime, fmtTime } from '@shared/time';
import { Badge, BTN, Card, CODE, PageHeader, Segmented } from '@/components/admin/ui';
import { PlatformBadge } from '@/components/PlatformBadge';
import { usePlatforms } from '@/components/PlatformInbox';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
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
      Delivery Hero'dan POS entegrasyonu: middleware adresi, kullanıcı adı, parola, restoranın POS kimliği ve JWT anahtarı. Kasa bilgisayarının{' '}
      <code className={CODE}>.env</code> dosyasına <Env names={['YEMEKSEPETI_MW_URL', 'YEMEKSEPETI_USERNAME', 'YEMEKSEPETI_PASSWORD', 'YEMEKSEPETI_REMOTE_ID']} />, Vercel'e{' '}
      <Env names={['YEMEKSEPETI_PLUGIN_SECRET']} /> yazılır; LafPOS yeniden başlatılınca Canlı seçilir. Siparişler LafPOS Uzaktan'a gelir, kasa 20 saniyede bir çeker.
    </>
  ),
  getir: "Getir geliştirici portalından POS başvurusu; test ve canlı anahtar. Getir yemek işi Uber'e geçti, yol Trendyol Go'ya dönebilir.",
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
  if (data.isLoading || !data.data) return <PageLoading />;
  const recent = data.data.orders.filter((o) => o.status !== 'bekliyor').slice(0, 20);
  return (
    <>
      <PageHeader
        title="Paket platformları"
        description="Platform siparişleri kasaya düşer, onaylanınca bara gider; tahsilat platformda"
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {PLATFORMS.map((p) => (
          <PlatformCard key={p} platform={p} settings={data.data!.settings[p]} live={data.data!.live?.[p]} canEdit={can('senkron.yonet') || can('ayar.yonet')} canTest={can('paket.yonet')} />
        ))}
      </div>
      <ProductMapping canEdit={can('menu.yonet') || can('senkron.yonet')} />
      <Card title="Son 12 saat" subtitle="Kabul, ret ve platform iptalleri" className="mt-4" flush>
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--admin-text-mute)]">Henüz platform siparişi yok</p>
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
    <Card title="Ürün eşleme" subtitle={'Platformdan gelen kalem kasadaki ürüne bağlanır; bağlanmayan ada göre eşlenir, kasada yoksa kabulde "Platform ürünü" satırı olur'} className="mt-4" flush actions={unmatched > 0 ? <Badge tone="warning">{unmatched} eşlenmemiş</Badge> : undefined}>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[var(--admin-text-mute)]">Henüz platformdan kalem gelmedi</p>
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
                <Select value={r.productId ?? ''} disabled={!canEdit} onChange={(e) => void save(r, e.target.value || null)} className="text-sm pointer-fine:h-9">
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

function PlatformCard({ platform, settings, live, canEdit, canTest }: { platform: PlatformId; settings: PlatformSettings; live?: PlatformLiveStatus; canEdit: boolean; canTest: boolean }) {
  const qc = useQueryClient();
  const [prep, setPrep] = useState(String(settings.prepMinutes));
  const [commission, setCommission] = useState(String(settings.commissionPct));
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
    try {
      await post(`/platforms/${platform}/test-order`);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      toast.ok('Deneme siparişi geldi: üstteki şeritten onaylayın');
    } catch (e) {
      toast.err(errorMessage(e));
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
          <Field label="Hazırlık süresi (dk)">
            <Input type="number" min={5} max={120} value={prep} disabled={!canEdit} onChange={(e) => setPrep(e.target.value)} onBlur={() => Number(prep) !== settings.prepMinutes && save({ prepMinutes: Math.min(120, Math.max(5, Number(prep) || 20)) })} />
          </Field>
          <Field label="Tahmini komisyon (%)">
            <Input type="number" min={0} max={60} value={commission} disabled={!canEdit} onChange={(e) => setCommission(e.target.value)} onBlur={() => Number(commission) !== settings.commissionPct && save({ commissionPct: Math.min(60, Math.max(0, Number(commission) || 0)) })} />
          </Field>
        </div>
        {settings.mode === 'deneme' && canTest && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" className={BTN.soft} onClick={() => void test()}>
              <Send className="size-4" aria-hidden="true" />
              Deneme siparişi gönder
            </button>
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
