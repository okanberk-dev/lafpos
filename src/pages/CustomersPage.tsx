import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, MapPin, Plus, Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
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
  const [address, setAddress] = useState<{ title: string; address: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['customers'] });

  const save = async () => {
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
    try {
      const res = await withApproval((pin) => post('/cash/collect', { customerId: selected, methodId: collect.methodId, amount: parseTL(collect.amount) ?? 0, approverPin: pin }));
      if (res === null) return;
      toast.ok('Tahsilat alındı');
      setCollect(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const c = detail.data?.customer;
  const goal = boot.settings.stampGoal;
  const collectMethods = boot.paymentMethods.filter((m) => m.kind !== 'cari' && m.kind !== 'online');

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex min-h-0 flex-col border-line lg:w-[420px] lg:border-r">
        <div className="space-y-3 p-4">
          <PageHeader title="Müşteriler" subtitle="Damga kartı, açık hesap ve adresler" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Yeni</Button>} />
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ad ya da telefon" className="pl-9" />
          </div>
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {(list.data ?? []).map((x) => (
            <li key={x.id}>
              <button onClick={() => setSelected(x.id)} className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 ${selected === x.id ? 'bg-forest-50 dark:bg-forest-800' : ''}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{x.name}</span>
                  <span className="text-xs text-muted">
                    {x.phone ?? '—'} · {x.visits} ziyaret
                  </span>
                </span>
                <span className="text-right text-xs">
                  <span className="block font-semibold text-brass-600">
                    {x.stamps}/{goal}
                  </span>
                  {x.balance !== 0 && <span className={x.balance > 0 ? 'text-burgundy-500' : 'text-forest-500'}>{tl(x.balance)}</span>}
                </span>
              </button>
            </li>
          ))}
          {list.data?.length === 0 && <li className="p-6 text-center text-sm text-muted">Müşteri bulunamadı</li>}
        </ul>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {!c ? (
          <EmptyState icon={<Wallet />} title="Bir müşteri seçin">
            Açık hesap bakiyesi, tahsilat, damga kartı ve sipariş geçmişi burada görünür
          </EmptyState>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl font-semibold">{c.name}</h2>
                <p className="text-sm text-muted">
                  {c.phone ?? 'telefon yok'}
                  {c.email && ` · ${c.email}`}
                  {c.birthday && ` · doğum günü ${c.birthday}`}
                </p>
                {c.note && <p className="mt-1 text-sm italic text-ink-2">{c.note}</p>}
              </div>
              {c.stamps >= goal && (
                <Button
                  variant="brass"
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Açık hesap" value={tl(c.balance)} hint={c.creditLimit != null ? `sınır ${tl(c.creditLimit)}` : 'sınırsız'} />
              <Tile label="Damga" value={`${c.stamps} / ${goal}`} />
              <Tile label="Toplam harcama" value={tl(c.totalSpent)} />
              <Tile label="Ziyaret" value={String(c.visits)} hint={c.lastVisitAt ? `son ${fmtDateTime(c.lastVisitAt)}` : undefined} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Açık hesap hareketleri">
                {detail.data!.ledger.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">Hareket yok</p>
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
              <Card title="Adresler" actions={<Button size="sm" icon={<MapPin className="size-4" />} onClick={() => setAddress({ title: 'Ev', address: '' })}>Ekle</Button>}>
                {detail.data!.addresses.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">Adres yok</p>
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
                {detail.data!.orders.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Sipariş yok</li>}
              </ul>
            </Card>
            {can('cari.yonet') && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const limit = window.prompt('Açık hesap sınırı (₺, boş bırakırsanız sınırsız)', c.creditLimit != null ? String(c.creditLimit / 100) : '');
                  if (limit === null) return;
                  try {
                    await withApproval((pin) => patch(`/customers/${c.id}`, { creditLimit: limit.trim() ? parseTL(limit) : null, approverPin: pin }));
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
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Yeni müşteri"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button variant="primary" disabled={!form.name.trim()} onClick={save}>
              Kaydet
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <Field label="Ad soyad" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Telefon">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" />
          </Field>
          <Field label="E-posta">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" />
          </Field>
          <Field label="Doğum günü">
            <Input value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} type="date" />
          </Field>
          {can('cari.yonet') && (
            <Field label="Açık hesap sınırı (₺)" hint="boş = sınırsız">
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

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
