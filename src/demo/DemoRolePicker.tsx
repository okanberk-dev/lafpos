import { ChevronRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { LafMark } from '@/components/LafMark';
import { errorMessage } from '@/lib/api';
import { enterAs, useDemo } from '@/lib/demo';
import { toast } from '@/lib/toast';

const ROLE_HINTS: Record<string, string> = {
  patron: 'Her ekran: patron paneli, raporlar, maliyet ve yönetim',
  mudur: 'Kasa, gün sonu, indirim ve iptal onayı, yönetim',
  kasiyer: 'Tezgâh satışı, ödeme, kasa hareketleri',
  garson: 'Masalar ve sipariş; indirim ve iptal onaya düşer',
  mutfak: 'Bar ve mutfak ekranı: hazırlanacaklar',
};

/** Demoda giriş ekranı yerine: PIN sorulmaz, rol seçilir */
export function DemoRolePicker() {
  const users = useDemo((s) => s.server?.users ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const enter = async (role: string) => {
    const user = users.find((u) => u.role === role);
    if (!user) return;
    setBusy(role);
    try {
      await enterAs(user);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6">
      <section className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
            <LafMark className="h-4" onNight />
          </span>
          <span>
            <h1 className="text-lg font-semibold tracking-[-0.01em]">Kimle devam edelim?</h1>
            <span className="block text-[13px] text-muted">Demoda PIN sorulmaz; her rol kendi ekranlarını görür</span>
          </span>
        </div>
        <div className="space-y-2">
          {users.map((u) => (
            <button
              key={u.role}
              type="button"
              disabled={!!busy}
              onClick={() => void enter(u.role)}
              aria-busy={busy === u.role || undefined}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-colors duration-150 enabled:hover:border-[var(--admin-border-field)] enabled:hover:bg-hover enabled:active:bg-press disabled:cursor-not-allowed disabled:opacity-60 aria-busy:opacity-100"
            >
              {/* Kişinin rengi koyu kartta kaybolmasın: ince iç halka */}
              <span className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ring-1 ring-inset ring-black/5 dark:ring-white/15" style={{ background: u.color }}>
                {u.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{u.name}</span>
                <span className="block text-xs text-muted">{ROLE_HINTS[u.role]}</span>
              </span>
              {busy === u.role ? <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted" /> : <ChevronRight aria-hidden="true" className="size-4 text-muted" />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
