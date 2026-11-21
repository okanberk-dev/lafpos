import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, KeyRound, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DenemeStatusDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { toast } from '@/lib/toast';
import { Badge, Card } from './ui';

const n = (v: number) => v.toLocaleString('tr-TR');
const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

/**
 * Yönetim › Ayarlar ve yedek › Deneme modu (yalnız patron). Yeni kurulum deneme modunda açılır: satışlar eğitimdir.
 * "Denemeyi bitir, gerçek kullanıma başla" önce yedek alır, deneme hareketlerini siler, kurulumu bırakır, örnek
 * PIN'leri kapatır (server/services/deneme.ts). Gerçek kullanım başladıysa ya da deneme modu kapalıysa kart çizilmez.
 */
export function DenemeCard() {
  const status = useQuery({ queryKey: ['admin', 'deneme'], queryFn: () => get<DenemeStatusDTO>('/admin/deneme') });
  const [open, setOpen] = useState(false);
  const d = status.data;
  if (!d || d.liveSince != null || !d.deneme) return null;
  const c = d.counts;
  const blocked = d.dayOpen || d.realDays > 0;
  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Deneme modu <Badge tone="info">Açık</Badge>
        </span>
      }
      subtitle="Kafede her şeyi gönül rahatlığıyla deneyin: satışlar gerçek sayılmaz"
    >
      <div className="grid gap-3 text-sm">
        <p className="text-ink-2">
          Deneme sırasında açılan adisyonlar, ödemeler ve gün sonları eğitimdir: lafmaliyet’e gitmez, yazarkasa eğitim simülatöründedir, giriş ekranında örnek PIN’ler durur. Denemeniz bitince
          aşağıdaki düğmeyle gerçek kullanıma geçin; deneme kayıtları silinir, kurulumunuz (menü, personel, masalar, ayarlar) kalır.
        </p>
        <p className="tabular text-[13px] text-muted">
          Şu ana kadar: {n(c.orders)} adisyon, {n(c.payments)} ödeme, {n(c.days)} gün
        </p>
        {d.dayOpen && (
          <Notice tone="warn" title="Açık bir gün var">
            Önce Kasa’dan gün sonunu alın, sonra denemeyi bitirin
          </Notice>
        )}
        {d.realDays > 0 && (
          <Notice tone="warn" title="Gerçek gün var">
            Deneme modu dışında kapanmış {n(d.realDays)} gün var; bu kayıtlar silinmez. Yardım için kurulumu yapan kişiye haber verin
          </Notice>
        )}
        <div>
          <Button variant="primary" icon={<Rocket className="size-4" />} disabled={blocked} onClick={() => setOpen(true)}>
            Denemeyi bitir, gerçek kullanıma başla
          </Button>
        </div>
      </div>
      {open && <FinishDialog status={d} onClose={() => setOpen(false)} />}
    </Card>
  );
}

/**
 * Üstteki "Deneme modu" şeridinin "Denemeyi bitir" düğmesi (yalnız patron; AppShell tembel yükler): durumu sorar,
 * bitirilebiliyorsa kartla aynı pencereyi açar. Açık gün ya da deneme dışı kapanmış gün varsa ne yapılacağını söyler
 */
export function DenemeFinishLauncher({ onClose }: { onClose: () => void }) {
  const status = useQuery({ queryKey: ['admin', 'deneme'], queryFn: () => get<DenemeStatusDTO>('/admin/deneme') });
  const d = status.data;
  const blocked = !d ? null : d.liveSince != null || !d.deneme ? 'Gerçek kullanım zaten başlamış' : d.dayOpen ? 'Önce Kasa’dan gün sonunu alın, sonra denemeyi bitirin' : d.realDays > 0 ? 'Deneme dışında kapanmış gün var; Yönetim › Ayarlar ve yedek › Deneme modu’na bakın' : null;
  useEffect(() => {
    if (status.isError) {
      toast.err(errorMessage(status.error));
      onClose();
    } else if (blocked) {
      toast.warn(blocked);
      onClose();
    }
  }, [status.isError, status.error, blocked, onClose]);
  return d && !blocked ? <FinishDialog status={d} onClose={onClose} /> : null;
}

function FinishDialog({ status, onClose }: { status: DenemeStatusDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const c = status.counts;
  const needNew = status.mustChangeOwnPin;
  const newError = !needNew && !newPin ? null : !/^\d{4,6}$/.test(newPin) ? 'Yeni PIN 4–6 hane rakam' : newPin === pin ? 'Yeni PIN eskisinden farklı olmalı' : null;
  const repeatError = newPin && newPin2 !== newPin ? 'İki PIN aynı değil' : null;
  const pinError = /^\d{4,6}$/.test(pin) ? null : 'Şu anki PIN’inizi yazın';

  const submit = async () => {
    setTried(true);
    if (pinError || newError || repeatError) return;
    setBusy(true);
    try {
      const r = await post<{ already: boolean; backup: string | null; closedUsers: string[] }>('/admin/deneme/bitir', { pin, ...(newPin ? { newPin } : {}) });
      if (r.already) toast.info('Gerçek kullanım zaten başlamış; hiçbir şey silinmedi');
      else toast.ok(r.closedUsers.length ? `Gerçek kullanım başladı. Örnek PIN’li hesaplar kapatıldı: ${r.closedUsers.join(', ')}` : 'Gerçek kullanım başladı');
      onClose();
      void qc.invalidateQueries();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      persistent
      onClose={() => !busy && onClose()}
      title="Gerçek kullanıma başla"
      subtitle="Bu işlem geri alınmaz; öncesinde yedek alınır"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="danger" loading={busy} icon={<Rocket className="size-4" />} onClick={() => void submit()}>
            Denemeyi bitir
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-sm">
        <section>
          <h3 className="font-semibold">Silinecek deneme kayıtları</h3>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-2">
            <li>
              Adisyonlar ve satırları ({n(c.orders)}), ödemeler ({n(c.payments)}), yazarkasa fişleri ({n(c.fiscalReceipts)})
            </li>
            <li>
              İş günleri ve Z raporları ({n(c.days)}), kasa hareketleri ({n(c.cashMovements)}) ve vardiya sayımları
            </li>
            <li>
              Rezervasyonlar ({n(c.reservations)}), paket platformu siparişleri ({n(c.platformOrders)})
            </li>
            <li>Müşteriler ve açık hesapları ({n(c.customers)})</li>
            <li>Denetim kaydı ({n(c.audit)}); yerine bu işlemin kaydı yazılır</li>
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Kalacaklar</h3>
          <p className="mt-1.5 text-ink-2">Menü ve fiyatlar, personel ve roller, masa planı ve QR kodları, ödeme türleri, istasyonlar, yazıcılar ve bütün ayarlar.</p>
        </section>
        <section>
          <h3 className="font-semibold">Ayrıca</h3>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-2">
            <li>Önce veritabanının yedeği alınır (Yedek listesinde “deneme-oncesi” adıyla durur, silinmez)</li>
            {status.okcProvider === 'simulator' && <li>Yazarkasa eğitim simülatöründen “Kapalı”ya geçer; Pavo’yu Yönetim › Yazarkasa POS’tan seçin</li>}
            <li>Satışlar bundan sonra gerçektir ve gün sonları lafmaliyet’e gider; Z numarası baştan (ya da İlk Z numarasından) başlar</li>
            {status.samplePinUsers.length > 0 && (
              <li>
                Örnek PIN’iyle duran hesaplar kapatılır: <b className="font-semibold text-ink">{status.samplePinUsers.map((u) => u.name).join(', ')}</b>. Personel’den yeni PIN verip açabilirsiniz
              </li>
            )}
          </ul>
        </section>
        {needNew && (
          <Notice tone="warn" icon={<KeyRound />} title="PIN’iniz hâlâ örnek PIN">
            Herkesin bildiği PIN gerçek kullanımda kalamaz: yeni PIN’inizi seçin
          </Notice>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {needNew && (
            <>
              <Field label="Yeni PIN’iniz" hint="4–6 hane" error={(tried || newPin.length >= 4) && newError ? newError : null}>
                <Input value={newPin} onChange={(e) => setNewPin(digits(e.target.value))} inputMode="numeric" type="password" autoComplete="new-password" className="tracking-[0.3em]" />
              </Field>
              <Field label="Yeni PIN (tekrar)" error={tried && repeatError ? (newPin2 ? repeatError : 'Yeni PIN’i tekrar yazın') : null}>
                <Input value={newPin2} onChange={(e) => setNewPin2(digits(e.target.value))} inputMode="numeric" type="password" autoComplete="new-password" className="tracking-[0.3em]" />
              </Field>
            </>
          )}
          <Field label="Onay için şu anki PIN’iniz" error={tried && pinError ? pinError : null}>
            <Input value={pin} onChange={(e) => setPin(digits(e.target.value))} inputMode="numeric" type="password" autoComplete="off" className="tracking-[0.3em]" />
          </Field>
        </div>
        <p className="flex items-start gap-2 text-[13px] text-muted">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Deneme kayıtları yalnız yedekte kalır; gerekirse yedekten geri dönülebilir.
        </p>
      </div>
    </Modal>
  );
}
