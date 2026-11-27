import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, ChevronRight, PackageSearch, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { tl } from '@shared/money';
import {
  AUTO_ACCEPT_MAX_DEFAULT,
  AUTO_ACCEPT_MAX_LIMIT,
  AUTO_SKIP_PREFIX,
  PLATFORM_COLOR,
  PLATFORM_LABEL,
  PLATFORM_STATUS_LABEL,
  PLATFORMS,
  type PlatformId,
  type PlatformLiveStatus,
  type PlatformMode,
  type PlatformOrderStatus,
  type PlatformProductDTO,
  type PlatformSettings,
} from '@shared/platforms';
import { addDays, fmtDateTime, fmtTime, istanbulParts } from '@shared/time';
import { Badge, Card, CARD, CODE, EmptyState, PageHeader, Segmented, type Tone } from '@/components/admin/ui';
import { PlatformBadge } from '@/components/PlatformBadge';
import { type PlatformsData, usePlatforms } from '@/components/PlatformInbox';
import { Button } from '@/components/ui/Button';
import { Field, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { ErrorState, ListSkeleton, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

/** Anahtarların girildiği yer: Yönetim › Bağlantı bilgileri (ayarlar dosyasına yazılır, AsilPOS kendiliğinden yeniden başlar) */
const KEYS_LINK = (
  <Link to="/yonetim/baglanti-bilgileri" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">
    Yönetim › Bağlantı bilgileri
  </Link>
);

/** Vercel'deki ayar adı kitin eş genişlikli koduyla */
const Env = ({ name }: { name: string }) => <code className={CODE}>{name}</code>;

/**
 * Gerçek bağlantı için gerekenler (calisma/arastirma/paket-platformlari, 27 Ekim 2026; docs/PAKET-PLATFORMLARI.md).
 * Kartın ana akışında değil, "Gerçek bağlantı için ne gerekir" açılırında; anahtarı tamam canlı platformda gösterilmez.
 */
const LIVE_NEEDS: Record<PlatformId, ReactNode> = {
  yemeksepeti: (
    <>
      Delivery Hero’dan POS entegrasyonu: middleware adresi, kullanıcı adı, parola ve restoranın POS kimliği {KEYS_LINK}’ne, JWT anahtarı Vercel’e (<Env name="YEMEKSEPETI_PLUGIN_SECRET" />) yazılır;
      AsilPOS yeniden açılınca Canlı seçilir. Siparişler AsilPOS Uzaktan’a gelir, kasa 20 saniyede bir çeker.
    </>
  ),
  getir: (
    <>
      Getir’den POS entegrasyonu: test ve canlı için uygulama anahtarı ve restoran anahtarı {KEYS_LINK}’ne (test ortamı için API adresi de), Vercel’e bizim ürettiğimiz{' '}
      <Env name="GETIR_WEBHOOK_SECRET" /> yazılır; Getir’e sipariş ve iptal adresleri bu anahtarla verilir. AsilPOS yeniden açılınca Canlı seçilir. Siparişler AsilPOS Uzaktan’a
      gelir, kasa 20 saniyede bir çeker, yedek olarak Getir’den de okur. Getir’in yemek işi Uber’e geçti: siparişler ileride Trendyol Go’dan da gelebilir.
    </>
  ),
  trendyol: (
    <>
      Satıcı panelinden satıcı no, API anahtarı ve gizli anahtar {KEYS_LINK}’ne yazılır; AsilPOS yeniden açılınca Canlı seçilir. Uber Eats Türkiye siparişleri de buradan gelir, kasa
      20 saniyede bir yoklar.
    </>
  ),
  migros: 'Belgeler herkese açık değil; Migros Yemek ile görüşme gerekir.',
};

/**
 * Son 12 saatteki kararın rozeti: kabul yeşil, platformun iptali kırmızı (kayıp), ret ve süresi dolan amber (elimizden
 * çıkan sipariş, dikkat), bekleyen bilgi
 */
const STATUS_TONE: Record<PlatformOrderStatus, Tone> = { bekliyor: 'info', kabul: 'success', ret: 'warning', iptal: 'danger', suresi_doldu: 'warning' };

/** Satırdaki zaman: bugünse yalnız saat, dünse "dün 18:50", daha eskiyse tarihiyle (eski kalem bugünmüş gibi okunmasın) */
function seenAt(ms: number) {
  const today = istanbulParts(Date.now()).date;
  const day = istanbulParts(ms).date;
  return day === today ? fmtTime(ms) : day === addDays(today, -1) ? `dün ${fmtTime(ms)}` : fmtDateTime(ms);
}

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
              <Skeleton key={i} className="h-52 rounded-[var(--r-card)]" />
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
            {recent.map((o) => {
              // Kabulde `reason` platforma bildirilen hazırlık süresidir ("20 dk", otomatikse "20 dk, otomatik")
              const why = o.reason ? (o.status === 'kabul' ? `hazırlık ${o.reason}` : o.reason) : null;
              const detail = [why, o.decidedBy].filter(Boolean).join(' · ');
              return (
                // Her genişlikte iki sabit satır: kim, ne zaman, ne kadar; altında karar, nedeni ve kişi
                <li key={o.id} className="space-y-1 px-4 py-2.5 text-sm sm:px-5">
                  <div className="flex items-center gap-2">
                    <PlatformBadge platform={o.platform} code={o.payload.code} />
                    <span className="tabular text-[var(--admin-text-mute)]">{fmtTime(o.receivedAt)}</span>
                    <span className="tabular ml-auto font-medium">{tl(o.payload.customerTotal)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--admin-text-mute)]">
                    <Badge tone={STATUS_TONE[o.status]}>{PLATFORM_STATUS_LABEL[o.status]}</Badge>
                    {detail && <span>{detail}</span>}
                  </div>
                  {/* Otomatik kabul edilmedi notu hata değil (nedeni): gri; gerçek hata kırmızı */}
                  {o.lastError && <p className={cn('text-xs', o.lastError.startsWith(AUTO_SKIP_PREFIX) ? 'text-[var(--admin-text-mute)]' : 'text-[var(--admin-danger-ink)]')}>{o.lastError}</p>}
                </li>
              );
            })}
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
    <Card title="Ürün eşleme" subtitle="Platformdaki kalemi kasadaki ürüne bağlayın; bağlanmayan ada göre eşlenir" className="mt-4" flush actions={unmatched > 0 ? <Badge tone="warning">{unmatched} eşlenmemiş</Badge> : undefined}>
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
            // Genişte rozet sabit genişlikte sütunda: farklı uzunluktaki platform adları ürün adlarını kaydırmaz, adlar alt
            // alta hizalı okunur. Telefonda rozet ve ad bir satırda, seçim altta tam genişlikte
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-5">
              <span className="shrink-0 sm:w-32">
                <PlatformBadge platform={r.platform} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--admin-text)]">{r.name}</span>
                {/* Platformun kimliği yalnız ipucunda: sahibe bir şey söylemez, telefonda satırı kesiyordu */}
                <span className="block truncate text-xs text-[var(--admin-text-mute)]" title={`#${r.externalId}`}>
                  son sipariş {seenAt(r.lastSeenAt)}
                </span>
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
  // Yalnız sunucunun kabul edeceği modlar (seçili olan hep kalır): Deneme kurulum modunda (siparişi ciroya girer),
  // Canlı bağdaştırıcısı olan ve anahtarı bu kasada tanımlı platformda
  const modes: { value: PlatformMode; label: string }[] = [
    { value: 'kapali', label: 'Kapalı' },
    ...(boot.settings.demoMode || settings.mode === 'deneme' ? [{ value: 'deneme' as const, label: 'Deneme' }] : []),
    ...(live?.supported && (live.configured || settings.mode === 'canli') ? [{ value: 'canli' as const, label: 'Canlı' }] : []),
  ];
  const off = settings.mode === 'kapali';
  const keysMissing = !!live?.supported && !live.configured;
  // Otomatik kabul kişisiz açılamaz (sunucu reddeder): önce paket yetkili, etkin bir kabul eden seçilir
  const needsAcceptor = !settings.autoAccept && (!acceptorId || !!staleAcceptor);
  // Başlıkta rozet yalnız canlı bağlantının durumu (mod segmentte yazıyor); yeşil ancak yoklama yanıt verince
  const liveBadge =
    settings.mode === 'canli' && live ? (
      keysMissing ? (
        <Badge tone="danger" dot>
          Anahtar eksik
        </Badge>
      ) : live.lastError ? (
        <Badge tone="danger" dot>
          Bağlantı hatası
        </Badge>
      ) : live.lastPollAt ? (
        <Badge tone="success" dot>
          Bağlı
        </Badge>
      ) : (
        <Badge tone="info" dot>
          Bekliyor
        </Badge>
      )
    ) : undefined;
  return (
    <Card
      title={
        // Platformun adı kartın başlığı (15/600); rengi yalnız noktada (marka rengi durum renkleriyle karışmasın)
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[platform] }} />
          {PLATFORM_LABEL[platform]}
        </span>
      }
      actions={liveBadge}
    >
      <div className="space-y-3">
        {modes.length > 1 ? (
          <Segmented
            label={`${PLATFORM_LABEL[platform]} modu`}
            value={settings.mode}
            onChange={(mode) => {
              if (canEdit) void save({ mode });
            }}
            options={modes}
          />
        ) : (
          <p className="text-sm text-[var(--admin-text-mute)]">{keysMissing ? 'Kapalı: canlı bağlantının anahtarları bu kasada tanımlı değil' : 'Kapalı: AsilPOS’ta bu platformun canlı bağlantısı henüz yok'}</p>
        )}
        {/* Modun notları tek blokta, sıkı aralıkla. Eksik anahtar yalnız Canlı seçiliyken engeldir (kırmızı), öteki
            modlarda bilgi */}
        {((modes.length > 1 && keysMissing) || (settings.mode === 'canli' && live) || (off && modes.length > 1)) && (
          <div className="space-y-1 text-xs text-[var(--admin-text-mute)]">
            {modes.length > 1 && keysMissing && <p className={cn(settings.mode === 'canli' && 'text-[var(--admin-danger-ink)]')}>Canlı için anahtarlar bu kasada tanımlı değil; gerekenler kartın altında</p>}
            {settings.mode === 'canli' && live && (
              <p className={cn(live.lastError && 'text-[var(--admin-danger-ink)]')}>
                {live.lastError ?? (live.lastPollAt ? `Son yoklama ${fmtDateTime(live.lastPollAt)}` : 'Henüz yoklanmadı')}
                {live.openOrders > 0 && ` · ${live.openOrders} açık sipariş`}
              </p>
            )}
            {off && modes.length > 1 && <p>Açınca hazırlık süresi ve otomatik kabul burada ayarlanır</p>}
          </div>
        )}
        {/* Kapalı platformda sipariş gelmez: yalnız komisyon kalır (raporlar geçmiş siparişe bugünkü oranı uygular) */}
        {(!off || settings.commissionPct != null) && (
          // Alanlar tabandan hizalı: dar ekranda bir etiketin ipucu alta inse de iki kutu aynı satırda durur
          <div className="grid grid-cols-2 items-end gap-3">
            {!off && (
              <Field label="Hazırlık süresi (dk)" hint="5–120">
                <NumberInput value={settings.prepMinutes} min={5} max={120} fallback={20} disabled={!canEdit} onCommit={(prepMinutes) => void save({ prepMinutes })} />
              </Field>
            )}
            {/* Oran maliyettir: yalnız ayarı yöneten ya da maliyeti gören alır (sunucu ötekilere göndermez) */}
            {settings.commissionPct != null && (
              <Field label="Tahmini komisyon (%)" hint="0–60">
                <NumberInput decimals={2} value={settings.commissionPct} min={0} max={60} fallback={0} disabled={!canEdit} onCommit={(commissionPct) => void save({ commissionPct })} />
              </Field>
            )}
          </div>
        )}
        {!off && (
          // Önce kişi ve sınır, sonra anahtar: kişisiz açmaya çalışmak hata bildirimiyle bitiyordu
          <div className="space-y-3 border-t border-[var(--admin-divider)] pt-3">
            <div className="grid grid-cols-2 items-end gap-3">
              <Field label="Kabul eden">
                <Select value={acceptorId} disabled={!canEdit} onChange={(e) => void save({ autoAcceptUserId: e.target.value || null })}>
                  {/* Otomatik kabul açıkken kişi boşaltılamaz (sunucu reddeder): önce anahtar kapatılır */}
                  <option value="" disabled={settings.autoAccept}>
                    Seçilmedi
                  </option>
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
            <Toggle
              block
              checked={settings.autoAccept}
              disabled={!canEdit || needsAcceptor}
              onChange={(autoAccept) => void save({ autoAccept })}
              label="Otomatik kabul"
              hint={
                needsAcceptor
                  ? staleAcceptor
                    ? 'Açmak için paket yetkisi olan etkin bir kişi seçin'
                    : 'Açmak için önce kabul eden kişiyi seçin'
                  : 'Canlı ve Deneme modunda; tutarı tutan, bütün ürünleri eşleşmiş, ödemesi platformda alınmış siparişler. Diğerleri elle kabul bekler'
              }
            />
            {settings.autoAccept && staleAcceptor && <p className="text-xs text-[var(--admin-warning)]">Kabul eden kişi etkin değil ya da paket yetkisi yok: siparişler elle kabul bekler</p>}
          </div>
        )}
        {/* Deneme siparişi ve kurulum notu kartın dibinde, ayarlardan satır ayracıyla ayrı */}
        {((settings.mode === 'deneme' && canTest) || settings.mode !== 'canli' || keysMissing) && (
          <div className="space-y-2 border-t border-[var(--admin-divider)] pt-3">
            {settings.mode === 'deneme' && canTest && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button variant="soft" icon={<Send className="size-4" />} loading={testing} onClick={() => void test()}>
                  Deneme siparişi gönder
                </Button>
                <span className="text-xs text-[var(--admin-text-mute)]">Deneme siparişi gerçek satış gibi ciroya girer</span>
              </div>
            )}
            {/* Kurulum metni yalnız henüz canlı olmayan (ya da canlıda anahtarı eksik) platformda; açılınca saç telli karoda (zemin
                beyaz kalır: içindeki ayar adlarının gri kutusu seçilir) */}
            {(settings.mode !== 'canli' || keysMissing) && (
              <details className="group text-xs">
                <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-[var(--r-chip)] text-[13px] font-medium text-[var(--admin-primary)] hover:underline hover:underline-offset-2 pointer-fine:min-h-8 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                  Gerçek bağlantı için ne gerekir
                </summary>
                <p className="mt-1.5 rounded-[var(--r-tile)] p-3 leading-5 text-[var(--admin-text-soft)] ring-1 ring-inset ring-[var(--admin-border)]">{LIVE_NEEDS[platform]}</p>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
