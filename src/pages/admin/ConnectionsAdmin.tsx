import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { checkConnValue, CONN_GROUPS, type ConnGroup, connField, parseEnvLines } from '@shared/baglanti';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { Badge, Card, CARD, CODE, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';

/** Sunucunun görünümü (server/lib/ayar-dosyasi.ts `connectionView`): gizli alanın değeri hiç gelmez */
interface ConnView {
  available: boolean;
  restart: 'otomatik' | 'elle' | null;
  pending: boolean;
  groups: { id: string; fields: { key: string; set: boolean; value: string | null }[] }[];
}
type FieldState = ConnView['groups'][number]['fields'][number];

const QUERY = ['admin', 'baglanti'] as const;

/** Kaydedince ne olur: Windows kurulumunda bekçi yeniden başlatır, değilse elle */
const savedText = (v: ConnView) => (v.restart === 'otomatik' ? 'Kaydedildi; LafPOS yeni bilgilerle yeniden başlıyor' : 'Kaydedildi; sunucu yeniden başlatılınca geçerli olur');

/**
 * Bir bağlantının kartı (lafmaliyet, Uzaktan, site...): adres ve kimlik alanları değeriyle, gizli anahtarlar boş gelir
 * ("Tanımlı" yazar; yazılırsa değişir, boş bırakılırsa aynen kalır). Kaydet yalnız değişen alanları gönderir; adresi
 * silmek satırı kaldırır. "Bağlantıyı kaldır" kartın bütün satırlarını siler
 */
function GroupCard({ group, state, editable, onSaved }: { group: ConnGroup; state: FieldState[]; editable: boolean; onSaved: (v: ConnView) => void }) {
  const initial = () => Object.fromEntries(group.fields.map((f) => [f.key, f.kind === 'secret' ? '' : (state.find((s) => s.key === f.key)?.value ?? '')]));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const stateKey = state.map((s) => `${s.key}:${s.set}:${s.value ?? ''}`).join('|');
  // Sunucudan gelen yeni durum (kayıttan sonra, yeniden başlayınca) taslağı sıfırlar
  useEffect(() => setDraft(initial()), [stateKey]);

  const fieldOf = (key: string) => state.find((s) => s.key === key);
  const dirty = group.fields.filter((f) => (f.kind === 'secret' ? draft[f.key] !== '' : draft[f.key] !== (fieldOf(f.key)?.value ?? '')));
  const anySet = state.some((s) => s.set);
  const allSet = group.fields.filter((f) => !f.optional).every((f) => fieldOf(f.key)?.set);

  const send = async (values: Record<string, string | null>, what: 'save' | 'clear') => {
    setBusy(what);
    try {
      const v = await put<ConnView & { changed: string[] }>('/admin/baglanti', { values });
      onSaved(v);
      toast.ok(what === 'clear' ? `${group.title} bağlantısı kaldırıldı` : savedText(v));
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (busy || !dirty.length) return;
    const next: Record<string, string> = {};
    const values: Record<string, string | null> = {};
    for (const f of dirty) {
      const r = checkConnValue(f, draft[f.key] ?? '');
      if ('error' in r) next[f.key] = r.error.replace(`${f.label}: `, '');
      else values[f.key] = r.value;
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    await send(values, 'save');
  };
  const clear = async () => {
    if (busy) return;
    const ok = await confirmDialog({
      title: `${group.title} bağlantısı kaldırılsın mı`,
      body: 'Adres ve anahtarlar ayarlar dosyasından silinir; LafPOS bu sisteme bağlanmaz. Bilgileri yeniden yazarak geri açarsınız',
      confirmLabel: 'Bağlantıyı kaldır',
      tone: 'danger',
    });
    if (ok) await send(Object.fromEntries(group.fields.map((f) => [f.key, null])), 'clear');
  };

  return (
    <Card
      title={group.title}
      subtitle={group.desc}
      actions={
        <Badge tone={allSet ? 'success' : anySet ? 'warning' : 'neutral'} dot>
          {allSet ? 'Tanımlı' : anySet ? 'Eksik' : 'Boş'}
        </Badge>
      }
      bodyClassName="space-y-4"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {group.fields.map((f) => {
          const st = fieldOf(f.key);
          const secret = f.kind === 'secret';
          return (
            <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key] ?? null}>
              <Input
                name={f.key}
                type={secret ? 'password' : f.kind === 'url' ? 'url' : 'text'}
                value={draft[f.key] ?? ''}
                onChange={(e) => {
                  setDraft({ ...draft, [f.key]: e.target.value });
                  if (errors[f.key]) setErrors({ ...errors, [f.key]: '' });
                }}
                disabled={!editable || !!busy}
                placeholder={secret ? (st?.set ? 'Tanımlı · değiştirmek için yazın' : 'Tanımlı değil') : (f.placeholder ?? '')}
                autoComplete={secret ? 'new-password' : 'off'}
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-[13px]"
              />
            </Field>
          );
        })}
        {editable && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:grow">
            <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={busy === 'save'} disabled={!dirty.length || (!!busy && busy !== 'save')}>
              Kaydet
            </Button>
            {anySet && (
              <Button variant="dangerGhost" icon={<Trash2 className="size-4" />} loading={busy === 'clear'} disabled={!!busy && busy !== 'clear'} onClick={() => void clear()}>
                Bağlantıyı kaldır
              </Button>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

/**
 * Hazır satırlar: kurulumda sahibe verilen ayar satırları (ANAHTAR=değer) olduğu gibi yapıştırılır. Bilinen anahtarlar
 * ayarlar dosyasına, Pavo'nun adresi ve seri no'su yazarkasa ayarına gider; bilinmeyenler söylenir, yazılmaz
 */
function PasteCard({ onSaved }: { onSaved: (v: ConnView) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  const apply = async () => {
    if (busy) return;
    const { values, unknown, later } = parseEnvLines(text);
    const { PAVO_URL, PAVO_SERIAL, ...rest } = values;
    const conn: Record<string, string | null> = {};
    const bad: string[] = [];
    for (const [key, raw] of Object.entries(rest)) {
      if (key.startsWith('PAVO_')) continue;
      const r = checkConnValue(connField(key)!, raw);
      if ('error' in r) bad.push(r.error);
      else if (r.value != null) conn[key] = r.value;
    }
    if (bad.length) return setNote({ tone: 'danger', text: bad.join(' · ') });
    const pavo = PAVO_URL && PAVO_SERIAL;
    if (!Object.keys(conn).length && !pavo)
      return setNote({ tone: later.length ? 'info' : 'danger', text: later.length ? `Yalnız deneme bittikten sonra girilecek satırlar var (${later.join(', ')}); şimdi yazılmadı` : 'Tanınan bir satır yok; satırlar ANAHTAR=değer biçiminde olmalı' });
    setBusy(true);
    setNote(null);
    try {
      const done: string[] = [];
      if (pavo) {
        await put('/okc/pavo', { address: PAVO_URL, serial: PAVO_SERIAL });
        void qc.invalidateQueries({ queryKey: ['okc'] });
        done.push('Pavo cihazı');
      }
      if (Object.keys(conn).length) {
        const v = await put<ConnView & { changed: string[] }>('/admin/baglanti', { values: conn });
        onSaved(v);
        done.push(`${v.changed.length} bilgi`);
      }
      setText('');
      toast.ok(`${done.join(' ve ')} kaydedildi`);
      const skipped = [
        later.length ? `Deneme bittikten sonra girilecekler şimdi yazılmadı: ${later.join(', ')}` : '',
        unknown.length ? `Tanınmayan satırlar yazılmadı: ${unknown.join(', ')}` : '',
      ].filter(Boolean);
      if (skipped.length) setNote({ tone: 'info', text: skipped.join(' · ') });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Hazır satırları yapıştır" subtitle="Size verilen ayar satırlarını (LAFMALIYET_URL=… gibi) olduğu gibi yapıştırın; hepsi tek seferde kaydedilir" bodyClassName="space-y-3">
      <Field label="Ayar satırları">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} autoCapitalize="none" placeholder={'LAFMALIYET_URL=https://…\nLAFMALIYET_SYNC_SECRET=…'} className="font-mono text-[13px]" />
      </Field>
      {note && (
        <Notice tone={note.tone} className="text-[13px] [overflow-wrap:anywhere]">
          {note.text}
        </Notice>
      )}
      <div className="flex max-sm:[&>*]:grow">
        <Button icon={<ClipboardPaste className="size-4" />} loading={busy} disabled={!text.trim()} onClick={() => void apply()}>
          Satırları kaydet
        </Button>
      </div>
    </Card>
  );
}

/**
 * Yönetim › Bağlantı bilgileri: lafmaliyet, LafPOS Uzaktan, site, Token ve paket platformlarının adresleri ve anahtarları.
 * Ayarlar dosyasına yazılır (server/lib/ayar-dosyasi.ts); Windows kurulumunda bekçi LafPOS'u birkaç saniyede yeni
 * bilgilerle açar, ekran o sırada durumu yoklar. Görme ayar yetkisiyle, yazma yalnız patron
 */
export default function ConnectionsAdmin() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const q = useQuery({
    queryKey: QUERY,
    queryFn: () => get<ConnView>('/admin/baglanti'),
    // Yeniden başlama beklenirken sık bakılır: sunucu yeni bilgilerle açılınca "bekliyor" kalkar
    refetchInterval: (query) => (query.state.data?.pending && query.state.data.restart === 'otomatik' ? 2500 : false),
    retry: 6,
  });
  const [waiting, setWaiting] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (waiting && d && !d.pending) {
      setWaiting(false);
      toast.ok('LafPOS yeni bilgilerle açıldı');
    }
  }, [waiting, d]);

  const onSaved = (v: ConnView) => {
    qc.setQueryData(QUERY, v);
    if (v.pending && v.restart === 'otomatik') setWaiting(true);
  };
  const patron = me?.role === 'patron';
  const header = <PageHeader title="Bağlantı bilgileri" description="lafmaliyet, LafPOS Uzaktan, site, Token ve paket platformlarının adresleri ve anahtarları" />;

  if (!d)
    return (
      <div className="space-y-4">
        {header}
        {q.isError ? (
          <ErrorState className={CARD} title="Bağlantı bilgileri alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="grid items-start gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-56 rounded-[var(--r-card)]" />
            ))}
          </div>
        )}
      </div>
    );

  const editable = d.available && patron;
  return (
    <div className="space-y-4">
      {header}
      {!d.available && (
        <Notice tone="info" title="Bu kurulumda bilgiler ayarlar dosyasından girilir">
          Panelden yazma Windows kurulumunda açıktır. Bu sunucuda bilgiler <code className={CODE}>.env</code> dosyasına yazılır, sunucu yeniden başlatılır
        </Notice>
      )}
      {d.available && d.pending && (
        <Notice tone={d.restart === 'otomatik' ? 'info' : 'warn'} role="status" title={d.restart === 'otomatik' ? 'LafPOS yeni bilgilerle yeniden başlıyor' : 'Yeni bilgiler henüz geçerli değil'}>
          {d.restart === 'otomatik' ? 'Birkaç saniye sürer; tabletler bu sırada bekler, siparişler kaybolmaz' : 'Sunucu yeniden başlatılınca geçerli olur'}
        </Notice>
      )}
      {d.available && !patron && <Notice tone="info">Bilgileri yalnız patron değiştirir; burada tanımlı olup olmadıkları görünür</Notice>}
      <p className="text-sm text-muted">
        Pavo cihazının adresi ve seri numarası <Link to="/yonetim/yazarkasa" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">Yazarkasa POS</Link>’tan girilir. Gizli anahtarlar burada hiç gösterilmez; yalnız tanımlı olup olmadıkları
      </p>
      {editable && <PasteCard onSaved={onSaved} />}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {CONN_GROUPS.map((g) => (
          <GroupCard key={g.id} group={g} state={d.groups.find((x) => x.id === g.id)?.fields ?? []} editable={editable} onSaved={onSaved} />
        ))}
      </div>
    </div>
  );
}
