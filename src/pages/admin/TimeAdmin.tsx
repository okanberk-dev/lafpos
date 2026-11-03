import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Download, LogOut, Pencil, Plus, Timer, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { businessDate, fmtDateShort, fmtTime, istanbulParts, MAX_SHIFT_MS, STALE_SHIFT_MS } from '@shared/time';
import type { TimeEntryDTO, TimeSheetDTO } from '@shared/types';
import { ActionMenu, Badge, Card, CARD, type Column, DataTable, EmptyState, KpiStrip, PageHeader, QuickLook, Segmented, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/misc';
import { del, errorMessage, get, getToken, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { useTick } from '@/lib/hooks';
import { fmtDuration } from '@/lib/mesai';
import { draftErrors, draftOf, draftTimes, editBody, type MesaiDraft } from '@/lib/mesaiDraft';
import { PERIOD_LABELS, type PeriodKey, periodRange } from '@/lib/period';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

// Geçen hafta ve geçen ay: bordro geçmiş dönemin çizelgesini ve CSV'sini ister
type Period = Exclude<PeriodKey, 'ozel'>;
const PERIODS: Period[] = ['bugun', 'dun', 'hafta', 'gecenhafta', 'ay', 'gecenay'];
const SOURCE: Record<TimeEntryDTO['source'], string> = { pin: 'Kilit ekranından', oturum: 'Oturumdan', yonetim: 'Elle kayıt' };

/** 24 saati geçen açık mesai: çıkışı unutulmuş, süresi sayılmaz (sunucunun kuralı); çıkış saati girilmeli */
const overdue = (e: TimeEntryDTO, now: number) => e.open && now - e.clockIn > MAX_SHIFT_MS;
const openMs = (e: TimeEntryDTO, now: number) => (e.open ? Math.max(0, now - e.clockIn) : e.durationMs);

/**
 * Yönetim › Mesai çizelgesi: personelin PIN'le ya da oturumdan yaptığı giriş-çıkışlar, kişi başına süre, şu an
 * içeride olanlar. Yönetici unutulan çıkışı kapatır, saati düzeltir, elle kayıt girer; her düzeltme denetim kaydına
 * yazılır (sunucu). CSV dönemin kayıtlarını indirir.
 */
export default function TimeAdmin() {
  const qc = useQueryClient();
  const boot = useBoot();
  const now = useTick(30_000);
  const today = businessDate(now);
  const [period, setPeriod] = useState<Period>('bugun');
  const range = periodRange(period, today);
  const sheet = useQuery({ queryKey: ['time', 'sheet', range.from, range.to], queryFn: () => get<TimeSheetDTO>(`/time?from=${range.from}&to=${range.to}`) });
  const [edit, setEdit] = useState<MesaiDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const me = useAuth((s) => s.me);
  /** Sunucunun kuralı: yönetici kendi mesaisini değiştiremez (patron hariç); seçenek baştan sunulmaz */
  const canChange = (userId: string) => me?.role === 'patron' || userId !== me?.id;
  const staff = boot.users.filter((u) => u.active && canChange(u.id));

  const refresh = () => qc.invalidateQueries({ queryKey: ['time'] });
  const openNew = () => {
    setTried(false);
    setEdit({ userId: staff[0]?.id ?? '', date: today, inTime: '09:00', outTime: '17:00', note: '' });
  };
  const openEdit = (e: TimeEntryDTO) => {
    if (!canChange(e.userId)) return;
    setTried(false);
    setEdit(draftOf(e));
  };

  const errors = edit ? draftErrors(edit, Date.now()) : {};

  const save = async () => {
    if (!edit) return;
    if (errors.in || errors.out || errors.who) {
      setTried(true);
      return;
    }
    setSaving(true);
    try {
      const note = edit.note.trim() || null;
      if (edit.entry) {
        // Yalnız değişen alan gider (editBody); değişiklik yoksa istek de yok
        const body = editBody(edit);
        if (!body) {
          setEdit(null);
          return;
        }
        await patch(`/time/entries/${edit.entry.id}`, body);
      } else {
        const { clockIn, clockOut } = draftTimes(edit);
        await post('/time/entries', { userId: edit.userId, clockIn, clockOut, note });
      }
      toast.ok(edit.entry ? 'Mesai düzeltildi; denetim kaydına yazıldı' : 'Mesai kaydı eklendi');
      setEdit(null);
      await refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const closeNow = async (e: TimeEntryDTO) => {
    try {
      await post(`/time/entries/${e.id}/close`, {});
      toast.ok(`${e.userName} için mesai kapatıldı`);
      await refresh();
    } catch (err) {
      toast.err(errorMessage(err));
    }
  };
  const remove = async (e: TimeEntryDTO) => {
    const ok = await confirmDialog({ title: 'Mesai kaydı silinsin mi', body: `${e.userName} · ${fmtDateShort(e.businessDate)} ${fmtTime(e.clockIn)}. Silme denetim kaydına yazılır`, confirmLabel: 'Kaydı sil', tone: 'danger' });
    if (!ok) return;
    try {
      await del(`/time/entries/${e.id}`);
      toast.ok('Mesai kaydı silindi');
      await refresh();
    } catch (err) {
      toast.err(errorMessage(err));
    }
  };
  const exportCsv = async () => {
    const res = await fetch(`/api/time/export.csv?from=${range.from}&to=${range.to}`, { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      toast.err(body?.error ?? 'CSV alınamadı; bağlantıyı kontrol edip yeniden deneyin');
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? `lafpos-mesai-${range.from}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const data = sheet.data;
  // Dönemden bağımsız: çıkışı unutulan eski mesai seçili dönemde görünmese de buradan düzeltilir
  const forgotten = data?.clockedIn.filter((e) => now - e.clockIn > STALE_SHIFT_MS) ?? [];
  const totalMs = data?.totals.reduce((a, t) => a + t.workedMs, 0) ?? 0;
  const top = Math.max(1, ...(data?.totals.map((t) => t.workedMs) ?? [1]));
  const columns: Column<TimeEntryDTO>[] = [
    {
      key: 'kisi',
      header: 'Kişi',
      cell: (e) => (
        <span className="flex items-center gap-3">
          <Avatar name={e.userName} color={e.userColor} />
          <span className="min-w-0">
            <span className="block font-medium text-[var(--admin-text)]">{e.userName}</span>
            <span className="block text-xs text-[var(--admin-text-mute)]">{SOURCE[e.source]}</span>
          </span>
        </span>
      ),
    },
    { key: 'gun', header: 'Gün', cell: (e) => fmtDateShort(e.businessDate), hideBelow: 'lg' },
    { key: 'giris', header: 'Giriş', cell: (e) => <span className="tabular-nums">{fmtTime(e.clockIn)}</span> },
    {
      key: 'cikis',
      header: 'Çıkış',
      cell: (e) =>
        e.open ? (
          <Badge tone={now - e.clockIn > STALE_SHIFT_MS ? 'warning' : 'success'} dot>
            {now - e.clockIn > STALE_SHIFT_MS ? 'Çıkış yok' : 'Mesaide'}
          </Badge>
        ) : (
          <span className="tabular-nums">{fmtTime(e.clockOut!)}</span>
        ),
    },
    {
      key: 'sure',
      header: 'Süre',
      align: 'right',
      cell: (e) => (overdue(e, now) ? <span className="text-[var(--admin-warning)]">Çıkış girilmeli</span> : <span className="font-semibold tabular-nums">{fmtDuration(openMs(e, now))}</span>),
    },
    { key: 'not', header: 'Not', cell: (e) => <span className="text-[var(--admin-text-mute)]">{joinMeta([e.note, e.editedByName && `düzelten ${e.editedByName}`]) || '—'}</span>, hideBelow: 'xl' },
  ];

  return (
    <>
      <PageHeader
        title="Mesai çizelgesi"
        description="PIN ile giriş-çıkış (kilit ekranındaki Mesai sekmesi ya da kullanıcı menüsü); düzeltmeler denetim kaydına yazılır"
        actions={
          <>
            <Segmented label="Dönem" value={period} onChange={setPeriod} options={PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))} className="max-lg:w-full max-lg:[&>*]:grow" />
            <Button icon={<Download className="size-4" />} onClick={() => void exportCsv()}>
              CSV
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openNew}>
              Elle kayıt
            </Button>
          </>
        }
      />
      {sheet.isPending ? (
        <TableSkeleton rows={5} />
      ) : sheet.isError && !data ? (
        <ErrorState className={CARD} title="Mesai çizelgesi alınamadı" error={sheet.error} onRetry={() => void sheet.refetch()} retrying={sheet.isFetching} />
      ) : data ? (
        <div className="space-y-4">
          <KpiStrip
            cells={[
              {
                key: 'icerde',
                label: 'Şu an mesaide',
                icon: <Users />,
                hue: 'green',
                value: data.clockedIn.length,
                reference: data.clockedIn.length ? data.clockedIn.map((e) => e.userName).join(', ') : 'Kimse içeride değil',
              },
              { key: 'toplam', label: 'Toplam süre', icon: <Timer />, hue: 'blue', value: fmtDuration(totalMs), reference: `${data.totals.length} kişi · ${PERIOD_LABELS[period].toLocaleLowerCase('tr-TR')}` },
              { key: 'mesai', label: 'Mesai', icon: <Clock3 />, hue: 'violet', value: data.entries.length, reference: `${data.entries.filter((e) => e.open).length} açık` },
              { key: 'ortalama', label: 'Kişi başı', icon: <Timer />, hue: 'amber', value: fmtDuration(data.totals.length ? totalMs / data.totals.length : 0), reference: 'dönem ortalaması' },
            ]}
          />

          {forgotten.length > 0 && (
            <Card title="Çıkışı unutulanlar" subtitle="14 saatten uzun açık mesai; çıkış saati girilene kadar kişi kilit ekranından yeniden giriş yapamaz" flush>
              <ul className="divide-y divide-[var(--admin-divider)]">
                {forgotten.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                    <Avatar name={e.userName} color={e.userColor} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{e.userName}</span>
                      <span className="block text-xs text-[var(--admin-text-mute)]">
                        Giriş {fmtDateShort(istanbulParts(e.clockIn).date)} {fmtTime(e.clockIn)} · {overdue(e, now) ? '24 saatten uzun açık, süresi sayılmıyor' : `${fmtDuration(now - e.clockIn)} açık`}
                      </span>
                    </span>
                    {canChange(e.userId) && (
                      <Button icon={<Pencil className="size-4" />} onClick={() => openEdit(e)}>
                        Çıkış saatini gir
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.totals.length > 0 && (
            <Card title="Kişi toplamları" subtitle="Dönemdeki mesailerin toplamı; açık mesai şu ana kadar" flush>
              <ul className="divide-y divide-[var(--admin-divider)]">
                {data.totals.map((t) => (
                  <li key={t.userId} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                    <Avatar name={t.userName} color={t.userColor} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {t.userName}
                        {t.openNow && (
                          <Badge tone="success" dot>
                            Mesaide
                          </Badge>
                        )}
                      </span>
                      <span className="mt-1.5 block h-1.5 w-full max-w-sm rounded-full bg-[var(--chart-track)]">
                        <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(2, (t.workedMs / top) * 100)}%`, background: 'var(--chart-accent)' }} />
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-sm font-semibold tabular-nums">{fmtDuration(t.workedMs)}</span>
                      <span className="block text-xs text-[var(--admin-text-mute)]">{t.shifts} mesai</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <DataTable
            caption="Mesai kayıtları"
            rows={data.entries}
            columns={columns}
            rowKey={(e) => e.id}
            onOpen={openEdit}
            selectedKey={edit?.entry?.id ?? null}
            phoneMeta={(e) => joinMeta([fmtDateShort(e.businessDate), `${fmtTime(e.clockIn)}–${e.clockOut ? fmtTime(e.clockOut) : 'mesaide'}`, overdue(e, now) ? 'çıkış girilmeli' : fmtDuration(openMs(e, now))])}
            empty={
              <EmptyState art="saat" title={period === 'bugun' ? 'Bugün henüz mesai yok' : 'Bu dönemde mesai yok'} action={<Button onClick={openNew}>Elle kayıt</Button>}>
                Personel kilit ekranındaki Mesai sekmesinden PIN’iyle ya da kullanıcı menüsünden giriş-çıkış yapar
              </EmptyState>
            }
            actions={(e) =>
              canChange(e.userId) ? (
                <ActionMenu
                  label={`${e.userName} mesaisi`}
                  items={[
                    { key: 'duzelt', label: 'Düzelt', icon: <Pencil />, onSelect: () => openEdit(e) },
                    // 24 saatten eski açık mesai şimdiye kapatılamaz (sunucu reddeder): çıkış saati girilir
                    ...(e.open
                      ? [
                          overdue(e, now)
                            ? { key: 'cikis', label: 'Çıkış saatini gir', icon: <LogOut />, onSelect: () => openEdit(e) }
                            : { key: 'kapat', label: 'Şimdi kapat', icon: <LogOut />, onSelect: () => void closeNow(e) },
                        ]
                      : []),
                    { key: 'sil', label: 'Sil', icon: <Trash2 />, danger: true, onSelect: () => void remove(e) },
                  ]}
                />
              ) : null
            }
          />
        </div>
      ) : null}

      <QuickLook
        open={!!edit}
        onClose={() => setEdit(null)}
        label={edit?.entry ? 'Mesai düzeltme' : 'Elle mesai kaydı'}
        title={edit?.entry ? 'Mesaiyi düzelt' : 'Elle mesai kaydı'}
        subtitle={edit?.entry ? 'Eski ve yeni saat denetim kaydına yazılır' : 'Unutulan giriş-çıkış için; denetim kaydına yazılır'}
        footer={
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setEdit(null)}>
              Vazgeç
            </Button>
            <Button className="flex-1" variant="primary" loading={saving} onClick={() => void save()}>
              Kaydet
            </Button>
          </div>
        }
      >
        {edit && (
          <div className="space-y-4">
            <Field label="Kişi" error={tried ? errors.who : null}>
              {/* Düzeltmede kaydın kendi kişisi (hesabı kapanmış olsa da); elle kayıtta değiştirilebilecek kişiler */}
              <Select value={edit.userId} disabled={!!edit.entry} onChange={(e) => setEdit({ ...edit, userId: e.target.value })}>
                {(edit.entry ? [{ id: edit.entry.userId, name: edit.entry.userName }] : staff).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="İş günü" hint="sabah 05:00'te başlar">
              <Input type="date" value={edit.date} max={today} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Giriş" error={tried ? errors.in : null}>
                <Input type="time" value={edit.inTime} onChange={(e) => setEdit({ ...edit, inTime: e.target.value })} />
              </Field>
              <Field label="Çıkış" hint="boşsa mesaide" error={tried ? errors.out : null}>
                <Input type="time" value={edit.outTime} onChange={(e) => setEdit({ ...edit, outTime: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-[var(--admin-text-mute)]">Gece 00:00–04:59 arası giriş seçili iş gününün gecesidir; girişten önceki çıkış ertesi güne sayılır.</p>
            <Field label="Not" hint="isteğe bağlı">
              <Textarea value={edit.note} maxLength={200} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="Ör. çıkışı unuttu, kamerayla doğrulandı" />
            </Field>
          </div>
        )}
      </QuickLook>
    </>
  );
}

function Avatar({ name, color }: { name: string; color: string }) {
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ring-1 ring-inset ring-black/5 dark:ring-white/15" style={{ background: color }}>
      {name.slice(0, 2).toLocaleUpperCase('tr-TR')}
    </span>
  );
}
