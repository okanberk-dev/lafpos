import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, RotateCcw, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { PLATFORM_LABEL, type PlatformId } from '@shared/platforms';
import { SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode, serviceModeOf } from '@shared/service-mode';
import type { BootstrapDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Select } from '@/components/ui/Field';
import { Badge, ErrorState } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { errorMessage, get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { appUrl, asDemoPatron, enterAs, useDemo } from '@/lib/demo';
import { toast } from '@/lib/toast';

/** Demo şeridi: rol değiştirme ve sıfırlama. Uygulama şeridin altında tam yüksekliğini kullanır */
export function DemoFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <DemoBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

const DEMO_PLATFORMS: PlatformId[] = ['yemeksepeti', 'getir', 'trendyol'];

// Şeridin seçimleri kit alanı: genişlik en uzun seçeneğe göre, fareyle 36 px (yönetim açıkken de), dokunmatikte 44 px
const BAR_SELECT = 'h-9 w-auto text-sm pointer-coarse:h-11 [[data-area=admin]_&]:pointer-fine:h-9';

function DemoBar() {
  const server = useDemo((s) => s.server);
  const me = useAuth((s) => s.me);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Servis modu ve deneme siparişi oturum açıkken (rol seçimi ekranında şerit yalnız rolü gösterir)
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => get<BootstrapDTO>('/bootstrap'), enabled: !!me, staleTime: 5 * 60_000 });
  const mode = serviceModeOf(boot.data?.settings);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  if (!server) return null;

  const switchTo = async (role: string) => {
    const user = server.users.find((u) => u.role === role);
    if (!user) return;
    try {
      await enterAs(user);
      navigate('/');
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const switchMode = async (next: ServiceMode) => {
    try {
      await asDemoPatron('PUT', '/admin/settings', { serviceMode: next });
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
      toast.ok(SERVICE_MODE_LABEL[next]);
      navigate('/');
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  // Platformdan gelmiş gibi sipariş: üstteki şeritten kabul edilir (Yemeksepeti, Getir, Trendyol Go sırayla); platformun
  // otomatik kabulü açıksa (Yönetim › Paket platformları) koşulları tutan sipariş kendiliğinden kabul edilir
  const sendOrder = async () => {
    setSending(true);
    const platform = DEMO_PLATFORMS[Math.floor(Date.now() / 1000) % DEMO_PLATFORMS.length];
    try {
      const res = await asDemoPatron<{ autoAccepted?: boolean }>('POST', `/platforms/${platform}/test-order`, {});
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      toast.ok(res.autoAccepted ? `${PLATFORM_LABEL[platform]} siparişi geldi ve otomatik kabul edildi` : `${PLATFORM_LABEL[platform]} siparişi geldi`);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  // Sıfırlama kitin onay penceresiyle (yıkıcı: odak Vazgeç'te); sayfa yeniden yüklenene dek düğme döner
  const reset = async () => {
    const ok = await confirmDialog({ title: 'Demoyu sıfırla', body: 'Bu tarayıcıdaki demo verisi silinir; demo ilk günün masaları ve satışlarıyla yeniden açılır', confirmLabel: 'Sıfırla' });
    if (!ok) return;
    setBusy(true);
    try {
      await server.reset();
      window.location.assign(appUrl('/'));
    } catch (e) {
      setBusy(false);
      toast.err(errorMessage(e));
    }
  };
  const modes = SERVICE_MODES.map((m) => (
    <option key={m} value={m}>
      {SERVICE_MODE_LABEL[m]}
    </option>
  ));
  const where = server.persistent ? 'Gerçek LafPOS bu tarayıcıda çalışıyor; veriler yalnız burada kalır' : 'Gerçek LafPOS bu sekmede çalışıyor; sekme kapanınca veriler silinir';

  return (
    // Tek satır: telefonda rozet, rol ve "Demo seçenekleri"; tablet ve bilgisayarda açıklama kısalır, araçlar satırda
    <div role="region" aria-label="Demo" className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-0.5 text-sm">
      <Badge tone="blue" className="shrink-0">
        Demo
      </Badge>
      <span className="hidden min-w-0 flex-1 truncate text-muted md:block">{where}</span>
      <span className="flex-1 md:hidden" />
      <label className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted max-md:sr-only">Rol</span>
        <Select value={me?.role ?? ''} aria-label="Demo rolü" onChange={(e) => void switchTo(e.target.value)} className={BAR_SELECT}>
          {!me && <option value="">Rol seçin</option>}
          {server.users.map((u) => (
            <option key={u.role} value={u.role}>
              {u.name}
            </option>
          ))}
        </Select>
      </label>
      {me && boot.data && (
        <>
          <Select value={mode} aria-label="Servis modu" onChange={(e) => void switchMode(e.target.value as ServiceMode)} className={`${BAR_SELECT} max-md:hidden`}>
            {modes}
          </Select>
          <Button size="sm" variant="ghost" className="max-md:hidden" icon={<Send className="size-4" />} loading={sending} onClick={() => void sendOrder()} aria-label="Platform siparişi gönder" title="Platform siparişi gönder">
            <span className="max-lg:sr-only">Platform siparişi</span>
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" className="max-md:hidden" icon={<RotateCcw className="size-4" />} loading={busy} onClick={() => void reset()} aria-label="Demoyu sıfırla">
        Sıfırla
      </Button>
      <IconButton label="Demo seçenekleri" className="md:hidden" onClick={() => setMore(true)}>
        <MoreHorizontal className="size-5" />
      </IconButton>
      {/* Telefonda şeride sığmayanlar: servis modu, platform siparişi, sıfırlama */}
      <Modal open={more} onClose={() => setMore(false)} size="sm" title="Demo" subtitle={where}>
        <div className="space-y-3 p-4">
          {me && boot.data && (
            <>
              <Field label="Servis modu">
                <Select
                  value={mode}
                  onChange={(e) => {
                    setMore(false);
                    void switchMode(e.target.value as ServiceMode);
                  }}
                >
                  {modes}
                </Select>
              </Field>
              <Button
                block
                icon={<Send className="size-4" />}
                loading={sending}
                onClick={() => {
                  setMore(false);
                  void sendOrder();
                }}
              >
                Platform siparişi gönder
              </Button>
            </>
          )}
          <Button
            block
            variant="dangerOutline"
            icon={<RotateCcw className="size-4" />}
            loading={busy}
            onClick={() => {
              setMore(false);
              // Onay bu pencere kapanıp odağı bıraktıktan sonra açılır: odak onayın Vazgeç'inde kalsın
              window.setTimeout(() => void reset(), 0);
            }}
          >
            Demoyu sıfırla
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Demo açılamadı (ör. tarayıcı WebAssembly'yi kapatmış ya da kayıtlı veri bozuk): sıfırlayıp yeniden denenir */
export function DemoFailed({ error }: { error: unknown }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await new Promise<void>((ok) => {
      try {
        const req = indexedDB.deleteDatabase('lafpos-demo');
        req.onsuccess = req.onerror = req.onblocked = () => ok();
      } catch {
        ok();
      }
    });
    window.location.assign(appUrl('/'));
  };
  return (
    <div className="grid h-full place-items-center p-6">
      <ErrorState
        title="Demo açılamadı"
        error={error}
        action={
          <Button variant="primary" loading={busy} onClick={() => void retry()}>
            Sıfırla ve yeniden dene
          </Button>
        }
      />
    </div>
  );
}
