import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Download, Hourglass, LogOut, Pencil, Plus, Save, Trash2, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import { businessDate, fmtDateShort, fmtTime, istanbulParts, shiftForgotten } from '@shared/time';
import type { TimeEntryDTO, TimeSheetDTO } from '@shared/types';
import { ActionMenu, Badge, Card, CARD, type Column, DataTable, EmptyState, KpiStrip, KpiStripSkeleton, PageHeader, QuickLook, Segmented, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Avatar, ErrorState } from '@/components/ui/misc';
import { del, errorMessage, get, getToken, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer, useTick } from '@/lib/hooks';
import { fmtDuration } from '@/lib/mesai';
import { draftErrors, draftOf, draftTimes, editBody, type MesaiDraft } from '@/lib/mesaiDraft';
import { PERIOD_LABELS, type PeriodKey, periodRange, rangeLabel } from '@/lib/period';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

// Geçen hafta ve geçen ay: bordro geçmiş dönemin çizelgesini ve CSV'sini ister
type Period = Exclude<PeriodKey, 'ozel'>;
const PERIODS: Period[] = ['bugun', 'dun', 'hafta', 'gecenhafta', 'ay', 'gecenay'];
const SOURCE: Record<TimeEntryDTO['source'], string> = { pin: 'Kilit ekranından', oturum: 'Oturumdan', yonetim: 'Elle kayıt' };

/** Çıkışı unutulmuş açık mesai (önceki iş gününden, 8 saatten uzun; sunucunun kuralı): süresi sayılmaz, çıkış girilmeli */
const forgottenEntry = (e: TimeEntryDTO, now: number) => e.open && shiftForgotten(e.clockIn, now);
const openMs = (e: TimeEntryDTO, now: number) => (e.open ? Math.max(0, now - e.clockIn) : e.durationMs);
/**
 * Kayda son dokunan yönetici (elle kayıt, düzeltme ya da kapatma), CSV'deki "Düzelten" sütunu gibi. Sunucu yalnız
 * sonuncuyu tutar (`editedBy`): elle kaydı ikinci bir yönetici düzeltirse ya da kapatırsa kaydı girenin adı ezilir,
 * bu yüzden elle kayıtta da "kaydeden" denmez (kimin girdiği denetim kaydında)
 */
const editorNote = (e: TimeEntryDTO) => e.editedByName && `düzelten ${e.editedByName}`;

/**
 * Yönetim › Mesai çizelgesi: personelin PIN'le ya da oturumdan yaptığı giriş-çıkışlar, kişi başına süre, şu an
 * içeride olanlar. Yönetici unutulan çıkışı kapatır, saati düzeltir, elle kayıt girer; her düzeltme denetim kaydına
 * yazılır (sunucu). CSV dönemin kayıtlarını indirir.
 */
export default function TimeAdmin() {
  const qc = useQueryClient();
  const boot = useBoot();
  const now = useTick(30_000);
  const fine = useFinePointer();
  const today = businessDate(now);
  const [period, setPeriod] = useState<Period>('bugun');
  const range = periodRange(period, today);
  // Dönem değişince önceki çizelge yerinde kalır (soluk), yenisi gelince değişir: her dokunuşta iskelete dönmez
  const sheet = useQuery({ queryKey: ['time', 'sheet', range.from, range.to], queryFn: () => get<TimeSheetDTO>(`/time?from=${range.from}&to=${range.to}`), placeholderData: keepPreviousData });
  const [edit, setEdit] = useState<MesaiDraft | null>(null);
  // "Çıkış saatini gir" ile açılan düzeltme: çıkış zorunlu ve odakta (boş bırakılırsa mesai unutulmuş kalır)
  const [focusOut, setFocusOut] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const me = useAuth((s) => s.me);
  /** Sunucunun kuralı: yönetici kendi mesaisini değiştiremez (patron hariç); seçenek baştan sunulmaz */
  const canChange = (userId: string) => me?.role === 'patron' || userId !== me?.id;
  const staff = boot.users.filter((u) => u.active && canChange(u.id));

  const refresh = () => qc.invalidateQueries({ queryKey: ['time'] });
  const close = () => {
    setEdit(null);
    setFocusOut(false);
  };
  const openNew = () => {
    setTried(false);
    setFocusOut(false);
    // Kişi ve saat boş gelir: hazır 09:00–17:00 gün içinde "gelecekteki saat" hatası verirdi, önseçili kişi tek
    // dokunuşla yanlış kişiye mesai yazdırırdı. Kaydet eksik alanı söyler (Kişi seçin, Giriş saati gerekli)
    setEdit({ userId: '', date: today, inTime: '', outTime: '', note: '' });
  };
  const openEdit = (e: TimeEntryDTO, out = false) => {
    if (!canChange(e.userId)) {
      toast.info('Kendi mesai kaydınızı başka bir yetkili düzeltir');
      return;
    }
    setTried(false);
    setFocusOut(out);
    setEdit(draftOf(e));
  };

  const errors = edit ? draftErrors(edit, Date.now()) : {};
  // Çıkışı unutulan mesai satırdan ya da "Düzelt"ten açılınca da boş çıkış "mesaide" demek değil: süresi sayılmaz
  const forgottenEdit = !!edit?.entry && forgottenEntry(edit.entry, now);
  const outMissing = focusOut && !!edit && !edit.outTime;
  const outError = errors.out ?? (outMissing ? 'Çıkış saatini girin' : undefined);

  const save = async () => {
    if (!edit || saving) return;
    if (errors.in || errors.out || errors.who || errors.date || outMissing) {
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
          close();
          return;
        }
        await patch(`/time/entries/${edit.entry.id}`, body);
      } else {
        const { clockIn, clockOut } = draftTimes(edit);
        await post('/time/entries', { userId: edit.userId, clockIn, clockOut, note });
      }
      toast.ok(edit.entry ? 'Mesai düzeltildi; denetim kaydına yazıldı' : 'Mesai kaydı eklendi');
      close();
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
  const forgotten = data?.clockedIn.filter((e) => forgottenEntry(e, now)) ?? [];
  // Şu an mesaide: çıkışı unutulmuş eski mesai içeride sayılmaz (ayrıca söylenir)
  const atWork = data?.clockedIn.filter((e) => !forgottenEntry(e, now)) ?? [];
  const openOf = new Map((data?.clockedIn ?? []).map((e) => [e.userId, e]));
  const totalMs = data?.totals.reduce((a, t) => a + t.workedMs, 0) ?? 0;
  const top = Math.max(1, ...(data?.totals.map((t) => t.workedMs) ?? [1]));
  const people = data?.totals.length ?? 0;
  const openCount = data?.entries.filter((e) => e.open).length ?? 0;
  // Kişi hücresinin yazısı: tabloda avatarın yanında, telefonun satır kartında başlık (avatar kartın solunda, alt satır
  // adın hizasından başlar)
  const who = (e: TimeEntryDTO) => (
    <span className="min-w-0">
      <span className="block font-medium text-[var(--admin-text)]">{e.userName}</span>
      <span className="block text-xs text-[var(--admin-text-mute)]">{SOURCE[e.source]}</span>
    </span>
  );
  const columns: Column<TimeEntryDTO>[] = [
    {
      key: 'kisi',
      header: 'Kişi',
      cell: (e) => (
        <span className="flex items-center gap-3">
          <Avatar name={e.userName} color={e.userColor} />
          {who(e)}
        </span>
      ),
    },
    // Yalnız Not sütunu kırılır: gün, saat ve süre tek parça kalır ("2 sa 30 / dk" olmaz)
    { key: 'gun', header: 'Gün', cell: (e) => <span className="whitespace-nowrap">{fmtDateShort(e.businessDate)}</span>, hideBelow: 'lg' },
    { key: 'giris', header: 'Giriş', cell: (e) => <span className="whitespace-nowrap tabular-nums">{fmtTime(e.clockIn)}</span> },
    {
      key: 'cikis',
      header: 'Çıkış',
      cell: (e) =>
        e.open ? (
          <Badge tone={forgottenEntry(e, now) ? 'warning' : 'success'} dot>
            {forgottenEntry(e, now) ? 'Çıkış yok' : 'Mesaide'}
          </Badge>
        ) : (
          <span className="whitespace-nowrap tabular-nums">{fmtTime(e.clockOut!)}</span>
        ),
    },
    {
      key: 'sure',
      header: 'Süre',
      align: 'right',
      // Çıkışı unutulan mesaide rakam yerine kelime yazılmaz: "—", nedeni ipucunda (durumu Çıkış sütunu söyler)
      cell: (e) =>
        forgottenEntry(e, now) ? (
          <span title="Sayılmadı: çıkış saati girilmeli" className="text-[var(--admin-text-mute)]">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Sayılmadı</span>
          </span>
        ) : (
          <span className="whitespace-nowrap font-semibold tabular-nums">{fmtDuration(openMs(e, now))}</span>
        ),
    },
    {
      key: 'not',
      header: 'Not',
      className: 'min-w-40',
      cell: (e) => {
        const text = joinMeta([e.note, editorNote(e)]);
        return (
          <span className="text-[var(--admin-text-mute)]">
            {text || (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Not yok</span>
              </>
            )}
          </span>
        );
      },
      hideBelow: 'xl',
    },
  ];

  return (
    <>
      <PageHeader
        title="Mesai çizelgesi"
        description="PIN ile giriş-çıkış (kilit ekranındaki Mesai sekmesi ya da kullanıcı menüsü); düzeltmeler denetim kaydına yazılır"
        actions={
          <>
            <Button icon={<Download className="size-4" />} onClick={() => void exportCsv()}>
              CSV
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openNew}>
              Elle kayıt
            </Button>
          </>
        }
      >
        {/* Altı dönem başlığın yanına sığmaz (1024 px'te başlık eziliyordu): kendi satırında. Telefonda Raporlar'daki gibi
            açılır liste: kaydırmalı rayda bordronun istediği "Geçen ay" ekran dışında kalıyordu. Ray kendi kabında gizlenir
            (kitin telefondaki görünüm sınıfı sayfanın gizleme sınıfını ezmesin) */}
        <div className="mt-3">
          <Select aria-label="Dönem" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="md:hidden">
            {PERIODS.map((value) => (
              <option key={value} value={value}>
                {PERIOD_LABELS[value]}
              </option>
            ))}
          </Select>
          <div className="max-md:hidden">
            <Segmented label="Dönem" value={period} onChange={setPeriod} options={PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))} className="max-lg:w-full max-lg:[&>*]:grow" />
          </div>
        </div>
      </PageHeader>
      {sheet.isPending ? (
        <div className="space-y-4">
          <KpiStripSkeleton count={4} />
          <TableSkeleton rows={5} />
        </div>
      ) : sheet.isError && !data ? (
        <ErrorState className={CARD} title="Mesai çizelgesi alınamadı" error={sheet.error} onRetry={() => void sheet.refetch()} retrying={sheet.isFetching} />
      ) : data ? (
        <div aria-busy={sheet.isPlaceholderData || undefined} className={cn('space-y-4 transition-opacity duration-150', sheet.isPlaceholderData && 'opacity-60')}>
          <KpiStrip
            cells={[
              {
                key: 'icerde',
                label: 'Şu an mesaide',
                icon: <Users />,
                hue: 'green',
                value: atWork.length,
                reference: `${atWork.length ? atWork.map((e) => e.userName).join(', ') : 'Kimse içeride değil'}${forgotten.length ? ` · ${forgotten.length} çıkışı unutulmuş` : ''}`,
              },
              // Renk anlamla (hues.ts): mesaide yeşil; süre ve sayı nötr (amber gecikmenin, mor online siparişin). Dönemin
              // tarihleri çizelgenin kendisinden: önceki dönem yerinde dururken yeni dönemin tarihi yazılmaz
              { key: 'toplam', label: 'Toplam süre', icon: <Hourglass />, value: fmtDuration(totalMs), reference: `${people} kişi · ${rangeLabel(data)}` },
              { key: 'mesai', label: 'Mesai kaydı', icon: <Clock3 />, value: data.entries.length, reference: openCount ? `${openCount} açık` : 'Açık mesai yok' },
              // Kimse çalışmadıysa ortalama uydurulmaz ("0 dk" değil "—")
              { key: 'ortalama', label: 'Kişi başı', icon: <UserRound />, value: people ? fmtDuration(totalMs / people) : '—', reference: people ? 'dönem ortalaması' : 'Dönemde mesai yok' },
            ]}
          />

          {forgotten.length > 0 && (
            <Card title="Çıkışı unutulanlar" subtitle="Önceki günden açık kalan mesai: çıkış saati girilene kadar süresi sayılmaz, kişi yeniden giriş yapamaz" flush>
              <ul className="divide-y divide-[var(--admin-divider)]">
                {forgotten.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                    <Avatar name={e.userName} color={e.userColor} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{e.userName}</span>
                      <span className="block text-xs text-[var(--admin-text-mute)]">
                        Giriş {fmtDateShort(istanbulParts(e.clockIn).date)} {fmtTime(e.clockIn)} · süresi sayılmıyor
                      </span>
                    </span>
                    {/* Telefonda düğme kendi satırında, tam genişlik: yanındaki yazı üç satıra ezilmez */}
                    {canChange(e.userId) && (
                      <Button className="max-sm:w-full" icon={<Pencil className="size-4" />} onClick={() => openEdit(e, true)}>
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
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                        {t.userName}
                        {openOf.has(t.userId) &&
                          (forgottenEntry(openOf.get(t.userId)!, now) ? (
                            <Badge tone="warning" dot>
                              Çıkış yok
                            </Badge>
                          ) : (
                            <Badge tone="success" dot>
                              Mesaide
                            </Badge>
                          ))}
                      </span>
                      {/* Çubuklar kişiler arasında kıyaslanır: hepsi aynı boyda (sağdaki süre sütunu sabit), sıfır süre çizilmez */}
                      <span aria-hidden="true" className="mt-1.5 block h-1.5 w-full rounded-full bg-[var(--chart-track)]">
                        <span className="block h-1.5 rounded-full" style={{ width: `${t.workedMs ? Math.max(2, (t.workedMs / top) * 100) : 0}%`, background: 'var(--chart-accent)' }} />
                      </span>
                    </span>
                    <span className="w-28 shrink-0 text-right">
                      <span className="block whitespace-nowrap text-sm font-semibold tabular-nums">{fmtDuration(t.workedMs)}</span>
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
            onOpen={(e) => openEdit(e)}
            selectedKey={edit?.entry?.id ?? null}
            phoneLead={(e) => <Avatar name={e.userName} color={e.userColor} />}
            phoneTitle={who}
            // Açık mesai "mesaide" diye saat aralığına yazılmaz: durumu masaüstündeki gibi rozet söyler
            phoneMeta={(e) => (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{joinMeta([fmtDateShort(e.businessDate), e.clockOut ? `${fmtTime(e.clockIn)}–${fmtTime(e.clockOut)} · ${fmtDuration(e.durationMs)}` : `giriş ${fmtTime(e.clockIn)}`])}</span>
                {e.open &&
                  (forgottenEntry(e, now) ? (
                    <Badge tone="warning" dot>
                      Çıkış yok
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      Mesaide · {fmtDuration(openMs(e, now))}
                    </Badge>
                  ))}
              </span>
            )}
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
                    // Çıkışı unutulmuş mesai şimdiye kapatılmaz (uydurma uzun mesai yazılmasın): çıkış saati girilir
                    ...(e.open
                      ? [
                          forgottenEntry(e, now)
                            ? { key: 'cikis', label: 'Çıkış saatini gir', icon: <LogOut />, onSelect: () => openEdit(e, true) }
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
        onClose={close}
        label={edit?.entry ? (focusOut ? 'Çıkış saatini gir' : 'Mesai düzeltme') : 'Elle mesai kaydı'}
        title={
          edit?.entry ? (
            <span className="flex items-center gap-2.5">
              <Avatar name={edit.entry.userName} color={edit.entry.userColor} />
              {edit.entry.userName}
            </span>
          ) : (
            'Elle mesai kaydı'
          )
        }
        subtitle={
          edit?.entry
            ? focusOut
              ? 'Çıkış saati girilince mesai kapanır ve süresi sayılır'
              : 'Mesaiyi düzelt; eski ve yeni saat denetim kaydına yazılır'
            : 'Unutulan giriş-çıkış için; denetim kaydına yazılır'
        }
        footer={
          <>
            <div className="flex-1" />
            <Button onClick={close}>Vazgeç</Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
              Kaydet
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {/* Düzeltmede kişi başlıkta (kaydın kendi kişisi, hesabı kapanmış olsa da); elle kayıtta seçilir */}
            {!edit.entry && (
              <Field label="Kişi" error={tried ? errors.who : null}>
                <Select value={edit.userId} onChange={(e) => setEdit({ ...edit, userId: e.target.value })}>
                  <option value="" disabled>
                    Kişi seçin
                  </option>
                  {staff.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="İş günü" hint="sabah 05:00’te başlar" error={tried ? errors.date : null}>
              <Input type="date" value={edit.date} max={today} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Giriş" error={tried ? errors.in : null}>
                <Input type="time" value={edit.inTime} onChange={(e) => setEdit({ ...edit, inTime: e.target.value })} />
              </Field>
              {/* Unutulan çıkışta boş bırakmak "mesaide" demek değil: mesai unutulmuş kalır, süresi sayılmaz; "Çıkış saatini
                  gir" ile açılınca çıkış zorunlu */}
              <Field label="Çıkış" hint={focusOut ? 'zorunlu' : forgottenEdit ? 'boşsa sayılmaz' : 'boşsa mesaide'} error={tried ? outError : null}>
                <Input type="time" value={edit.outTime} autoFocus={focusOut && fine} onChange={(e) => setEdit({ ...edit, outTime: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-[var(--admin-text-mute)]">Gece 00:00–04:59 arası giriş seçili iş gününün gecesidir; girişten önceki çıkış ertesi güne sayılır</p>
            <Field label="Not" hint="isteğe bağlı">
              <Textarea value={edit.note} maxLength={200} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="Ör. çıkışı unuttu, kamerayla doğrulandı" />
            </Field>
          </div>
        )}
      </QuickLook>
    </>
  );
}
