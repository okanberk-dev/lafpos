import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { PLATFORM_LABEL, PLATFORM_MODE_LABEL, PLATFORM_STATUS_LABEL, PLATFORMS, type PlatformId, type PlatformLiveStatus, type PlatformMode, type PlatformProductDTO, type PlatformSettings } from '@shared/platforms';
import { fmtDateTime, fmtTime } from '@shared/time';
import { Badge, BTN, Card, PageHeader, Segmented } from '@/components/admin/ui';
import { PlatformBadge } from '@/components/PlatformBadge';
import { usePlatforms } from '@/components/PlatformInbox';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { toast } from '@/lib/toast';

/** Gerçek bağlantı için gerekenler (calisma/arastirma/paket-platformlari, 27 Ekim 2026; docs/PAKET-PLATFORMLARI.md) */
const LIVE_NEEDS: Record<PlatformId, string> = {
  yemeksepeti:
    "Delivery Hero'dan POS entegrasyonu (middleware adresi, kullanıcı adı, parola, restoranın POS kimliği ve JWT anahtarı). Siparişler LafPOS Uzaktan'a gelir, kasa 20 saniyede bir çeker: kasa bilgisayarının .env dosyasına YEMEKSEPETI_MW_URL, YEMEKSEPETI_USERNAME, YEMEKSEPETI_PASSWORD, YEMEKSEPETI_REMOTE_ID; Vercel'e YEMEKSEPETI_PLUGIN_SECRET yazılır, LafPOS yeniden başlatılır; sonra Canlı seçilir",
  getir: 'Getir geliştirici portalından POS başvurusu; test ve canlı anahtar. Getir yemek işi Uber\'e geçti, yol Trendyol Go\'ya dönebilir',
  trendyol: 'Satıcı panelinden satıcı no, API anahtarı ve gizli anahtar kasa bilgisayarının .env dosyasına (TRENDYOL_SUPPLIER_ID, TRENDYOL_API_KEY, TRENDYOL_API_SECRET) yazılır, LafPOS yeniden başlatılır; sonra Canlı seçilir. Uber Eats Türkiye siparişleri de buradan gelir; kasa 20 saniyede bir yoklar',
  migros: 'Belgeler herkese açık değil; Migros Yemek ile görüşme gerekir',
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
        description="Yemeksepeti, Getir Yemek, Trendyol Go (Uber Eats) ve Migros Yemek siparişleri kasaya düşer, onaylanınca bara gider. Tahsilatı platform yapıyorsa kuryeye verilince ya da teslimde platformun online ödemesiyle kapanır; kasada tahsil edilmez. Deneme siparişleri gerçek satış gibi ciroya girer: deneme modu yalnız kurulum modunda açılır"
      />
      <div className="grid gap-4 lg:grid-cols-2">
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
  const products = [...boot.products].filter((p) => !p.hidden).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
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
                      {p.name}
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
        {live?.supported && !live.configured && <p className="text-xs text-[var(--admin-warning)]">Canlı için anahtarlar .env'de tanımlı değil; yazıp LafPOS'u yeniden başlatın</p>}
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
        <p className="text-xs text-[var(--admin-text-mute)]">Gerçek bağlantı: {LIVE_NEEDS[platform]}</p>
        {settings.mode === 'deneme' && canTest && (
          <button type="button" className={BTN.soft} onClick={() => void test()}>
            <Send className="size-4" aria-hidden="true" />
            Deneme siparişi gönder
          </button>
        )}
      </div>
    </Card>
  );
}
