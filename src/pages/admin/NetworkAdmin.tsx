import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, WifiOff } from 'lucide-react';
import { fmtDateTime, fmtTime } from '@shared/time';
import type { BootstrapDTO, NetAddressDTO, NetworkInfoDTO } from '@shared/types';
import { Badge, Card, CARD, CODE, DefRow, EmptyState, LABEL, PageHeader, SetupNotes, TONE_SOFT } from '@/components/admin/ui';
import { NotifyCard } from '@/components/admin/NotifyCard';
import { QrCode } from '@/components/QrCode';
import { Toggle } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { REMOTE } from '@/lib/remote';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Karekod ve adres yan yana; telefonda alt alta. `off`: sunucu bu adresi dinlemiyor (LAFPOS_HOST): karekod çizilmez,
 * adres soluk (okutulan adres açılmazdı); yerine ne zaman çalışacağı yazar
 */
function Address({ item, off, children }: { item: NetAddressDTO; off?: boolean; children: React.ReactNode }) {
  if (off) {
    return (
      <div className="min-w-0 space-y-2">
        <p className="tabular break-all text-lg font-semibold text-[var(--admin-text-mute)]">{item.url}</p>
        <p className={HINT}>
          Bu adres, <code className={CODE}>LAFPOS_HOST</code> düzelip LafPOS yeniden başlayınca çalışır; karekod o zaman burada çıkar
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {/* Karekod kart içindeki karo köşesinde (12), ince çerçeveli beyaz kâğıt */}
      <QrCode value={item.url} label={`${item.url} karekodu`} className="size-40 rounded-[var(--r-tile)]" />
      <div className="min-w-0 space-y-2">
        <p className="tabular break-all text-lg font-semibold text-[var(--admin-text)]">{item.url}</p>
        {children}
      </div>
    </div>
  );
}

const HINT = 'text-[13px] text-[var(--admin-text-mute)]';

/** Tailscale kurulumu, sırasıyla */
const TAILSCALE_STEPS = [
  'Bu bilgisayara Tailscale’i kurun ve hesabınızla girin (tailscale.com/download)',
  'Telefonunuza Tailscale uygulamasını kurun, aynı hesapla girin',
  'Bu sayfa kendini yeniler; uzaktan adres ve karekodu burada çıkar',
];

/** Denetim kaydının satırı (yalnız kartın okuduğu alanlar) */
interface AuditRow {
  id: number;
  at: number;
  userId: string | null;
  action: string;
  message: string;
}

/** Uzaktan yapılan ya da reddedilen işlem: kimlik `uzaktan`, kontrol kaydı ya da "Uzaktan (e-posta)" adıyla yazılmış */
const isRemoteAudit = (a: AuditRow) => a.userId === 'uzaktan' || a.action.startsWith('uzaktan.') || a.message.startsWith('Uzaktan (');

/**
 * Uzaktan yönetim anahtarı (docs/UZAKTAN-YONETIM.md): LafPOS Uzaktan'dan gelen personel, PIN, rol, Tükendi ve servis modu
 * işlemleri. Yalnız patron değiştirir (sunucuda da patrona özel ayar); kapalıyken kasa uzaktan gelen her işlemi reddeder.
 * Altında son uzaktan işlem (denetim kaydından, son iki hafta)
 */
function RemoteControlCard() {
  const qc = useQueryClient();
  const boot = useBoot();
  const patron = useAuth((st) => st.me?.role === 'patron');
  const on = boot.settings.remoteControl !== false;
  const recent = useQuery({
    queryKey: ['admin', 'audit', 'uzaktan'],
    // Sunucu yalnız uzaktan kayıtlarını süzer: yoğun kafede genel kaydın ilk satırları başka işlemlerle dolar
    queryFn: () => get<AuditRow[]>(`/admin/audit?uzaktan=1&limit=1&from=${Date.now() - 14 * 86_400_000}`),
    staleTime: 60_000,
  });
  const last = recent.data?.find(isRemoteAudit);
  const change = useMutation({
    mutationFn: (next: boolean) => put('/admin/settings', { remoteControl: next }),
    onSuccess: (_d, next) => {
      qc.setQueryData<BootstrapDTO>(['bootstrap'], (d) => (d ? { ...d, settings: { ...d.settings, remoteControl: next } } : d));
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.ok(next ? 'Uzaktan yönetim açıldı' : 'Uzaktan yönetim kapatıldı: kasa uzaktan gelen işlemleri reddeder');
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  const checked = change.isPending && change.variables !== undefined ? change.variables : on;
  return (
    <Card
      title="Uzaktan yönetim"
      actions={
        on ? (
          <Badge tone="success" dot>
            Açık
          </Badge>
        ) : (
          <Badge>Kapalı</Badge>
        )
      }
    >
      <Toggle
        block
        checked={checked}
        disabled={!patron || change.isPending}
        onChange={(v) => change.mutate(v)}
        label="LafPOS Uzaktan’dan personel, PIN, roller, Tükendi ve servis modu değişikliklerine izin ver"
        hint="Kapalıyken kasa uzaktan gelen her işlemi reddeder"
      />
      {!patron && <p className={cn(HINT, 'mt-2')}>Yalnız patron değiştirir</p>}
      {last && (
        <div className="mt-4 border-t border-[var(--admin-divider)] pt-3">
          <p className={LABEL}>
            Son uzaktan işlem · <span className="tabular-nums">{fmtDateTime(last.at)}</span>
          </p>
          <p className="mt-1 line-clamp-2 text-sm text-[var(--admin-text)] [overflow-wrap:anywhere]">{last.message}</p>
        </div>
      )}
    </Card>
  );
}

/**
 * Kasa penceresinin bakım arası (server/lib/kasa-bakim.ts): kasa bekçisi kapatılan kasa penceresini 15 sn içinde yeniden
 * açar. Bakım için (Windows ayarı, yazıcı kurulumu) 15 dakika açmaz; süre bitince ya da "Bitir"le yine açar
 */
function KasaBakim({ until }: { until: number | null }) {
  const qc = useQueryClient();
  const active = until != null && until > Date.now();
  const m = useMutation({
    mutationFn: (on: boolean) => post<{ kasaBakim: number | null }>('/admin/kasa-bakim', { on }),
    onSuccess: (r) => {
      toast.ok(r.kasaBakim ? 'Kasa penceresi 15 dakika yeniden açılmayacak' : 'Bakım arası bitti; kasa penceresi 15 saniye içinde yeniden açılır');
      void qc.invalidateQueries({ queryKey: ['admin', 'network'] });
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  return (
    <div className="space-y-2 border-t border-[var(--admin-divider)] pt-3">
      <p className={LABEL}>Bakım</p>
      <p className={HINT}>
        {active
          ? `Bakım arası sürüyor (bitiş ${fmtTime(until!)}): kasa penceresi kapatılabilir, bekçi yeniden açmaz. Süre bitince kendiliğinden açılır`
          : 'Kasa penceresi kapatılınca 15 saniye içinde yeniden açılır. Bilgisayarda bakım yapacaksanız (Windows ayarı, yazıcı kurulumu) aşağıdan 15 dakikalık bakım arası verin'}
      </p>
      <div className="flex flex-wrap gap-2 max-sm:[&>*]:grow">
        {active ? (
          <Button loading={m.isPending} onClick={() => m.mutate(false)}>
            Bakımı bitir
          </Button>
        ) : (
          <Button loading={m.isPending} onClick={() => m.mutate(true)}>
            15 dakika bakım arası
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Tablet ve telefonların bağlanacağı adresler: kafenin ağı (karekodla) ve Tailscale ile dışarıdan canlı erişim.
 * Kurulum: docs/07-UZAKTAN-ERISIM.md
 */
export default function NetworkAdmin() {
  const q = useQuery({ queryKey: ['admin', 'network'], queryFn: () => get<NetworkInfoDTO>('/admin/network'), refetchInterval: 15_000 });
  const can = useCan();
  // Uzaktaki raporlar silindiyse ya da eksikse: kasa geçmişi baştan gönderir
  const resend = useMutation({
    mutationFn: () => post('/sync/cloud-reports/resend'),
    onSuccess: () => toast.ok('Raporlar yeniden gönderiliyor; yaklaşık bir saat sürer'),
    onError: (e) => toast.err(errorMessage(e)),
  });
  const header = <PageHeader title="Ağ ve uzaktan erişim" description="Tablet ve telefonlar kafede Wi-Fi’dan, dışarıdan Tailscale ile bağlanır" />;
  if (!q.data)
    return (
      <div className="space-y-4">
        {header}
        {q.isError ? (
          <ErrorState className={CARD} title="Ağ bilgisi alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-56 rounded-[var(--r-card)]" />
            <Skeleton className="h-56 rounded-[var(--r-card)]" />
          </div>
        )}
      </div>
    );
  const n = q.data;
  const [local, ...others] = n.lan;
  const remote = n.tailscale[0];

  return (
    <div className="space-y-4">
      {header}
      {/* Sorunun yanında çaresi: ayar Kurulum adımları'nın kapalı açılırında kalmasın */}
      {n.loopbackOnly && (
        <Notice tone="warn" role="status" title="Tablet ve telefonlar bağlanamaz">
          Sunucu yalnız bu bilgisayarı dinliyor. Kasa bilgisayarının ayarında <code className={CODE}>LAFPOS_HOST</code> değerini <code className={CODE}>0.0.0.0</code> yapıp LafPOS’u yeniden başlatın
        </Notice>
      )}
      {/* Üç kartın rozeti aynı dil: yeşil yalnız gerçekten açık ya da bağlıyken */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Kafenin ağı"
          subtitle="Tablet, garson telefonu, bar ekranı"
          actions={
            !local ? (
              <Badge>Bağlı değil</Badge>
            ) : n.loopbackOnly ? (
              <Badge tone="warning" dot>
                Kapalı
              </Badge>
            ) : (
              <Badge tone="success" dot>
                Açık
              </Badge>
            )
          }
        >
          {local ? (
            <Address item={local} off={n.loopbackOnly}>
              <p className={HINT}>Aynı Wi-Fi’deki tablet ya da telefonun kamerasıyla okutun; Chrome menüsünden “Ana ekrana ekle” ile uygulama gibi açılır</p>
              <p className={HINT}>Adres değişmesin diye modemde bu bilgisayara sabit IP verin (DHCP rezervasyonu)</p>
            </Address>
          ) : (
            <EmptyState bare icon={<WifiOff />} title="Ağa bağlı görünmüyor">
              Bu bilgisayarın Wi-Fi’ını ya da kablosunu denetleyin; bağlanınca adres ve karekod burada çıkar
            </EmptyState>
          )}
          {others.length > 0 && (
            // Ana adresten satır ayracıyla ayrı: bunlar çoğu zaman sanal kart (WSL, Hyper-V), karekodsuz
            <div className="mt-4 border-t border-[var(--admin-divider)] pt-3">
              <p className={LABEL}>Diğer ağ kartları</p>
              {others.map((o) => (
                <DefRow key={o.url} label={o.name}>
                  <span className="tabular break-all">{o.url}</span>
                </DefRow>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Dışarıdan (Tailscale)"
          subtitle="Patronun telefonu, evdeki bilgisayar"
          actions={
            !remote ? (
              <Badge>Kurulmadı</Badge>
            ) : n.loopbackOnly ? (
              <Badge tone="warning" dot>
                Kapalı
              </Badge>
            ) : (
              <Badge tone="success" dot>
                Bağlı
              </Badge>
            )
          }
        >
          {remote ? (
            <Address item={remote} off={n.loopbackOnly}>
              <p className={HINT}>Telefonda Tailscale açıkken açın: masalar, adisyonlar, kasa ve patron paneli her yerden canlı</p>
              <p className={HINT}>Bağlantı yalnız sizin Tailscale hesabınızdaki cihazlara açık ve şifreli</p>
            </Address>
          ) : (
            // Adımlar numaralı dairede (açık nane; Yazarkasa'nın "Nasıl çalışır"ı gibi): sırayı liste söyler, daire göz için
            <ol className="space-y-3 text-sm text-[var(--admin-text)]">
              {TAILSCALE_STEPS.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span aria-hidden="true" className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums', TONE_SOFT.primary)}>
                    {i + 1}
                  </span>
                  <span className="min-w-0 pt-0.5 leading-5">{step}</span>
                </li>
              ))}
            </ol>
          )}
          {/* Güvenlik notu kartın dibinde ayraçlı satırda, kalkan ikonuyla: ipuçlarından ayrı okunur */}
          <p className={cn(HINT, 'mt-4 flex gap-2 border-t border-[var(--admin-divider)] pt-3')}>
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">LafPOS’u modemden port açarak internete açmayın; dışarıdan yalnız Tailscale ile</span>
          </p>
        </Card>
      </div>

      {/* Etiket ve değer satırlı iki kart genişte yan yana (tam genişlikte etiketle değer kartın iki ucuna kaçıyordu) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="LafPOS Uzaktan (Vercel)"
          subtitle="Kurulum gerektirmeyen salt okunur görünüm: patron paneli, masalar, bar"
          actions={
            // Açık ancak bir gönderim gittiyse; anahtar tanımlı ama henüz gönderilmediyse bekliyor
            !n.cloud?.configured ? (
              <Badge>Kapalı</Badge>
            ) : n.cloud.lastError ? (
              <Badge tone="danger" dot>
                Gönderilemiyor
              </Badge>
            ) : n.cloud.lastSuccessAt ? (
              <Badge tone="success" dot>
                Açık
              </Badge>
            ) : (
              <Badge tone="info" dot>
                Bekliyor
              </Badge>
            )
          }
        >
          {n.cloud?.configured ? (
            <>
              <DefRow label="Adres">
                <span className="break-all">{n.cloud.url}</span>
              </DefRow>
              <DefRow label="Son gönderim">{n.cloud.lastSuccessAt ? fmtDateTime(n.cloud.lastSuccessAt) : 'Henüz yok'}</DefRow>
              {n.cloud.lastError && <DefRow label="Son hata">{n.cloud.lastError}</DefRow>}
              {can('senkron.yonet') && (
                <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}>
                    Raporları yeniden gönder
                  </Button>
                  <p className={HINT}>Uzaktaki raporlar eksik ya da silinmişse; geçmiş yaklaşık bir saatte baştan gider</p>
                </div>
              )}
            </>
          ) : (
            <p className={HINT}>Açmak için kasa bilgisayarına ve Vercel’e aynı anahtar tanımlanır; adımlar sayfanın sonunda</p>
          )}
        </Card>

        <Card title="Bu bilgisayar">
          <DefRow label="Bilgisayar adı">{n.hostname}</DefRow>
          <DefRow label="Port">
            <span className="tabular">{n.port}</span>
          </DefRow>
          <DefRow label="Bu ekranın adresi">
            <span className="break-all">{window.location.origin}</span>
          </DefRow>
          {n.bekci && can('ayar.yonet') && !REMOTE && <KasaBakim until={n.kasaBakim ?? null} />}
        </Card>
        {/* Uzaktan yönetim anahtarı tam genişlikte; uzaktan görünümde yok (kasayı yalnız kasadaki patron açar ya da kapatır) */}
        {!REMOTE && (
          <div className="lg:col-span-2">
            <RemoteControlCard />
          </div>
        )}
        {/* Uzaktan kuruluysa: telefon bildirimleri tam genişlikte (iki sütunlu ızgaranın altı); uçları senkron.yonet ister */}
        {n.cloud?.configured && can('senkron.yonet') && (
          <div className="lg:col-span-2">
            <NotifyCard />
          </div>
        )}
      </div>

      <SetupNotes>
        <p>
          Sunucunun dinlediği adres <code className={CODE}>LAFPOS_HOST</code> ayarıyla değişir; ağdaki cihazların bağlanması için <code className={CODE}>0.0.0.0</code> (varsayılan) kalmalı.
        </p>
        <p>
          LafPOS Uzaktan: kasa bilgisayarının ayarlarına <code className={CODE}>LAFPOS_CLOUD_URL</code> ve <code className={CODE}>LAFPOS_CLOUD_SECRET</code> yazın; Vercel’de aynı anahtar ve bir parola tanımlanır.
        </p>
        <p>
          Ayrıntı: <code className={CODE}>docs/07-UZAKTAN-ERISIM.md</code>
        </p>
      </SetupNotes>
    </div>
  );
}
