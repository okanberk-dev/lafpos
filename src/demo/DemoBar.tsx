import { RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { appUrl, enterAs, useDemo } from '@/lib/demo';
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

function DemoBar() {
  const server = useDemo((s) => s.server);
  const me = useAuth((s) => s.me);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const reset = async () => {
    setBusy(true);
    await server.reset();
    window.location.assign(appUrl('/'));
  };

  return (
    <div role="region" aria-label="Demo" className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-0.5 text-sm">
      <span className="rounded-md bg-[var(--admin-primary-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--admin-primary)]">Demo</span>
      <span className="hidden min-w-0 truncate text-muted md:inline">
        {server.persistent ? 'Gerçek LafPOS bu tarayıcıda çalışıyor; veriler yalnız burada kalır' : 'Gerçek LafPOS bu sekmede çalışıyor; sekme kapanınca veriler silinir'}
      </span>
      <div className="flex-1" />
      <label className="flex items-center gap-1.5">
        <span className="text-muted max-sm:sr-only">Rol</span>
        <select
          value={me?.role ?? ''}
          aria-label="Demo rolü"
          onChange={(e) => void switchTo(e.target.value)}
          className="min-h-11 rounded-lg border border-[var(--admin-border-strong)] bg-surface px-2 text-sm pointer-fine:min-h-9"
        >
          {!me && <option value="">Rol seçin</option>}
          {server.users.map((u) => (
            <option key={u.role} value={u.role}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm(true)} aria-label="Demoyu sıfırla">
        <span className="max-sm:sr-only">Sıfırla</span>
      </Button>
      <Modal open={confirm} onClose={() => setConfirm(false)} size="sm" title="Demoyu sıfırla">
        <div className="space-y-4 p-5">
          <p className="text-sm text-ink-2">Bu tarayıcıdaki demo verisi silinir; demo ilk günün masaları ve satışlarıyla yeniden açılır</p>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setConfirm(false)}>Vazgeç</Button>
            <Button variant="danger" loading={busy} onClick={() => void reset()}>
              Sıfırla
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Demo açılamadı (ör. tarayıcı WebAssembly'yi kapatmış ya da kayıtlı veri bozuk): sıfırlayıp yeniden denenir */
export function DemoFailed({ error }: { error: unknown }) {
  const retry = async () => {
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
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-md">
        <p className="font-semibold">Demo açılamadı</p>
        <p className="mt-1 text-sm text-muted">{errorMessage(error)}</p>
        <Button variant="primary" className="mt-4" onClick={() => void retry()}>
          Sıfırla ve yeniden dene
        </Button>
      </div>
    </div>
  );
}
