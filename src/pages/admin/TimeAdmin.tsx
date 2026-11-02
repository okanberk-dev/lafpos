import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Download, LogOut, Pencil, Plus, Timer, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { addDays, businessDate, fmtDateShort, fmtTime, istanbulParts } from '@shared/time';
import type { TimeEntryDTO, TimeSheetDTO } from '@shared/types';
import { ActionMenu, Badge, Card, CARD, type Column, DataTable, EmptyState, KpiStrip, PageHeader, QuickLook, Segmented, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/misc';
import { del, errorMessage, get, getToken, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { useTick } from '@/lib/hooks';
import { fmtDuration } from '@/lib/mesai';
import { periodRange } from '@/lib/period';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

type Period = 'bugun' | 'hafta' | 'ay';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'bugun', label: 'Bugün' },
  { value: 'hafta', label: 'Bu hafta' },
  { value: 'ay', label: 'Bu ay' },
];
const SOURCE: Record<TimeEntryDTO['source'], string> = { pin: 'Kilit ekranından', oturum: 'Oturumdan', yonetim: 'Elle kayıt' };
/** 14 saatten uzun açık mesai: çıkışı unutulmuş olabilir */
const STALE_MS = 14 * 3600_000;

interface Draft {
  id?: string;
  userId: string;
  date: string;
  inTime: string;
  outTime: string;
  note: string;
}

const hm = (ms: number) => {
  const p = istanbulParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};
/** İstanbul saatiyle "YYYY-MM-DD" ve "HH:MM" → an (UTC+3, yaz saati yok) */
const toMs = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);

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
  const [edit, setEdit] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const staff = boot.users.filter((u) => u.active);

  const refresh = () => qc.invalidateQueries({ queryKey: ['time'] });
  const openNew = () => {
    setTried(false);
    setEdit({ userId: staff[0]?.id ?? '', date: today, inTime: '09:00', outTime: '17:00', note: '' });
  };
  const openEdit = (e: TimeEntryDTO) => {
    setTried(false);
    const inParts = istanbulParts(e.clockIn);
    setEdit({ id: e.id, userId: e.userId, date: inParts.date, inTime: hm(e.clockIn), outTime: e.clockOut ? hm(e.clockOut) : '', note: e.note ?? '' });
  };

  // Çıkış girişten önceyse ertesi güne taşar (gece yarısını geçen vardiya)
  const draftTimes = (d: Draft) => {
    const clockIn = toMs(d.date, d.inTime);
    let clockOut = d.outTime ? toMs(d.date, d.outTime) : null;
    if (clockOut != null && clockOut <= clockIn) clockOut = toMs(addDays(d.date, 1), d.outTime);
    return { clockIn, clockOut };
  };
  const timeError = edit && (!/^\d{2}:\d{2}$/.test(edit.inTime) ? 'Giriş saati gerekli' : edit.outTime && !/^\d{2}:\d{2}$/.test(edit.outTime) ? 'Saat ss:dd biçiminde' : null);
  const futureError = (() => {
    if (!edit || timeError) return null;
    const t = draftTimes(edit);
    // Sunucu bir dakikaya kadar ileriyi kabul eder (saat kayması); ötesi gelecektir
    return t.clockIn > Date.now() + 60_000 || (t.clockOut != null && t.clockOut > Date.now() + 60_000) ? 'Gelecekteki bir saat girilemez' : null;
  })();

  const save = async () => {
    if (!edit) return;
    if (timeError || futureError || !edit.userId) {
      setTried(true);
      return;
    }
    setSaving(true);
    try {
      const { clockIn, clockOut } = draftTimes(edit);
      const note = edit.note.trim() || null;
      if (edit.id) await patch(`/time/entries/${edit.id}`, { clockIn, clockOut, note });
      else await post('/time/entries', { userId: edit.userId, clockIn, clockOut, note });
      toast.ok(edit.id ? 'Mesai düzeltildi; denetim kaydına yazıldı' : 'Mesai kaydı eklendi');
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
          <Badge tone={now - e.clockIn > STALE_MS ? 'warning' : 'success'} dot>
            {now - e.clockIn > STALE_MS ? 'Çıkış yok' : 'Mesaide'}
          </Badge>
        ) : (
          <span className="tabular-nums">{fmtTime(e.clockOut!)}</span>
        ),
    },
    { key: 'sure', header: 'Süre', align: 'right', cell: (e) => <span className="font-semibold tabular-nums">{fmtDuration(e.open ? now - e.clockIn : e.durationMs)}</span> },
    { key: 'not', header: 'Not', cell: (e) => <span className="text-[var(--admin-text-mute)]">{joinMeta([e.note, e.editedByName && `düzelten ${e.editedByName}`]) || '—'}</span>, hideBelow: 'xl' },
  ];

  return (
    <>
      <PageHeader
        title="Mesai çizelgesi"
        description="PIN ile giriş-çıkış (kilit ekranındaki Mesai sekmesi ya da kullanıcı menüsü); düzeltmeler denetim kaydına yazılır"
        actions={
          <>
            <Segmented label="Dönem" value={period} onChange={setPeriod} options={PERIODS} />
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
              { key: 'toplam', label: 'Toplam süre', icon: <Timer />, hue: 'blue', value: fmtDuration(totalMs), reference: `${data.totals.length} kişi · ${PERIODS.find((p) => p.value === period)!.label.toLocaleLowerCase('tr-TR')}` },
              { key: 'mesai', label: 'Mesai', icon: <Clock3 />, hue: 'violet', value: data.entries.length, reference: `${data.entries.filter((e) => e.open).length} açık` },
              { key: 'ortalama', label: 'Kişi başı', icon: <Timer />, hue: 'amber', value: fmtDuration(data.totals.length ? totalMs / data.totals.length : 0), reference: 'dönem ortalaması' },
            ]}
          />

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
            selectedKey={edit?.id ?? null}
            phoneMeta={(e) => joinMeta([fmtDateShort(e.businessDate), `${fmtTime(e.clockIn)}–${e.clockOut ? fmtTime(e.clockOut) : 'mesaide'}`, fmtDuration(e.open ? now - e.clockIn : e.durationMs)])}
            empty={
              <EmptyState art="saat" title={period === 'bugun' ? 'Bugün henüz mesai yok' : 'Bu dönemde mesai yok'} action={<Button onClick={openNew}>Elle kayıt</Button>}>
                Personel kilit ekranındaki Mesai sekmesinden PIN’iyle ya da kullanıcı menüsünden giriş-çıkış yapar
              </EmptyState>
            }
            actions={(e) => (
              <ActionMenu
                label={`${e.userName} mesaisi`}
                items={[
                  { key: 'duzelt', label: 'Düzelt', icon: <Pencil />, onSelect: () => openEdit(e) },
                  ...(e.open ? [{ key: 'kapat', label: 'Şimdi kapat', icon: <LogOut />, onSelect: () => void closeNow(e) }] : []),
                  { key: 'sil', label: 'Sil', icon: <Trash2 />, danger: true, onSelect: () => void remove(e) },
                ]}
              />
            )}
          />
        </div>
      ) : null}

      <QuickLook
        open={!!edit}
        onClose={() => setEdit(null)}
        label={edit?.id ? 'Mesai düzeltme' : 'Elle mesai kaydı'}
        title={edit?.id ? 'Mesaiyi düzelt' : 'Elle mesai kaydı'}
        subtitle={edit?.id ? 'Eski ve yeni saat denetim kaydına yazılır' : 'Unutulan giriş-çıkış için; denetim kaydına yazılır'}
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
            <Field label="Kişi">
              <Select value={edit.userId} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, userId: e.target.value })}>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="İş günü" hint="girişin günü">
              <Input type="date" value={edit.date} max={today} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Giriş" error={tried ? timeError : null}>
                <Input type="time" value={edit.inTime} onChange={(e) => setEdit({ ...edit, inTime: e.target.value })} />
              </Field>
              <Field label="Çıkış" hint="boşsa mesaide" error={tried ? futureError : null}>
                <Input type="time" value={edit.outTime} onChange={(e) => setEdit({ ...edit, outTime: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-[var(--admin-text-mute)]">Çıkış girişten önceyse ertesi güne sayılır (gece yarısını geçen vardiya).</p>
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
