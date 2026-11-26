import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ROLE_LABELS, type Role } from '@shared/permissions';
import { odenmezSuggestion, phoneTail } from '@shared/comp';
import type { CompPersonKind } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Chip, Field, Input, Label, SearchInput, Stepper } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Avatar } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { fold } from '@/lib/shell';

/** Ödenmez kaydının bağlandığı kişi: kayıtlı personel ya da müşteri (ad ekranda; sunucuya tür ve kimlik gider) */
export interface PickedPerson {
  kind: CompPersonKind;
  id: string;
  name: string;
  /** Personelin rolü (öneri için: patron seçilince "Patron hesabı") */
  role?: Role;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * Ödenmez (adisyonun tamamı ya da tek kalem): kayıtlı bir kişi seçilmeden yapılmaz. Aranabilir liste iki grupta:
 * Personel (etkin kullanıcılar, rolüyle) ve Müşteriler (kayıtlı müşteriler, telefonun son 4 hanesiyle). Neden listesi
 * kalır; personel seçilince "Personel yemeği", patron seçilince "Patron hesabı" önerilir (yazılan neden ezilmez).
 * Kişi bilgisi yalnız LafPOS'ta kalır: lafmaliyet'e, siteye ve müşteri ekranına gitmez.
 */
export function OdenmezModal({
  open,
  title,
  subtitle,
  confirmLabel,
  qtyMax,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  confirmLabel: (qty: number) => string;
  /** Kalemde ödenmemiş adet 1'den fazlaysa adet seçici çıkar */
  qtyMax?: number;
  onClose: () => void;
  /** Söz dönerse yanıt gelene dek ikinci dokunuş yok sayılır */
  onConfirm: (input: { person: { kind: CompPersonKind; id: string }; reason: string; qty: number }) => unknown;
}) {
  const boot = useBoot();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [person, setPerson] = useState<PickedPerson | null>(null);
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<{ person?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** Son önerilen neden: kasiyer başka bir şey yazmadıysa kişi değişince öneri de değişir */
  const suggested = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setDebounced('');
    setPerson(null);
    setReason('');
    setQty(qtyMax ?? 1);
    setError({});
    suggested.current = null;
  }, [open, qtyMax]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const staff = useMemo(() => {
    const term = fold(q.trim());
    return boot.users.filter((u) => u.active && (!term || fold(u.name).includes(term) || fold(ROLE_LABELS[u.role as Role] ?? '').includes(term)));
  }, [boot.users, q]);
  // Müşteriler sunucudan: boş aramada son gelenler (en çok 6), yazınca ad ya da telefonla
  const customers = useQuery({
    queryKey: ['customers', 'odenmez', debounced],
    queryFn: () => get<CustomerRow[]>(`/customers?q=${encodeURIComponent(debounced)}&limit=${debounced ? 20 : 6}`),
    enabled: open,
    staleTime: 30_000,
  });

  if (!open) return null;
  const reasons = boot.settings.odenmezReasons;

  const pick = (p: PickedPerson) => {
    setPerson(p);
    setError((e) => ({ ...e, person: undefined }));
    const next = odenmezSuggestion(p.kind, p.role ?? null);
    // Öneri yalnız neden boşsa ya da önceki öneri değiştirilmeden duruyorsa yazılır
    if (!reason.trim() || reason === suggested.current) {
      setReason(next ?? '');
      suggested.current = next;
      if (next) setError((e) => ({ ...e, reason: undefined }));
    }
  };

  const confirm = async () => {
    if (busyRef.current) return;
    const errs = { person: person ? undefined : 'Kimin adına yazılacağını seçin', reason: reason.trim() ? undefined : 'Bir neden seçin ya da yazın' };
    setError(errs);
    if (!person || !reason.trim()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm({ person: { kind: person.kind, id: person.id }, reason: reason.trim(), qty });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const row = (on: boolean) =>
    cn(
      'flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors duration-150',
      on ? 'k-picked' : 'border-line bg-surface hover:border-[var(--admin-border-field)] hover:bg-hover active:bg-press',
    );
  const groupLabel = 'px-1 pb-1.5 pt-1 text-xs font-medium text-muted';
  const list = customers.data ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      persistent={busy}
      size="sm"
      title={title}
      subtitle={subtitle}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" wrap loading={busy} onClick={() => void confirm()}>
            {confirmLabel(qty)}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {qtyMax != null && qtyMax > 1 && (
          <div className="flex items-center justify-between gap-3">
            <Label className="mb-0">Adet</Label>
            <Stepper value={qty} onChange={setQty} min={1} max={qtyMax} label="Adet" />
          </div>
        )}
        <div>
          <Label hint="zorunlu">Kimin adına?</Label>
          <SearchInput label="Personel ya da müşteri ara" placeholder="Ad ya da telefon" value={q} onChange={setQ} />
          {error.person && (
            <p role="alert" className="mt-1.5 text-[13px] font-medium text-[var(--admin-danger-ink)]">
              {error.person}
            </p>
          )}
          <div className="scroll-thin mt-2 max-h-[min(46vh,22rem)] space-y-3 overflow-y-auto pr-0.5">
            <div role="group" aria-label="Personel">
              <div className={groupLabel}>Personel</div>
              {staff.length ? (
                <ul className="space-y-1.5">
                  {staff.map((u) => {
                    const on = person?.kind === 'user' && person.id === u.id;
                    return (
                      <li key={u.id}>
                        <button type="button" aria-pressed={on} onClick={() => pick({ kind: 'user', id: u.id, name: u.name, role: u.role as Role })} className={row(on)}>
                          <Avatar name={u.name} color={u.color} className="size-9 text-xs" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">{u.name}</span>
                            <span className="block truncate text-xs text-muted">{ROLE_LABELS[u.role as Role] ?? u.role}</span>
                          </span>
                          {on && <Check aria-hidden="true" className="size-5 shrink-0 text-ink" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-1 py-2 text-[13px] text-muted">Bu aramayla personel yok</p>
              )}
            </div>
            <div role="group" aria-label="Müşteriler">
              <div className={groupLabel}>{debounced ? 'Müşteriler' : 'Müşteriler · son gelenler'}</div>
              {customers.isPending ? (
                <p className="px-1 py-2 text-[13px] text-muted">Müşteriler yükleniyor</p>
              ) : customers.isError ? (
                <p className="px-1 py-2 text-[13px] text-[var(--admin-danger-ink)]">Müşteri listesi alınamadı; personel seçebilir ya da yeniden arayabilirsiniz</p>
              ) : list.length ? (
                <ul className="space-y-1.5">
                  {list.map((cst) => {
                    const on = person?.kind === 'customer' && person.id === cst.id;
                    const tail = phoneTail(cst.phone);
                    return (
                      <li key={cst.id}>
                        <button type="button" aria-pressed={on} onClick={() => pick({ kind: 'customer', id: cst.id, name: cst.name })} className={row(on)}>
                          <Avatar name={cst.name} color="#877D74" className="size-9 text-xs" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">{cst.name}</span>
                            <span className="tabular block truncate text-xs text-muted">{tail ? `Telefon •• ${tail}` : 'Telefon kayıtlı değil'}</span>
                          </span>
                          {on && <Check aria-hidden="true" className="size-5 shrink-0 text-ink" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-1 py-2 text-[13px] text-muted">{debounced ? 'Bu aramayla kayıtlı müşteri yok' : 'Kayıtlı müşteri yok'}</p>
              )}
            </div>
          </div>
        </div>
        <div>
          <Label hint="zorunlu">Neden</Label>
          {reasons.length > 0 && (
            <div role="group" aria-label="Hazır nedenler" className="mb-2 flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <Chip
                  key={r}
                  tone="ink"
                  on={reason === r}
                  onClick={() => {
                    setReason(r);
                    suggested.current = null;
                    setError((e) => ({ ...e, reason: undefined }));
                  }}
                >
                  {r}
                </Chip>
              ))}
            </div>
          )}
          <Field error={error.reason}>
            <Input
              value={reason}
              aria-label="Neden"
              placeholder="Ya da nedeni yazın"
              onChange={(e) => {
                setReason(e.target.value.slice(0, 200));
                suggested.current = null;
                setError((er) => ({ ...er, reason: undefined }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.repeat) void confirm();
              }}
              enterKeyHint="done"
            />
          </Field>
          {person && (
            <p className="mt-2 text-[13px] text-ink-2">
              <span className="font-semibold">{person.name}</span> adına yazılır; raporlarda kişi kişi görünür
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
