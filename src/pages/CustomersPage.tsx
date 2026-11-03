import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cake, ChevronLeft, Gift, Mail, MapPin, Phone, Plus, Receipt, Wallet } from 'lucide-react';
import { useRef, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { fmtDateTime, isCalendarDate } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, SearchInput, Select, Textarea } from '@/components/ui/Field';
import { confirmDialog, promptDialog } from '@/components/ui/Confirm';
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

const LEDGER_LABEL = { borc: 'Borç', tahsilat: 'Tahsilat', duzeltme: 'Düzeltme' };
const emptyForm = () => ({ name: '', phone: '', email: '', birthday: '', note: '', creditLimit: '' });
const MONEY_HINT = 'Tutarı ör. 500 ya da 1.250,50 biçiminde yazın';
/** Pirinç dolgu: damga ve ödül (DESIGN; amber zamanındır). Kitte gold varyantı gelene dek ikincil düğmenin üstüne */
const GOLD = 'border-transparent bg-gold-fill font-semibold text-on-gold shadow-[var(--shadow-lift)] hover:border-transparent hover:bg-gold-fill hover:brightness-95 active:border-transparent active:bg-gold-fill active:brightness-90';

/** Sunucu telefonu 10 rakam saklar (normalizePhone): "5321112233" → "0532 111 22 33"; başka biçim olduğu gibi */
function fmtPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}` : p;
}
const telHref = (p: string) => {
  const d = p.replace(/\D/g, '');
  return `tel:${d.length === 10 ? '+90' : ''}${d}`;
};
const birthdayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long' });
/** Doğum günü yılsız: "14 Mayıs" */
const fmtBirthday = (d: string) => (isCalendarDate(d) ? birthdayFmt.format(new Date(`${d}T12:00:00Z`)) : d);

export default function CustomersPage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['customers', 'list', q], queryFn: () => get<Customer[]>(`/customers?q=${encodeURIComponent(q)}&limit=100`) });
  const detail = useQuery({ queryKey: ['customers', 'detail', selected], queryFn: () => get<Detail>(`/customers/${selected}`), enabled: !!selected });
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<{ name?: string; creditLimit?: string }>({});
  const [collect, setCollect] = useState<{ methodId: string; amount: string } | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  /** Süren tahsilat denemesi: aynı ekranda aynı girdilerle yeniden basılan "Tahsil et" ikinci kez yazılmaz */
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [address, setAddress] = useState<{ title: string; address: string } | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  // Kayıt yazan her düğme istek sürerken kilitli (ikinci dokunuş ikinci müşteriyi, tahsilatı ya da adresi yazmaz)
  const [busy, setBusy] = useState<null | 'save' | 'collect' | 'address' | 'redeem'>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fine = useFinePointer();
  const refresh = () => qc.invalidateQueries({ queryKey: ['customers'] });

  const openCreate = () => {
    setFormError({});
    setCreating(true);
  };
  const save = async () => {
    if (busy) return;
    // Zorunlu alan eksikse ileti alanın altında (düğme sessizce soluk kalmaz); yazılamayan sınır "sınırsız" sayılmaz
    const limitBad = !!form.creditLimit.trim() && parseTL(form.creditLimit) == null;
    if (!form.name.trim() || limitBad) {
      setFormError({ name: form.name.trim() ? undefined : 'Ad soyad gerekli', creditLimit: limitBad ? MONEY_HINT : undefined });
      if (!form.name.trim()) nameRef.current?.focus();
      return;
    }
    setBusy('save');
    try {
      const body = { name: form.name, phone: form.phone || null, email: form.email || null, birthday: form.birthday || null, note: form.note || null, creditLimit: form.creditLimit.trim() ? parseTL(form.creditLimit) : null };
      const res = await withApproval((pin) => post<{ id: string }>('/customers', { ...body, approverPin: pin }));
      if (!res) return;
      toast.ok('Müşteri kaydedildi');
      setCreating(false);
      setForm(emptyForm());
      setSelected(res.id);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doCollect = async () => {
    if (!collect || !selected || busy) return;
    const amount = parseTL(collect.amount) ?? 0;
    if (amount <= 0) {
      setCollectError('Tutarı girin');
      return;
    }
    // Ekranda görülen bakiye değiştiyse (tahsilat yazıldı, ekran yenilendi) yeni denemedir
    const key = JSON.stringify([selected, collect.methodId, amount, detail.data?.customer.balance ?? null]);
    if (attempt.current?.key !== key) attempt.current = { key, id: newRequestId() };
    const requestId = attempt.current.id;
    setBusy('collect');
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
    } finally {
      setBusy(null);
    }
  };

  const saveAddress = async () => {
    if (!address || !selected || busy) return;
    if (address.address.trim().length < 3) {
      setAddressError('Adres en az 3 harf olmalı');
      return;
    }
    setBusy('address');
    try {
      // Başlık boşsa sunucu "Ev" yazar
      await post(`/customers/${selected}/addresses`, { title: address.title.trim() || undefined, address: address.address.trim() });
      toast.ok('Adres eklendi');
      setAddress(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const c = detail.data?.customer;
  const goal = boot.settings.stampGoal;
  // Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada)
  const stamps = boot.integrations.localStamps;
  const collectMethods = boot.paymentMethods.filter((m) => m.kind !== 'cari' && m.kind !== 'online');
  const collectAmount = collect ? (parseTL(collect.amount) ?? 0) : 0;

  // Tek dokunuş karttaki damgaları düşürür: önce sorulur
  const redeem = async (cust: Customer) => {
    if (busy) return;
    if (!(await confirmDialog({ title: `${goal} damga kullanılsın mı`, body: `Müşteriye bir içecek ikram edilir; kartta ${cust.stamps - goal} damga kalır`, confirmLabel: 'Damgaları kullan', tone: 'primary' }))) return;
    setBusy('redeem');
    try {
      const r = await withApproval((pin) => post(`/customers/${cust.id}/redeem`, { approverPin: pin }));
      if (r) {
        toast.ok(`${goal} damga kullanıldı; bir içecek ikram edin`);
        refresh();
      }
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const changeLimit = async (cust: Customer) => {
    const limit = await promptDialog({
      title: 'Açık hesap sınırı',
      body: cust.name,
      label: 'Açık hesap sınırı (₺)',
      hint: 'boşsa sınırsız',
      placeholder: 'Ör. 500',
      initial: cust.creditLimit != null ? String(cust.creditLimit / 100).replace('.', ',') : '',
      inputMode: 'decimal',
      validate: (v) => (v && parseTL(v) == null ? MONEY_HINT : null),
      confirmLabel: 'Sınırı kaydet',
      tone: 'primary',
    });
    if (limit === null) return;
    try {
      await withApproval((pin) => patch(`/customers/${cust.id}`, { creditLimit: limit ? parseTL(limit) : null, approverPin: pin }));
      toast.ok('Açık hesap sınırı kaydedildi');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  return (
    // Innex: gri zemin üstünde iki beyaz kart (liste ve kayıt), Masalar ekranıyla aynı iskelet. Telefon ve tablette biri
    // görünür: liste ya da seçilen müşteri (geri düğmesiyle listeye dönülür); iki kaydırma alanı iç içe sıkışmaz
    <div className="flex h-full flex-col gap-3 p-2 md:p-0 lg:flex-row">
      <aside className={cn('flex min-h-0 flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] lg:w-[400px] lg:flex-none', selected ? 'max-lg:hidden' : 'flex-1')}>
        <div className="space-y-3 p-4 pb-3">
          <PageHeader
            title="Müşteriler"
            subtitle={stamps ? 'Damga kartı, açık hesap ve adresler' : 'Açık hesap ve adresler'}
            actions={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                Yeni müşteri
              </Button>
            }
          />
          <SearchInput value={q} onChange={setQ} label="Müşteri ara" placeholder="Ad ya da telefon" />
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-[var(--admin-divider)] overflow-y-auto">
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
              {/* Odak halkası satırın içinde: kaydırılan liste dış halkayı kırpardı */}
              <button
                onClick={() => setSelected(x.id)}
                aria-current={selected === x.id || undefined}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press',
                  selected === x.id && 'bg-surface-3 shadow-[inset_2px_0_0_var(--admin-primary)]',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{x.name}</span>
                  <span className="block truncate text-xs text-muted">{joinMeta([x.phone && fmtPhone(x.phone), `${x.visits} ziyaret`])}</span>
                </span>
                <span className="tabular shrink-0 text-right text-xs">
                  {stamps && (
                    <span className="block font-semibold text-gold-ink">
                      {x.stamps}/{goal}
                    </span>
                  )}
                  {x.balance !== 0 && <span className={x.balance > 0 ? 'text-danger-ink' : 'text-blue-ink'}>{tl(x.balance)}</span>}
                </span>
              </button>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li>
              {/* Ekleme düğmesi başlıkta: boş durum ikinci bir çağrı yapmaz */}
              <EmptyState compact art={q ? 'arama' : 'kupon'} title={q ? 'Müşteri bulunamadı' : 'Henüz müşteri yok'}>
                {q ? 'Ad ya da telefonun bir bölümünü yazın' : 'Açık hesap ve adres için müşteri kaydı açın'}
              </EmptyState>
            </li>
          )}
        </ul>
      </aside>

      <section className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] md:p-6', !selected && 'max-lg:hidden')}>
        {selected && (
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} className="-ml-2 mb-2 lg:hidden" onClick={() => setSelected(null)}>
            Müşteriler
          </Button>
        )}
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
            {/* Ad ve eylemler aynı satırda, iletişim ve not altında tam genişlikte; telefonda eylemler en altta, eşit genişlikte */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{c.name}</h2>
              {((stamps && c.stamps >= goal) || (can('cari.yonet') && c.balance > 0)) && (
                <div className="flex gap-2 max-sm:order-last max-sm:mt-1 max-sm:w-full max-sm:[&>*]:flex-1">
                  {stamps && c.stamps >= goal && (
                    <Button icon={<Gift className="size-4" />} className={GOLD} loading={busy === 'redeem'} onClick={() => void redeem(c)}>
                      Hediye içecek
                    </Button>
                  )}
                  {/* Tahsilat ticari son adım: mürekkep (DESIGN) */}
                  {can('cari.yonet') && c.balance > 0 && (
                    <Button
                      variant="ink"
                      icon={<Wallet className="size-4" />}
                      onClick={() => {
                        setCollectError(null);
                        setCollect({ methodId: collectMethods[0]?.id ?? '', amount: String(c.balance / 100).replace('.', ',') });
                      }}
                    >
                      Tahsilat al
                    </Button>
                  )}
                </div>
              )}
              {(c.phone || c.email || c.birthday || c.note) && (
                <div className="w-full">
                  {/* İletişim parçaları bölünmez, satır parçaların arasında kırılır; e-posta sığmazsa kendi içinde */}
                  {(c.phone || c.email || c.birthday) && (
                    <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted">
                      {c.phone && (
                        <a href={telHref(c.phone)} className="tabular inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap text-primary pointer-fine:min-h-0">
                          <Phone aria-hidden="true" className="size-3.5" />
                          {fmtPhone(c.phone)}
                        </a>
                      )}
                      {c.email && (
                        <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
                          <Mail aria-hidden="true" className="size-3.5 shrink-0" />
                          {c.email}
                        </span>
                      )}
                      {c.birthday && (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <Cake aria-hidden="true" className="size-3.5" />
                          doğum günü {fmtBirthday(c.birthday)}
                        </span>
                      )}
                    </div>
                  )}
                  {c.note && <p className="mt-1 text-pretty text-sm italic text-ink-2">{c.note}</p>}
                </div>
              )}
            </div>
            <div className={cn('grid grid-cols-2 gap-3', stamps ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
              <Stat label="Açık hesap" value={tl(c.balance)} hint={c.creditLimit != null ? `sınır ${tl(c.creditLimit)}` : 'sınırsız'} tone={c.creditLimit != null && c.balance > c.creditLimit ? 'bad' : undefined} />
              {stamps && <Stat label="Damga" value={`${c.stamps} / ${goal}`} />}
              <Stat label="Toplam harcama" value={tl(c.totalSpent)} />
              <Stat label="Ziyaret" value={String(c.visits)} hint={c.lastVisitAt ? `son ${fmtDateTime(c.lastVisitAt)}` : undefined} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
              {/* Sınır, bakiyesini değiştirdiği hesabın kartında */}
              <Card
                title="Hesap hareketleri"
                actions={
                  can('cari.yonet') && (
                    <Button size="sm" onClick={() => void changeLimit(c)}>
                      Sınırı değiştir
                    </Button>
                  )
                }
              >
                {detail.data!.ledger.length === 0 ? (
                  <EmptyState compact title="Hareket yok">
                    Açık hesaba yazılan satış ve tahsilat burada
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-[var(--admin-divider)]">
                    {detail.data!.ledger.map((l) => (
                      // Açıklama üstte, tür ve tarih altında; tutar bakiyeye etkisiyle (borç artı, tahsilat eksi ve yeşil)
                      <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{l.note || LEDGER_LABEL[l.kind]}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                            {l.note && <Badge>{LEDGER_LABEL[l.kind]}</Badge>}
                            <span className="tabular">{fmtDateTime(l.createdAt)}</span>
                          </span>
                        </span>
                        <span className={cn('tabular shrink-0 text-right font-semibold', l.kind === 'tahsilat' && 'text-success-ink')}>
                          {l.amount < 0 ? '−' : '+'}
                          {tl(Math.abs(l.amount))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card
                title="Adresler"
                actions={
                  <Button
                    size="sm"
                    icon={<MapPin className="size-4" />}
                    onClick={() => {
                      setAddressError(null);
                      setAddress({ title: 'Ev', address: '' });
                    }}
                  >
                    Adres ekle
                  </Button>
                }
              >
                {detail.data!.addresses.length === 0 ? (
                  <EmptyState compact title="Adres yok">
                    Paket siparişte adres buradan seçilir
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-[var(--admin-divider)]">
                    {detail.data!.addresses.map((a) => (
                      <li key={a.id} className="px-4 py-2.5 text-sm">
                        <span className="block font-medium">{a.title}</span>
                        <span className="block text-pretty text-ink-2">{a.address}</span>
                        {a.note && <span className="mt-0.5 block text-xs text-muted">{a.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="Son siparişler">
              {detail.data!.orders.length === 0 ? (
                <EmptyState compact icon={<Receipt />} title="Henüz sipariş yok">
                  Bu müşteri adisyona eklenince siparişleri burada görünür
                </EmptyState>
              ) : (
                <ul className="divide-y divide-[var(--admin-divider)]">
                  {detail.data!.orders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span className="tabular min-w-0">
                        #{o.no} <span className="text-muted">· {fmtDateTime(o.openedAt)}</span>
                      </span>
                      <span className="tabular shrink-0 font-semibold">{tl(o.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </section>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        persistent={busy === 'save'}
        title="Yeni müşteri"
        footer={
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button variant="primary" loading={busy === 'save'} onClick={save}>
              Müşteriyi kaydet
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <Field label="Ad soyad" className="sm:col-span-2" required error={formError.name}>
            <Input
              ref={nameRef}
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setFormError((x) => ({ ...x, name: undefined }));
              }}
              maxLength={80}
              autoFocus={fine}
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </Field>
          <Field label="Telefon">
            <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} inputMode="tel" spellCheck={false} />
          </Field>
          <Field label="E-posta">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={120} type="email" spellCheck={false} autoCapitalize="none" />
          </Field>
          <Field label="Doğum günü">
            <Input value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} type="date" />
          </Field>
          {can('cari.yonet') && (
            <Field label="Açık hesap sınırı (₺)" hint="boşsa sınırsız" error={formError.creditLimit}>
              <Input
                value={form.creditLimit}
                onChange={(e) => {
                  setForm({ ...form, creditLimit: e.target.value });
                  setFormError((x) => ({ ...x, creditLimit: undefined }));
                }}
                inputMode="decimal"
                placeholder="Ör. 500"
              />
            </Field>
          )}
          <Field label="Not" className="sm:col-span-2">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} />
          </Field>
          <p className="text-pretty text-xs text-muted sm:col-span-2">Kişisel veriler yalnız bu kafe bilgisayarında tutulur, başka sisteme gönderilmez (KVKK)</p>
        </div>
      </Modal>

      <Modal
        open={!!collect}
        onClose={() => setCollect(null)}
        persistent={busy === 'collect'}
        size="sm"
        title="Açık hesap tahsilatı"
        subtitle={c ? `${c.name} · bakiye ${tl(c.balance)}` : ''}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setCollect(null)}>Vazgeç</Button>
            <Button variant="ink" loading={busy === 'collect'} onClick={doCollect}>
              {collectAmount > 0 ? `${tl(collectAmount)} tahsil et` : 'Tahsil et'}
            </Button>
          </div>
        }
      >
        {collect && (
          <div className="space-y-3 p-5">
            <p className="text-pretty text-[13px] text-muted">Tahsilat ciroya girmez (satış zaten açık hesaba yazıldı); nakitse kasaya girer</p>
            <Field label="Ödeme türü">
              <Select value={collect.methodId} onChange={(e) => setCollect({ ...collect, methodId: e.target.value })}>
                {collectMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tutar (₺)" error={collectError}>
              <Input
                value={collect.amount}
                onChange={(e) => {
                  setCollect({ ...collect, amount: e.target.value });
                  setCollectError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.repeat) void doCollect();
                }}
                inputMode="decimal"
                enterKeyHint="done"
                className="tabular text-right"
              />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={!!address}
        onClose={() => setAddress(null)}
        persistent={busy === 'address'}
        size="sm"
        title="Adres ekle"
        subtitle={c?.name}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setAddress(null)}>Vazgeç</Button>
            <Button variant="primary" loading={busy === 'address'} onClick={saveAddress}>
              Adresi kaydet
            </Button>
          </div>
        }
      >
        {address && (
          <div className="space-y-3 p-5">
            <Field label="Başlık">
              <Input value={address.title} onChange={(e) => setAddress({ ...address, title: e.target.value })} maxLength={30} placeholder="Ör. ev, iş" />
            </Field>
            <Field label="Adres" required error={addressError}>
              <Textarea
                value={address.address}
                onChange={(e) => {
                  setAddress({ ...address, address: e.target.value });
                  setAddressError(null);
                }}
                maxLength={400}
                placeholder="Mahalle, cadde, no, daire"
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
