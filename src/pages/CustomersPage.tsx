import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, MapPin, Plus, Receipt, Search, Wallet } from 'lucide-react';
import { useRef, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, SearchInput, Select, Textarea } from '@/components/ui/Field';
import { promptDialog } from '@/components/ui/Confirm';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, PageHeader, Skeleton, Stat } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { ApiError, errorMessage, get, patch, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { useFinePointer } from '@/lib/hooks';
import { newRequestId } from '@/lib/requestId';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  birthday: string | null;
  balance: number;
  creditLimit: number | null;
  stamps: number;
  totalSpent: number;
  visits: number;
  lastVisitAt: number | null;
}
interface Detail {
  customer: Customer;
  ledger: { id: string; kind: 'borc' | 'tahsilat' | 'duzeltme'; amount: number; note: string | null; createdAt: number }[];
  addresses: { id: string; title: string; address: string; note: string | null }[];
  orders: { id: string; no: number; total: number; openedAt: number; status: string; type: string }[];
}

export default function CustomersPage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['customers', 'list', q], queryFn: () => get<Customer[]>(`/customers?q=${encodeURIComponent(q)}&limit=100`) });
  const detail = useQuery({ queryKey: ['customers', 'detail', selected], queryFn: () => get<Detail>(`/customers/${selected}`), enabled: !!selected });
  const [form, setForm] = useState({ name: '', phone: '', email: '', birthday: '', note: '', creditLimit: '' });
  const [collect, setCollect] = useState<{ methodId: string; amount: string } | null>(null);
  /** Süren tahsilat denemesi: aynı ekranda aynı girdilerle yeniden basılan "Tahsil et" ikinci kez yazılmaz */
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [address, setAddress] = useState<{ title: string; address: string } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fine = useFinePointer();
  const refresh = () => qc.invalidateQueries({ queryKey: ['customers'] });

  const save = async () => {
    // Zorunlu alan eksikse ileti alanın altında (düğme sessizce soluk kalmaz)
    if (!form.name.trim()) {
      setNameError('Ad soyad gerekli');
      nameRef.current?.focus();
      return;
    }
    try {
      const body = { name: form.name, phone: form.phone || null, email: form.email || null, birthday: form.birthday || null, note: form.note || null, creditLimit: form.creditLimit ? parseTL(form.creditLimit) : null };
      const res = await withApproval((pin) => post<{ id: string }>('/customers', { ...body, approverPin: pin }));
      if (!res) return;
      toast.ok('Müşteri kaydedildi');
      setCreating(false);
      setForm({ name: '', phone: '', email: '', birthday: '', note: '', creditLimit: '' });
      setSelected(res.id);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const doCollect = async () => {
    if (!collect || !selected) return;
    const amount = parseTL(collect.amount) ?? 0;
    // Ekranda görülen bakiye değiştiyse (tahsilat yazıldı, ekran yenilendi) yeni denemedir
    const key = JSON.stringify([selected, collect.methodId, amount, detail.data?.customer.balance ?? null]);
    if (attempt.current?.key !== key) attempt.current = { key, id: newRequestId() };
    const requestId = attempt.current.id;
    try {
      const res = await withApproval((pin) => post('/cash/collect', { customerId: selected, methodId: collect.methodId, amount, requestId, approverPin: pin }));
      if (res === null) return;
      attempt.current = null;
      toast.ok('Tahsilat alındı');
      setCollect(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
      // Kimlik başka tahsilata ait ya da bakiye değişmiş: bakiye yenilenir, sonraki basış yeni deneme olur
      if (e instanceof ApiError && e.status === 409) {
        if (e.code === 'request_reused') attempt.current = null;
        refresh();
      }
    }
  };

  const c = detail.data?.customer;
  const goal = boot.settings.stampGoal;
  // Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada)
  const stamps = boot.integrations.localStamps;
  const collectMethods = boot.paymentMethods.filter((m) => m.kind !== 'cari' && m.kind !== 'online');

  return (
    // Innex: gri zemin üstünde iki beyaz kart (liste ve kayıt), Masalar ekranıyla aynı iskelet
    <div className="flex h-full flex-col gap-3 p-2 md:p-0 lg:flex-row">
      <aside className={cn('flex min-h-0 flex-col rounded-2xl border border-line bg-surface lg:w-[400px]', c ? 'max-h-[40%] lg:max-h-none' : 'flex-1 lg:flex-none')}>
        <div className="space-y-3 p-4 pb-3">
          <PageHeader
            title="Müşteriler"
            subtitle={stamps ? 'Damga kartı, açık hesap ve adresler' : 'Açık hesap ve adresler'}
            actions={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                Yeni müşteri
              </Button>
            }
          />
          <SearchInput value={q} onChange={setQ} label="Müşteri ara" placeholder="Ad ya da telefon" />
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {list.isPending && (
            <li>
              <ListSkeleton rows={8} className="p-4" />
            </li>
          )}
          {list.isError && !list.data && (
            <li>
              <ErrorState compact title="Müşteriler alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
            </li>
          )}
          {(list.data ?? []).map((x) => (
            <li key={x.id}>
              <button onClick={() => setSelected(x.id)} aria-current={selected === x.id || undefined} className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-hover active:bg-press', selected === x.id && 'bg-surface-3 shadow-[inset_2px_0_0_var(--admin-primary)]')}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{x.name}</span>
                  <span className="text-xs text-muted">{joinMeta([x.phone, `${x.visits} ziyaret`])}</span>
                </span>
                <span className="text-right text-xs">
                  {stamps && (
                    <span className="block font-semibold text-warning-ink">
                      {x.stamps}/{goal}
                    </span>
                  )}
                  {x.balance !== 0 && <span className={x.balance > 0 ? 'text-danger-ink' : 'text-primary'}>{tl(x.balance)}</span>}
                </span>
              </button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li>
              <EmptyState
                compact
                icon={q ? <Search /> : <Plus />}
                title={q ? 'Müşteri bulunamadı' : 'Henüz müşteri yok'}
                action={
                  q ? undefined : (
                    <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                      İlk müşteriyi ekle
                    </Button>
                  )
                }
              >
                {q ? 'Ad ya da telefonun bir bölümünü yazın' : 'Açık hesap ve adres için müşteri kaydı açın'}
              </EmptyState>
            </li>
          )}
        </ul>
      </aside>

      <section className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-surface p-4 md:p-6', !selected && 'max-lg:hidden')}>
        {!selected ? (
          <EmptyState icon={<Wallet />} title="Bir müşteri seçin">
            {stamps ? 'Açık hesap bakiyesi, tahsilat, damga kartı ve sipariş geçmişi burada görünür' : 'Açık hesap bakiyesi, tahsilat ve sipariş geçmişi burada görünür'}
          </EmptyState>
        ) : detail.isPending ? (
          // Seçilen müşterinin kartı gelene dek iskelet ("Bir müşteri seçin" denmez; zaten seçildi)
          <div role="status" aria-label="Müşteri yükleniyor…" className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[84px] rounded-2xl" />
              ))}
            </div>
          </div>
        ) : !c ? (
          <ErrorState title="Müşteri bilgisi alınamadı" error={detail.error} retrying={detail.isFetching} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold tracking-[-0.01em]">{c.name}</h2>
                <p className="text-sm text-muted">{joinMeta([c.phone, c.email, c.birthday && `doğum günü ${c.birthday}`])}</p>
                {c.note && <p className="mt-1 text-sm italic text-ink-2">{c.note}</p>}
              </div>
              {stamps && c.stamps >= goal && (
                <Button
                  variant="warn"
                  icon={<Gift className="size-4" />}
                  onClick={async () => {
                    try {
                      const r = await withApproval((pin) => post(`/customers/${c.id}/redeem`, { approverPin: pin }));
                      if (r) {
                        toast.ok(`${goal} damga kullanıldı; bir içecek ikram edin`);
                        refresh();
                      }
                    } catch (e) {
                      toast.err(errorMessage(e));
                    }
                  }}
                >
                  Hediye içecek
                </Button>
              )}
              {can('cari.yonet') && c.balance > 0 && (
                <Button variant="primary" icon={<Wallet className="size-4" />} onClick={() => setCollect({ methodId: collectMethods[0]?.id ?? '', amount: String(c.balance / 100).replace('.', ',') })}>
                  Tahsilat al
                </Button>
              )}
            </div>
            <div className={`grid grid-cols-2 gap-3 ${stamps ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
              <Stat label="Açık hesap" value={tl(c.balance)} hint={c.creditLimit != null ? `sınır ${tl(c.creditLimit)}` : 'sınırsız'} tone={c.creditLimit != null && c.balance > c.creditLimit ? 'bad' : undefined} />
              {stamps && <Stat label="Damga" value={`${c.stamps} / ${goal}`} />}
              <Stat label="Toplam harcama" value={tl(c.totalSpent)} />
              <Stat label="Ziyaret" value={String(c.visits)} hint={c.lastVisitAt ? `son ${fmtDateTime(c.lastVisitAt)}` : undefined} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card title="Açık hesap hareketleri">
                {detail.data!.ledger.length === 0 ? (
                  <EmptyState compact title="Hareket yok">
                    Açık hesaba yazılan satış ve tahsilat burada
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {detail.data!.ledger.map((l) => (
                      <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <Badge tone={l.kind === 'borc' ? 'red' : l.kind === 'tahsilat' ? 'green' : 'neutral'}>{l.kind === 'borc' ? 'Borç' : l.kind === 'tahsilat' ? 'Tahsilat' : 'Düzeltme'}</Badge>
                        <span className="min-w-0 flex-1 truncate text-ink-2">{l.note ?? ''}</span>
                        <span className="tabular text-xs text-muted">{fmtDateTime(l.createdAt)}</span>
                        <span className="tabular w-24 text-right font-semibold">{tl(Math.abs(l.amount))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card
                title="Adresler"
                actions={
                  <Button size="sm" icon={<MapPin className="size-4" />} onClick={() => setAddress({ title: 'Ev', address: '' })}>
                    Adres ekle
                  </Button>
                }
              >
                {detail.data!.addresses.length === 0 ? (
                  <EmptyState compact title="Adres yok">
                    Paket siparişte adres buradan seçilir
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {detail.data!.addresses.map((a) => (
                      <li key={a.id} className="px-4 py-2.5 text-sm">
                        <span className="font-medium">{a.title}</span> · {a.address}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="Son siparişler">
              <ul className="divide-y divide-line">
                {detail.data!.orders.map((o) => (
                  <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      #{o.no} · {fmtDateTime(o.openedAt)}
                    </span>
                    <span className="tabular font-semibold">{tl(o.total)}</span>
                  </li>
                ))}
                {detail.data!.orders.length === 0 && (
                  <li>
                    <EmptyState compact icon={<Receipt />} title="Henüz sipariş yok">
                      Bu müşteri adisyona eklenince siparişleri burada görünür
                    </EmptyState>
                  </li>
                )}
              </ul>
            </Card>
            {can('cari.yonet') && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const limit = await promptDialog({
                    title: 'Açık hesap sınırı',
                    body: c.name,
                    label: 'Açık hesap sınırı (₺)',
                    hint: 'boşsa sınırsız',
                    placeholder: 'Ör. 500',
                    initial: c.creditLimit != null ? String(c.creditLimit / 100).replace('.', ',') : '',
                    inputMode: 'decimal',
                    validate: (v) => (v && parseTL(v) == null ? 'Tutarı ör. 500 ya da 1.250,50 biçiminde yazın' : null),
                    confirmLabel: 'Sınırı kaydet',
                    tone: 'primary',
                  });
                  if (limit === null) return;
                  try {
                    await withApproval((pin) => patch(`/customers/${c.id}`, { creditLimit: limit ? parseTL(limit) : null, approverPin: pin }));
                    toast.ok('Açık hesap sınırı kaydedildi');
                    refresh();
                  } catch (e) {
                    toast.err(errorMessage(e));
                  }
                }}
              >
                Açık hesap sınırını değiştir
              </Button>
            )}
          </div>
        )}
      </section>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Yeni müşteri"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button variant="primary" onClick={save}>
              Kaydet
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <Field label="Ad soyad" className="sm:col-span-2" required error={nameError}>
            <Input
              ref={nameRef}
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setNameError(null);
              }}
              autoFocus={fine}
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </Field>
          <Field label="Telefon">
            <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" spellCheck={false} />
          </Field>
          <Field label="E-posta">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" spellCheck={false} autoCapitalize="none" />
          </Field>
          <Field label="Doğum günü">
            <Input value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} type="date" />
          </Field>
          {can('cari.yonet') && (
            <Field label="Açık hesap sınırı (₺)" hint="boşsa sınırsız">
              <Input value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} inputMode="decimal" />
            </Field>
          )}
          <Field label="Not" className="sm:col-span-2">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">Kişisel veriler yalnız bu kafe bilgisayarında tutulur, başka sisteme gönderilmez (KVKK)</p>
        </div>
      </Modal>

      <Modal open={!!collect} onClose={() => setCollect(null)} size="sm" title="Açık hesap tahsilatı" subtitle={c ? `${c.name} · bakiye ${tl(c.balance)}` : ''}>
        {collect && (
          <div className="space-y-3 p-4">
            <Field label="Ödeme türü">
              <Select value={collect.methodId} onChange={(e) => setCollect({ ...collect, methodId: e.target.value })}>
                {collectMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tutar (₺)">
              <Input value={collect.amount} onChange={(e) => setCollect({ ...collect, amount: e.target.value })} inputMode="decimal" />
            </Field>
            <Button variant="primary" block onClick={doCollect} disabled={!parseTL(collect.amount || '0')}>
              Tahsil et
            </Button>
            <p className="text-xs text-muted">Tahsilat ciroya girmez (satış zaten açık hesaba yazıldı); nakitse kasaya girer</p>
          </div>
        )}
      </Modal>

      <Modal open={!!address} onClose={() => setAddress(null)} size="sm" title="Adres ekle">
        {address && (
          <div className="space-y-3 p-4">
            <Field label="Başlık">
              <Input value={address.title} onChange={(e) => setAddress({ ...address, title: e.target.value })} />
            </Field>
            <Field label="Adres">
              <Textarea value={address.address} onChange={(e) => setAddress({ ...address, address: e.target.value })} />
            </Field>
            <Button
              variant="primary"
              block
              disabled={address.address.trim().length < 3}
              onClick={async () => {
                try {
                  await post(`/customers/${selected}/addresses`, address);
                  setAddress(null);
                  refresh();
                } catch (e) {
                  toast.err(errorMessage(e));
                }
              }}
            >
              Kaydet
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

