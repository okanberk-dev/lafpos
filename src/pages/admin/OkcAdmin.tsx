import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Landmark, Link2, Pencil, PlugZap, Printer, Radar, Save, ShieldCheck, Webhook, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { tl } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { confirmDialog, type ConfirmOptions } from '@/components/ui/Confirm';
import { Field, Input, Label, Toggle } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { UpdateCard } from '@/components/admin/UpdateCard';
import { Badge, Card, CARD, CODE, DefRow, PageHeader, Segmented, SetupNotes, TONE_SOFT } from '@/components/admin/ui';
import { printBankEodSlip } from '@/lib/after-payment';
import { errorMessage, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { BankEodSlip } from '@/lib/print';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { REMOTE } from '@/lib/remote';
import { toast } from '@/lib/toast';

interface PavoExchange {
  at: number;
  path: string;
  ok: boolean;
  errorCode: string | null;
  message: string | null;
  dataKeys: string[];
}
/** Cihazın son banka gün sonu (sunucu `PavoEodRecord`); kör kasada tutarlar null */
interface PavoEod {
  at: number;
  trigger: 'otomatik' | 'elle';
  status: 'ok' | 'failed' | 'unknown' | 'running' | 'skipped';
  batchNo: string | null;
  deviceDateTime: string | null;
  grandTotalKurus: number | null;
  dayCardKurus: number | null;
  /** Kıyas önceki gün sonundan sonraki kart ödemeleriyleyse o gün sonunun batch no'su */
  dayCardSinceBatch?: string | null;
  /** Aynı günün önceki başarılı gün sonları (saklı kalır) */
  earlier: { batchNo: string | null; grandTotalKurus: number | null; at: number }[];
  acquirers: { name: string; count: number | null; totalKurus: number | null }[];
  errorCode: string | null;
  message: string | null;
  verifiedAt?: number | null;
  amountsHidden: boolean;
}
interface OkcStatus {
  provider: 'kapali' | 'tokenx' | 'pavo' | 'simulator';
  mode: 'anlik' | 'liste';
  sectionMap: Record<string, number>;
  operatorMethods: Record<string, string>;
  pavoAutoEod: boolean;
  /** Pavo: ödeme türü cihazda önceden seçili (yoksa eski sunucu: açık sayılır) */
  pavoOdemeSecili?: boolean;
  /** Pavo: banka gün sonu kâğıdı fiş yazıcısından da (yoksa eski sunucu); cihazın kendi slibi ayardan bağımsız */
  pavoEodFis?: boolean;
  /** Ödemeyi alınca cihaza gönder (kasada ödeme) */
  auto: boolean;
  active: { label: string; configured: boolean; capabilities: { instant: boolean; list: boolean; splitPayment: boolean; docKinds: string[] } } | null;
  tokenx: { configured: boolean; terminalId: string | null; branchId: string | null; webhookUrl: string | null; webhookSecret: boolean };
  pavo: {
    configured: boolean;
    /** Bilgiler nereden: yönetimden girilen (`panel`) ya da eski kurulumun ayarlar dosyası (`dosya`) */
    source: 'panel' | 'dosya' | null;
    url: string | null;
    serial: string | null;
    paired: boolean;
    /** Kurulumun Pavo kimliği (salt okunur): `kurulum` ilk eşleştirmede üretildi, `eski` önceki kurulum, `dosya` ayarlar dosyası */
    fingerprint: string;
    fingerprintSource: 'dosya' | 'kurulum' | 'eski' | 'yok';
    certificate: string | null;
    busy: string | null;
    exchanges: PavoExchange[];
    eod: PavoEod | null;
  };
  lastError: { message: string; at: number } | null;
  /** Son hata: cihaz başka programla eşleşmiş (73/74); ekranda doğrudan "Yeniden eşleştir" */
  pairingLost: boolean;
}
interface TestResult {
  terminal: { terminalId?: string; branchId?: string; merchantId?: string; error?: string };
  sections: { sectionNo: number; name: string; taxPercent: number }[];
  suggestedSectionMap: Record<string, number>;
  terminals: { id: string; mode: number }[] | null;
}
interface PavoTest {
  ping: { ok: boolean; message: string | null };
  paired: boolean;
  pairingHint: string | null;
  mediators: { id: number | null; name: string | null }[];
  /** Cihaz yanıt verdi ama ödeme araçları tanınan biçimde gelmedi (alan adlarıyla) */
  mediatorsNote?: string | null;
}
/** Ağda arama: yanıt veren Pavo adresleri */
interface PavoFind {
  subnets: string[];
  scanned: number;
  candidates: { url: string; ok: boolean; message: string | null; unrecognized?: boolean }[];
  ms: number;
}
type Provider = OkcStatus['provider'];
type Mode = OkcStatus['mode'];

/** Cihazda her zaman eşlenebilen oranlar; menüde başka bir oran varsa o da listelenir */
const RATES = ['1', '10', '20'];

const PROVIDER_LABEL: Record<Provider, string> = { kapali: 'Kapalı', simulator: 'Eğitim cihazı', tokenx: 'Token · Beko', pavo: 'Pavo' };
const MODE_LABEL: Record<Mode, string> = { anlik: 'Kasada ödeme', liste: 'Masada ödeme' };
/** Ödeme yerinin anlamı; Token cihazında aynı mod ayrıca seçilir */
const MODE_HINT: Record<Mode, { what: string; token: string }> = {
  anlik: { what: 'Sepet hemen cihaza düşer, ödeme kasada alınır', token: 'Token cihazında “Sepet ödemesini hemen al” seçili olmalı' },
  liste: { what: 'Cihaz açık hesapları listeler, ödeme masada alınır', token: 'Token cihazında “Birden fazla sepeti listele” seçili olmalı' },
};
const DOC_LABEL: Record<string, string> = { okc_fis: 'Mali fiş', bilgi_fisi: 'Bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

/**
 * Bağlantı değişince sorulur: mali fiş buna bağlı. Kapatmak yıkıcı (kırmızı): adisyon cihaza gitmez, fişi kasiyer
 * yazarkasada elle keser; öteki seçimler bundan sonraki hesapların nereye gideceğini söyler
 */
const PROVIDER_CONFIRM: Record<Provider, ConfirmOptions> = {
  kapali: { title: 'Yazarkasa bağlantısı kapatılsın mı', body: 'Adisyonlar cihaza gitmez; mali fişi kasiyer yazarkasada elle keser', confirmLabel: 'Bağlantıyı kapat', tone: 'danger' },
  simulator: { title: 'Eğitim cihazına geçilsin mi', body: 'Hesaplar eğitim cihazı ekranına gider, mali fiş kesilmez; gerçek cihaz bağlanana kadar deneme ve eğitim için', confirmLabel: 'Eğitim cihazına geç', tone: 'primary' },
  tokenx: { title: 'Token cihazına geçilsin mi', body: 'Bundan sonraki hesaplar Token cihazına sepet olarak gider; ödeme ve mali fiş cihazda alınır', confirmLabel: 'Token’a geç', tone: 'primary' },
  pavo: {
    title: 'Pavo cihazına geçilsin mi',
    body: 'Bundan sonraki hesaplar kafenin ağındaki Pavo cihazına gider; ödeme cihazda alınır, e-Arşiv belgesi cihazdan çıkar. Önce cihazı eşleştirin ve küçük bir satışla deneyin',
    confirmLabel: 'Pavo’ya geç',
    tone: 'primary',
  },
};

/** Bağlantısı henüz olmayan markalar: neden ve üreticiden ne istenecek (docs/04-OKC.md'de ayrıntı) */
const OTHER_VENDORS: { name: string; channel: string; state: string }[] = [
  { name: 'Hugin', channel: 'Cloud Link (TSM)', state: 'Açık belge eksik: satış sonucunun ödeme, Z ve fiş alanları istenecek' },
  { name: 'Ingenico', channel: 'GMP-3 DLL (Windows)', state: 'Geliştirici programı ve sürüm başına kayıt gerekir' },
  { name: 'Verifone, Inpos, Profilo, PayGo, Vera', channel: 'TSM ya da kablolu', state: 'Açık belge yok; üreticiden istenecek' },
];

/** Hesabın cihaza gidişi, sırasıyla ("Nasıl çalışır" kartı) */
const STEPS = [
  'Ödeme penceresinde “Hesabı yazarkasaya gönder”e basılır (kalem seçerek bölünmüş hesap da gönderilebilir)',
  'Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar',
  'Sonuç LafPOS’a gelir, ödemeler adisyona işlenir, adisyon kapanır; Z no ve fiş no adisyonda kalır',
  'Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır, adisyon yeniden açılır ve patron paneline alarm düşer',
];

/** Yazılan adresin kısa hâli: varsayılan şema ve port gösterilmez (192.168.1.50) */
const shortAddress = (url: string | null) => (url ?? '').replace(/^https:\/\//, '').replace(/:4567$/, '');

/**
 * Pavo cihazının adresi ve seri numarası (yönetimden; ayarlar dosyasına gerek yok). "Cihazı ağda ara" kasanın ağında
 * Pavo'nun REST portunu açık tutan ve yanıt veren cihazları listeler, dokununca adres alana yazılır. Kaydedince adres ya
 * da seri no değiştiyse eşleştirme sıfırlanır (sunucu); sıradaki adım "Eşleştir"
 */
function PavoDeviceForm({ s, onCancel }: { s: OkcStatus; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState(() => shortAddress(s.pavo.url));
  const [serial, setSerial] = useState(s.pavo.serial ?? '');
  const [doing, setDoing] = useState<'save' | 'find' | null>(null);
  const [found, setFound] = useState<(PavoFind & { serial: boolean }) | null>(null);
  const [error, setError] = useState<{ field: 'address' | 'serial' | null; message: string } | null>(null);

  const save = async () => {
    if (doing) return;
    if (!address.trim()) return setError({ field: 'address', message: 'Cihazın IP adresini yazın' });
    if (!serial.trim()) return setError({ field: 'serial', message: 'Seri numarasını yazın' });
    setDoing('save');
    setError(null);
    try {
      const next = await put<OkcStatus>('/okc/pavo', { address, serial });
      qc.setQueryData(['okc', 'status'], next);
      toast.ok(next.pavo.paired ? 'Pavo cihazının bilgileri kaydedildi' : 'Pavo cihazı kaydedildi; şimdi Eşleştir’e basın');
      onCancel?.();
    } catch (e) {
      const code = (e as { code?: string | null }).code;
      setError({ field: code === 'pavo_address' ? 'address' : code === 'pavo_serial' ? 'serial' : null, message: errorMessage(e) });
    } finally {
      setDoing(null);
      void qc.invalidateQueries({ queryKey: ['okc', 'status'] });
    }
  };
  const find = async () => {
    if (doing) return;
    setDoing('find');
    setFound(null);
    try {
      // Seri no yazıldıysa cihaz onu denetler: hangi cihazın bu olduğu listede görünür
      const r = await post<PavoFind>('/okc/pavo/find', { serial: serial.trim() || null });
      setFound({ ...r, serial: !!serial.trim() });
      // Tek cihaz bulunduysa adresi kendiliğinden yazar; birden çoksa kasiyer seçer
      const match = r.candidates.filter((c) => c.ok);
      const pick = r.candidates.length === 1 ? r.candidates[0] : match.length === 1 ? match[0] : null;
      if (pick) setAddress(shortAddress(pick.url));
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setDoing(null);
    }
  };

  return (
    <form
      className="max-w-2xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cihazın IP adresi" hint="Port yazılmazsa 4567" error={error?.field === 'address' ? error.message : null}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.50" inputMode="url" autoCapitalize="none" spellCheck={false} className="tabular" />
        </Field>
        <Field label="Seri numarası" hint="Cihazda Terminal Ayarları › Seri Numarası (PAV ile başlar; Terminal ID değil)" error={error?.field === 'serial' ? error.message : null}>
          <Input value={serial} onChange={(e) => setSerial(e.target.value.toUpperCase())} placeholder="PAV860…" autoCapitalize="characters" spellCheck={false} className="tabular" />
        </Field>
      </div>
      {error && !error.field && (
        <Notice tone="danger" className="text-[13px] [overflow-wrap:anywhere]">
          {error.message}
        </Notice>
      )}
      {found && (
        <div className="space-y-2 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-4 ring-1 ring-inset ring-[var(--admin-border)]">
          {found.candidates.length ? (
            <>
              <p className="text-xs font-medium text-[var(--admin-text-mute)]">Ağda bulunan Pavo cihazları</p>
              <ul className="divide-y divide-[var(--admin-divider)]">
                {found.candidates.map((c) => (
                  <li key={c.url} className="flex flex-wrap items-center gap-2.5 py-1.5">
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="tabular block font-medium text-[var(--admin-text)] [overflow-wrap:anywhere]">{shortAddress(c.url)}</span>
                      {/* Seri no yazılıysa cihaz onu denetledi: tutuyorsa onay, tutmuyorsa cihazın sözü */}
                      {c.unrecognized ? (
                        <span className="block text-xs text-[var(--admin-text-mute)]">{c.message}; seçip “Bağlantıyı dene” ile doğrulayın</span>
                      ) : found.serial && (
                        <span className={cn('block text-xs', c.ok ? 'text-[var(--admin-success)]' : 'text-[var(--admin-text-mute)]')}>
                          {c.ok ? 'Seri no tutuyor' : `Cihaz: ${c.message ?? 'seri no tutmuyor'}`}
                        </span>
                      )}
                    </span>
                    <Button size="sm" variant="soft" onClick={() => setAddress(shortAddress(c.url))} disabled={shortAddress(c.url) === address.trim()}>
                      {shortAddress(c.url) === address.trim() ? 'Seçildi' : 'Bunu kullan'}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-[var(--admin-text-soft)]">
              {found.scanned
                ? `Ağda Pavo bulunamadı (${found.subnets.join(', ')} tarandı). Cihaz açık ve kasayla aynı ağda mı, cihazda REST açık mı bakın; adresi cihazın Network Ayarları’ndan da okuyabilirsiniz`
                : 'Bu bilgisayarın yerel ağ adresi bulunamadı; cihazın adresini Network Ayarları’ndan okuyup yazın'}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 max-sm:[&>*]:grow">
        <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={doing === 'save'} disabled={!!doing && doing !== 'save'}>
          Kaydet
        </Button>
        <Button icon={<Radar className="size-4" />} loading={doing === 'find'} disabled={!!doing && doing !== 'find'} onClick={() => void find()}>
          Cihazı ağda ara
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={!!doing} onClick={onCancel}>
            Vazgeç
          </Button>
        )}
      </div>
      {doing === 'find' && <p className="text-xs text-muted">Ağ taranıyor; 15-20 saniye sürebilir</p>}
    </form>
  );
}

/** Pavo kurulumu: cihazın kendi ayarları (Pavo seçiliyse kartının altında; bilgiler eksikse açık) */
function PavoSetup({ open }: { open?: boolean }) {
  return (
    <SetupNotes open={open}>
      <p>
        Cihaz ve kasa bilgisayarı aynı ağda olmalı (Wi-Fi ya da kablo). Cihazda Ayarlar › Çevresel Donanımlar › Network Ayarları’nda REST açık olmalı ve REST ağı Wi-Fi ya da
        Ethernet seçili olmalı (mobil veride çalışmaz). Cihazın IP adresini modemden sabitlerseniz adres değişmez.
      </p>
      <p>
        Adresi ve seri numarasını yukarıya yazın (ya da “Cihazı ağda ara”), “Eşleştir”e basıp cihazdaki onay ekranını onaylayın, “Bağlantıyı dene” ile doğrulayın. İlk satışı küçük
        bir tutarla deneyin: cihaz gerçek e-Arşiv belgesi keser. Pavo günde bir eşleştirmeyi önerir. Ayrıntı: <code className={CODE}>docs/04-YAZARKASA.md</code>
      </p>
    </SetupNotes>
  );
}

/** Token kurulumu: Token seçiliyse kartının hemen altında (eksikse açık), değilse sayfa sonunda kapalı */
function TokenSetup({ open }: { open?: boolean }) {
  return (
    <SetupNotes open={open}>
      <p>
        TokenX Connect bilgileri (kimlik ve sepet adresi, uygulama kimliği ve anahtarı, terminal, masada ödeme için şube, webhook anahtarı) Token’dan alınır ve{' '}
        <Link to="/yonetim/baglanti-bilgileri" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">
          Yönetim › Bağlantı bilgileri
        </Link>
        ’ne yazılır; LafPOS birkaç saniyede yeni bilgilerle açılır, sonra “Bağlantıyı dene”.
      </p>
      <p>
        Ayrıntı ve diğer markalar için üreticiden istenecekler: <code className={CODE}>docs/04-YAZARKASA.md</code>
      </p>
    </SetupNotes>
  );
}

const EOD_BADGE: Record<PavoEod['status'], { tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Alındı' },
  failed: { tone: 'danger', label: 'Alınamadı' },
  unknown: { tone: 'warning', label: 'Sonuç belirsiz' },
  running: { tone: 'info', label: 'Sürüyor' },
  skipped: { tone: 'neutral', label: 'Atlandı' },
};

/**
 * Pavo banka gün sonu: cihaz bankalardaki kart işlemlerini kapatır (batch). Son sonuç (durum, batch, cihaz saati,
 * toplam ve banka satırları), gün kapanınca otomatik alma anahtarı, elle alma ve doğrulama. Tutarlar kör kasada gelmez
 */
function PavoEodCard({ s, onAuto, savingAuto, onFis, savingFis }: { s: OkcStatus; onAuto: (v: boolean) => void; savingAuto: boolean; onFis: (v: boolean) => void; savingFis: boolean }) {
  const qc = useQueryClient();
  const [running, setRunning] = useState<'eod' | 'verify' | 'reprint' | null>(null);
  const boot = useBoot();
  const canReprint = useAuth((a) => !!a.me?.permissions.includes('kasa.gun'));
  const eod = s.pavo.eod;
  const ready = s.pavo.configured && s.pavo.paired;

  // Kayıt kâğıdı ilk soran ekrana verildiği anda "basıldı" sayılır: yazıcı kapalıysa ya da kâğıt bittiyse buradan
  const reprint = async () => {
    if (running) return;
    setRunning('reprint');
    try {
      const { slip } = await post<{ slip: BankEodSlip }>('/okc/eod/slip', { again: true });
      await printBankEodSlip(boot, slip);
      toast.ok('Gün sonu kâğıdı yazıcıya gönderildi');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setRunning(null);
    }
  };

  const run = async (what: 'eod' | 'verify') => {
    if (running) return;
    if (
      what === 'eod' &&
      !(await confirmDialog({
        title: 'Cihazda gün sonu alınsın mı',
        body: 'Cihaz bankalardaki kart işlemlerini kapatır (batch). Bundan sonra bu işlemler iptal edilemez, yalnız iade edilebilir',
        confirmLabel: 'Gün sonu al',
        tone: 'primary',
      }))
    )
      return;
    setRunning(what);
    try {
      if (what === 'eod') {
        await post('/okc/eod', {});
        toast.ok('Cihazda gün sonu alındı');
      } else {
        // Değişen sonuç ya "alındı" (cihazda bulundu) ya da "alınmamış" (yeniden denenmeli)
        const r = await post<{ changed: boolean; message: string; record: Pick<PavoEod, 'status'> | null }>('/okc/eod/verify', {});
        if (!r.changed) toast.info(r.message);
        else if (r.record?.status === 'ok') toast.ok(r.message);
        else toast.warn(r.message);
      }
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setRunning(null);
      void qc.invalidateQueries({ queryKey: ['okc', 'status'] });
    }
  };

  const badge = eod ? EOD_BADGE[eod.status] : null;
  const diff = eod && eod.status === 'ok' && eod.grandTotalKurus != null && eod.dayCardKurus != null ? eod.grandTotalKurus - eod.dayCardKurus : 0;
  return (
    <Card
      title="Gün sonu (banka)"
      actions={
        badge ? (
          <Badge tone={badge.tone} dot>
            {badge.label}
          </Badge>
        ) : undefined
      }
      bodyClassName="space-y-4 text-sm"
    >
      <p className="text-muted">Cihaz bankalardaki kart işlemlerini kapatır. LafPOS gün sonu bunu beklemez: cihaz yanıt vermese de gün kapanır, sonuç burada görünür</p>
      {eod ? (
        <div className="max-w-2xl">
          <DefRow label="Son deneme">
            {fmtDateTime(eod.at)} · {eod.trigger === 'elle' ? 'elle' : 'gün kapanınca'}
          </DefRow>
          {eod.batchNo && (
            <DefRow label="Batch no">
              <span className="tabular">{eod.batchNo}</span>
            </DefRow>
          )}
          {eod.deviceDateTime && (
            <DefRow label="Cihaz saati">
              <span className="tabular">{eod.deviceDateTime}</span>
            </DefRow>
          )}
          {eod.status === 'ok' && (eod.grandTotalKurus != null || eod.amountsHidden) && (
            <DefRow label="Genel toplam">{eod.amountsHidden ? <span className="font-normal text-[var(--admin-text-mute)]">Gizli</span> : <span className="tabular">{tl(eod.grandTotalKurus!)}</span>}</DefRow>
          )}
          {diff !== 0 && (
            <DefRow label={eod.dayCardSinceBatch ? `LafPOS kartı (batch ${eod.dayCardSinceBatch} sonrası)` : 'LafPOS kart toplamı'}>
              <span className="tabular">{tl(eod.dayCardKurus!)}</span>
            </DefRow>
          )}
          {eod.earlier.length > 0 && (
            <DefRow label="Aynı günün önceki gün sonları">
              <span className="tabular">{eod.earlier.map((b) => b.batchNo ?? 'batch no yok').join(', ')}</span>
            </DefRow>
          )}
        </div>
      ) : (
        <p className="text-muted">Bu cihazda LafPOS’tan henüz gün sonu alınmadı</p>
      )}
      {eod && eod.status === 'ok' && eod.acquirers.length > 0 && (
        <div>
          <p className="text-xs font-medium text-[var(--admin-text-mute)]">Bankalar</p>
          <ul className="mt-1 max-w-md divide-y divide-[var(--admin-divider)]">
            {eod.acquirers.map((a, i) => (
              <li key={`${a.name}-${i}`} className="flex items-center gap-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[var(--admin-text)]">{a.name}</span>
                {a.count != null && <span className="shrink-0 text-xs tabular-nums text-[var(--admin-text-mute)]">{a.count} işlem</span>}
                {a.totalKurus != null && <span className="shrink-0 tabular-nums font-medium text-[var(--admin-text)]">{tl(a.totalKurus)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff !== 0 && (
        <Notice tone="warn" title="Cihazın toplamı LafPOS’un kart toplamından farklı" className="text-[13px]">
          Cihazda LafPOS dışı ya da başka güne ait kart işlemi, başka cihazda alınan kart ödemesi olabilir; denetim kaydında ayrıntı var
        </Notice>
      )}
      {eod && eod.status !== 'ok' && eod.message && (
        <Notice tone={eod.status === 'failed' ? 'danger' : eod.status === 'unknown' ? 'warn' : 'info'} title={eod.status === 'unknown' ? 'Önce doğrulayın' : undefined} className="text-[13px] [overflow-wrap:anywhere]">
          {eod.message}
        </Notice>
      )}
      <div className="max-w-2xl border-t border-[var(--admin-divider)] pt-4">
        <Toggle
          block
          checked={s.pavoAutoEod}
          disabled={savingAuto}
          onChange={onAuto}
          label="Gün kapanınca cihazda gün sonu al"
          hint="LafPOS gün sonundan hemen sonra, gün başına bir kez; cihaz alamazsa ya da yanıt vermezse alarm düşer, yeniden deneme elle"
        />
        {s.pavoEodFis !== undefined && (
          <Toggle
            block
            className="mt-3"
            checked={s.pavoEodFis}
            disabled={savingFis}
            onChange={onFis}
            label="Gün sonu kâğıdı fiş yazıcısından da çıksın"
            hint="Cihaz kendi slibini her gün sonunda basar. Açıkken kasa ekranı fiş yazıcısından da LafPOS Z’sini ve bankalarla Pavo - LafPOS kıyasını basar (her gün sonunda bir kez; kör kasada Z basılmaz)"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:grow">
        <Button icon={<Landmark className="size-4" />} loading={running === 'eod'} disabled={!ready || !!running || !!s.pavo.busy} onClick={() => void run('eod')}>
          Cihazda gün sonu al
        </Button>
        <Button icon={<ShieldCheck className="size-4" />} loading={running === 'verify'} disabled={!ready || !!running || !!s.pavo.busy} onClick={() => void run('verify')}>
          Doğrula
        </Button>
        {canReprint && eod?.status === 'ok' && eod.batchNo && (
          <Button icon={<Printer className="size-4" />} loading={running === 'reprint'} disabled={!!running} onClick={() => void reprint()}>
            Kâğıdı yeniden bas
          </Button>
        )}
      </div>
      {running === 'eod' ? (
        <p className="text-xs text-muted">Cihaz bankalara bağlanıyor; birkaç dakika sürebilir</p>
      ) : (
        !ready && <p className="text-xs text-muted">Gün sonu için cihaz eşleştirilmiş olmalı</p>
      )}
    </Card>
  );
}

export default function OkcAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['okc', 'status'], queryFn: () => get<OkcStatus>('/okc/status') });
  const [map, setMap] = useState<Record<string, string>>({});
  // Elle değiştirilen eşleme sunucudan gelen yenilemeyle (bağlantı ya da ödeme yeri kaydı, canlı akış) ezilmez
  const [mapDirty, setMapDirty] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [pavoTest, setPavoTest] = useState<PavoTest | null>(null);
  // Ayar kaydı (bağlantı, ödeme yeri, eşleme) ile Token'a giden istek (deneme, webhook) ayrı izlenir: bulut yanıt
  // vermezse deneme 10–40 sn sürer, o arada bağlantıyı kapatmak ya da eşlemeyi kaydetmek beklemez, dokunuş yutulmaz
  const [saving, setSaving] = useState<'map' | 'provider' | 'mode' | 'eod' | 'auto' | 'secili' | 'fis' | null>(null);
  const [checking, setChecking] = useState<'test' | 'webhook' | 'pair' | null>(null);
  // Pavo'nun adresi ve seri no'su kayıtlıyken form kapalı durur; "Adresi değiştir" açar
  const [editDevice, setEditDevice] = useState(false);

  useEffect(() => {
    if (status.data && !mapDirty) setMap(Object.fromEntries(Object.entries(status.data.sectionMap).map(([k, v]) => [k, String(v)])));
  }, [status.data, mapDirty]);

  const editMap = (next: Record<string, string>) => {
    setMap(next);
    setMapDirty(true);
  };
  /** Ayar kaydı: sunucu güncel durumu döndürür, ekran onunla hemen güncellenir (seçim bir an eski değerde kalmaz) */
  const save = async (body: Record<string, unknown>, done = 'Yazarkasa ayarı kaydedildi') => {
    try {
      const next = await put<OkcStatus>('/okc/settings', body);
      qc.setQueryData(['okc', 'status'], next);
      toast.ok(done);
      void qc.invalidateQueries({ queryKey: ['okc'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      return true;
    } catch (e) {
      toast.err(errorMessage(e));
      return false;
    }
  };
  const saveMap = async () => {
    if (saving) return;
    setSaving('map');
    if (await save({ sectionMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])) }, 'Kısım eşlemesi kaydedildi')) setMapDirty(false);
    setSaving(null);
  };
  const registerWebhook = async () => {
    setChecking('webhook');
    try {
      const r = await post<{ url: string }>('/okc/webhook/register');
      toast.ok(`Webhook kaydedildi: ${r.url}`);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };
  const runTest = async () => {
    setChecking('test');
    try {
      const r = await post<TestResult>('/okc/test');
      setTest(r);
      toast.ok('Token bağlantısı çalışıyor');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };
  /** Pavo: deneme ve eşleştirme cihaza gider; bitince durum (son yanıtlar) yenilenir */
  const runPavo = async (what: 'test' | 'pair') => {
    if (checking) return;
    setChecking(what);
    try {
      if (what === 'pair') {
        await post('/okc/pair');
        toast.ok('Pavo cihazı eşleştirildi');
        setPavoTest(null);
      } else {
        const r = await post<PavoTest>('/okc/test');
        setPavoTest(r);
        if (r.paired) toast.ok('Pavo bağlantısı çalışıyor');
        else toast.warn('Cihaz yanıt veriyor ama eşleştirme gerekli');
      }
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setChecking(null);
      void qc.invalidateQueries({ queryKey: ['okc', 'status'] });
    }
  };

  const header = <PageHeader title="Yazarkasa POS" description="Bağlantı açıkken adisyon cihaza sepet olarak gider; ödeme ve mali fiş cihazda alınır" />;
  if (!status.data)
    return (
      <div className="space-y-4">
        {header}
        {status.isError ? (
          <ErrorState className={CARD} title="Yazarkasa durumu alınamadı" error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="space-y-4">
            <Skeleton className="h-40 rounded-[var(--r-card)]" />
            <Skeleton className="h-28 rounded-[var(--r-card)]" />
          </div>
        )}
      </div>
    );
  const s = status.data;

  // Bağlantı tek dokunuşla değişmez: sorulur, istek sürerken seçim kilitli (ikinci dokunuş ikinci istek göndermez).
  // Token denemesi ve webhook kaydı kilitlemez: bulut yanıt vermezken de bağlantı kapatılabilir
  const setProvider = async (v: Provider) => {
    if (v === s.provider || saving) return;
    if (!(await confirmDialog(PROVIDER_CONFIRM[v]))) return;
    setSaving('provider');
    await save({ provider: v }, v === 'kapali' ? 'Yazarkasa bağlantısı kapatıldı' : `Yazarkasa bağlantısı: ${PROVIDER_LABEL[v]}`);
    setSaving(null);
  };
  const setMode = async (v: Mode) => {
    if (v === s.mode || saving) return;
    setSaving('mode');
    await save({ mode: v }, `Ödeme yeri: ${MODE_LABEL[v]}`);
    setSaving(null);
  };
  const setAuto = async (v: boolean) => {
    if (v === s.auto || saving) return;
    setSaving('auto');
    await save({ auto: v }, v ? 'Ödeme alınınca hesap cihaza kendiliğinden gidecek' : 'Hesap cihaza “Yazarkasaya gönder” ile gidecek');
    setSaving(null);
  };
  const setSecili = async (v: boolean) => {
    if (saving) return;
    setSaving('secili');
    await save({ pavoOdemeSecili: v }, v ? 'Kasada seçilen ödeme türü cihazda hazır gelecek' : 'Ödeme türü cihazda seçilecek');
    setSaving(null);
  };
  const setEodFis = async (v: boolean) => {
    if (v === s.pavoEodFis || saving) return;
    setSaving('fis');
    // Cihaz kendi slibini ayardan bağımsız basar: ayar yalnız fiş yazıcısının kâğıdını açıp kapatır
    await save({ pavoEodFis: v }, v ? 'Gün sonu kâğıdı fiş yazıcısından da çıkacak' : 'Gün sonu kâğıdı yalnız cihazdan çıkacak');
    setSaving(null);
  };
  const setAutoEod = async (v: boolean) => {
    if (v === s.pavoAutoEod || saving) return;
    setSaving('eod');
    await save({ pavoAutoEod: v }, v ? 'Gün kapanınca cihazda gün sonu alınacak' : 'Cihazda gün sonu elle alınacak');
    setSaving(null);
  };
  // Ayarlar sırayla kaydedilir: biri kaydedilirken iki ray da soluk ve kilitli (dokunuş sessizce yutulmaz, kilit görünür)
  const locked = (key: 'provider' | 'mode') => ({ 'aria-busy': saving === key || undefined, className: cn('transition-opacity duration-150', saving && 'pointer-events-none opacity-60') });

  const caps = s.active
    ? [
        s.active.capabilities.instant && 'Kasada ödeme',
        s.active.capabilities.list && 'Masada ödeme',
        s.active.capabilities.splitPayment && 'Bölünmüş ödeme',
        ...s.active.capabilities.docKinds.map((d) => DOC_LABEL[d] ?? d),
      ].filter((t): t is string => !!t)
    : [];

  // Menüde kullanılan oranlar (küçükten büyüğe) cihazda eşlenmeli: eşlenmeyen oranlı hesap kasada gönderilemez
  const usedRates = [...new Set(boot.products.map((p) => String(p.kdvRate)))].filter((r) => r !== '0').sort((a, b) => Number(a) - Number(b));
  const rates = [...new Set([...RATES, ...usedRates])].sort((a, b) => Number(a) - Number(b));
  const missing = usedRates.filter((r) => !map[r]);
  const invalid = rates.filter((r) => map[r] && Number(map[r]) < 1);

  return (
    <div className="space-y-4">
      {header}
      {/* Program güncellemesi burada da (sahibin isteği): kasada Pavo ile uğraşırken Ayarlar ve yedek'e gitmeden "Şimdi güncelle" */}
      {!REMOTE && <UpdateCard />}
      {/* Bağlantı ve ödeme yeri tek seçimli ray (Paket platformlarındaki mod seçimi gibi): oklar gezer, seçim Enter ya da
          dokunuşla; telefonda ray tam genişlik, sığmayan seçenek alt satıra iner */}
      <Card title="Bağlantı" bodyClassName="space-y-4">
        <div {...locked('provider')}>
          <Segmented
            label="Yazarkasa bağlantısı"
            value={s.provider}
            onChange={(v) => void setProvider(v)}
            options={(['kapali', 'simulator', 'tokenx', 'pavo'] as const).map((value) => ({ value, label: PROVIDER_LABEL[value] }))}
          />
        </div>
        {s.provider === 'kapali' && <p className="text-sm text-muted">Adisyon cihaza gitmez; mali fişi kasiyer yazarkasada elle keser</p>}
        {caps.length > 0 && (
          // Cihazın yapabildikleri sakin bir onay listesi (kutu kalabalığı değil): yeşil tik, soluk yazı
          <div>
            <span className="text-xs font-medium text-[var(--admin-text-mute)]">Cihaz destekliyor</span>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {caps.map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--admin-text-soft)]">
                  <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-[var(--admin-success)]" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.provider === 'simulator' && (
          <p className="text-sm text-muted">
            Gerçek cihaz bağlanana kadar akışı denemek ve personeli eğitmek için; sepetler <Link to="/cihaz" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">eğitim cihazı</Link> ekranında ödenir
          </p>
        )}
        {s.provider === 'pavo' && (
          <p className="border-t border-[var(--admin-divider)] pt-4 text-sm text-muted">Ödeme yeri: kasada ödeme. Hesap cihazın ekranına düşer; Pavo masada ödeme listesi tutmaz</p>
        )}
        {s.provider !== 'kapali' && s.provider !== 'pavo' && (
          // Bağlantıdan sonra ikinci karar: satır ayracıyla ayrı bölüm (seçim rayı ve açıklaması birlikte)
          <div className="border-t border-[var(--admin-divider)] pt-4">
            <Label>Ödeme yeri</Label>
            <div {...locked('mode')}>
              <Segmented label="Ödeme yeri" value={s.mode} onChange={(v) => void setMode(v)} options={(['anlik', 'liste'] as const).map((value) => ({ value, label: MODE_LABEL[value] }))} />
            </div>
            {/* Seçime göre tek cümle; Token cihazının kendi ayarı yalnız Token seçiliyken */}
            <p className="mt-1.5 text-xs text-muted">{s.provider === 'tokenx' ? `${MODE_HINT[s.mode].what}; ${MODE_HINT[s.mode].token}` : MODE_HINT[s.mode].what}</p>
          </div>
        )}
        {s.provider !== 'kapali' && s.mode === 'anlik' && (
          <div className="max-w-2xl border-t border-[var(--admin-divider)] pt-4">
            <Toggle
              block
              checked={s.auto}
              disabled={saving === 'auto'}
              onChange={(v) => void setAuto(v)}
              label="Ödemeyi alınca cihaza gönder"
              hint={`Ödeme penceresinde “Ödemeyi al”a basınca hesap kendiliğinden cihaza gider; kapalıyken “Yazarkasaya gönder” ile${s.provider === 'simulator' ? '. Eğitim cihazında varsayılan kapalı' : ''}`}
            />
            {s.provider === 'pavo' && (
              <Toggle
                block
                className="mt-3"
                checked={s.pavoOdemeSecili !== false}
                disabled={saving === 'secili'}
                onChange={(v) => void setSecili(v)}
                label="Ödeme türü cihazda hazır gelsin"
                hint="Kasada “Kredi kartı al” denince cihaz doğrudan kartla, “Nakit al” denince nakitle açılır; kasiyer cihazda tür seçmez. Cihaz beklenmedik davranırsa kapatın"
              />
            )}
          </div>
        )}
      </Card>

      {s.provider === 'pavo' && (
        <>
          <Card
            title="Pavo (yerel ağ)"
            actions={
              s.pavo.configured ? (
                <Badge tone={s.pavo.paired ? 'success' : 'warning'} dot>
                  {s.pavo.paired ? 'Eşleştirildi' : 'Eşleştirilmedi'}
                </Badge>
              ) : (
                <Badge tone="danger" dot>
                  Bilgiler eksik
                </Badge>
              )
            }
            bodyClassName="space-y-4 text-sm"
          >
            {!s.pavo.configured || editDevice ? (
              <>
                {!s.pavo.configured && <p className="text-muted">Cihazın IP adresini ve seri numarasını yazın ya da cihazı ağda arayın; sonra Eşleştir</p>}
                <PavoDeviceForm s={s} onCancel={s.pavo.configured ? () => setEditDevice(false) : undefined} />
              </>
            ) : (
              <div className="max-w-2xl">
                <DefRow label="Cihaz adresi">
                  <span className="tabular break-all">{shortAddress(s.pavo.url)}</span>
                </DefRow>
                <DefRow label="Seri no">
                  <span className="tabular break-all">{s.pavo.serial}</span>
                </DefRow>
                {s.pavo.source === 'dosya' && (
                  <DefRow label="Kaynak">
                    <span className="font-normal text-[var(--admin-text-mute)]">Ayarlar dosyası (değiştirince buradaki geçerli olur)</span>
                  </DefRow>
                )}
                <DefRow label="Program kimliği">
                  <span className="tabular break-all">
                    {s.pavo.fingerprint}
                    <span className="font-normal text-[var(--admin-text-mute)]">
                      {s.pavo.fingerprintSource === 'yok' ? ' · ilk eşleştirmede kuruluma özel kimlik üretilir' : s.pavo.fingerprintSource === 'dosya' ? ' · ayarlar dosyasından' : s.pavo.fingerprintSource === 'eski' ? ' · önceki eşleştirmeden' : ''}
                    </span>
                  </span>
                </DefRow>
                {s.pavo.certificate && (
                  <DefRow label="Sertifika izi">
                    <span className="tabular break-all text-xs">{s.pavo.certificate.slice(0, 23)}…</span>
                  </DefRow>
                )}
                {s.pavo.busy && (
                  <DefRow label="Şu an">
                    <span>{s.pavo.busy === 'GUNSONU' ? 'Cihazda gün sonu sürüyor' : 'Cihazın ekranında süren bir satış var'}</span>
                  </DefRow>
                )}
              </div>
            )}
            {s.lastError && (
              <Notice tone="danger" title={`Son hata · ${fmtDateTime(s.lastError.at)}`} className="text-[13px]">
                {s.lastError.message}
                {s.pairingLost && s.pavo.configured && (
                  <div className="mt-2">
                    <Button size="sm" variant="primary" icon={<Link2 className="size-4" />} loading={checking === 'pair'} disabled={!!checking} onClick={() => void runPavo('pair')}>
                      Yeniden eşleştir
                    </Button>
                  </div>
                )}
              </Notice>
            )}
            {pavoTest && (
              <div className="space-y-3 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-4 ring-1 ring-inset ring-[var(--admin-border)]">
                <p className="flex items-center gap-2">
                  {pavoTest.ping.ok ? (
                    <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-success)]" />
                  ) : (
                    <XCircle aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-danger-ink)]" />
                  )}
                  {pavoTest.ping.ok ? 'Cihaz yanıt veriyor' : `Cihaz yanıtı: ${pavoTest.ping.message ?? 'hata'}`}
                </p>
                {pavoTest.pairingHint && <p className="text-[var(--admin-danger-ink)] [overflow-wrap:anywhere]">{pavoTest.pairingHint}</p>}
                {pavoTest.mediatorsNote && <p className="text-[13px] text-muted [overflow-wrap:anywhere]">{pavoTest.mediatorsNote}</p>}
                {pavoTest.mediators.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-[var(--admin-text-mute)]">Cihazdaki ödeme araçları</p>
                    <ul className="mt-1 max-w-md divide-y divide-[var(--admin-divider)]">
                      {pavoTest.mediators.map((m, i) => (
                        <li key={`${m.id}-${i}`} className="flex items-center gap-2.5 py-1.5">
                          <span className="grid size-6 shrink-0 place-items-center rounded-[var(--r-chip)] bg-[var(--admin-surface)] text-xs font-semibold tabular-nums text-[var(--admin-text-soft)] ring-1 ring-inset ring-[var(--admin-border)]">
                            {m.id ?? '–'}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[var(--admin-text)]">{m.name ?? 'Adsız'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:grow">
              <Button
                variant={s.pavo.configured && !s.pavo.paired ? 'primary' : 'secondary'}
                icon={<Link2 className="size-4" />}
                loading={checking === 'pair'}
                disabled={!s.pavo.configured || !!checking}
                onClick={() => void runPavo('pair')}
              >
                Eşleştir
              </Button>
              <Button icon={<PlugZap className="size-4" />} loading={checking === 'test'} disabled={!s.pavo.configured || !!checking} onClick={() => void runPavo('test')}>
                Bağlantıyı dene
              </Button>
              {s.pavo.configured && !editDevice && (
                <Button variant="ghost" icon={<Pencil className="size-4" />} disabled={!!checking || !!s.pavo.busy} onClick={() => setEditDevice(true)}>
                  Adresi değiştir
                </Button>
              )}
            </div>
            {checking === 'pair' && <p className="text-xs text-muted">Cihazdaki onay ekranını onaylayın (en çok 2 dakika beklenir)</p>}
          </Card>
          {s.pavo.configured && <PavoEodCard s={s} onAuto={(v) => void setAutoEod(v)} savingAuto={saving === 'eod'} onFis={(v) => void setEodFis(v)} savingFis={saving === 'fis'} />}
          {s.pavo.exchanges.length > 0 && (
            // Destek için: cihazın son yanıtlarının özeti (gövde değil); belgesiz yanıt biçimi buradan tanınır
            <SetupNotes summary="Cihazın son yanıtları">
              <ul className="divide-y divide-[var(--admin-divider)]">
                {s.pavo.exchanges.map((x, i) => (
                  <li key={`${x.at}-${i}`} className="py-2 first:pt-0">
                    <p className="text-[13px] font-medium text-[var(--admin-text)]">
                      {x.path} <span className="font-normal text-[var(--admin-text-mute)]">· {fmtDateTime(x.at)} · {x.ok ? 'tamam' : 'hata'}</span>
                    </p>
                    {(x.message || x.errorCode) && (
                      <p className="[overflow-wrap:anywhere]">
                        {x.message}
                        {x.errorCode ? ` (kod ${x.errorCode})` : ''}
                      </p>
                    )}
                    {x.dataKeys.length > 0 && <p className="text-xs [overflow-wrap:anywhere]">Alanlar: {x.dataKeys.join(', ')}</p>}
                  </li>
                ))}
              </ul>
            </SetupNotes>
          )}
          <PavoSetup open={!s.pavo.configured} />
        </>
      )}

      {s.provider === 'tokenx' && (
        <>
          {/* Durum başlığın sağında rozet (Genel bakış'ın sistem sağlığı gibi); tanımlı bilgiler etiket ve değer satırları,
              Token'a giden iki istek kartın dibinde kendi şeridinde */}
          <Card
            title="TokenX Connect (bulut)"
            actions={
              s.tokenx.configured ? (
                <Badge tone="success" dot>
                  Bilgiler tanımlı
                </Badge>
              ) : (
                <Badge tone="danger" dot>
                  Bilgiler eksik
                </Badge>
              )
            }
            bodyClassName="space-y-4 text-sm"
          >
            {!s.tokenx.configured && (
              <p className="flex items-center gap-2">
                <XCircle aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-danger-ink)]" />
                Token bilgileri eksik; kurulum adımları aşağıda
              </p>
            )}
            {((s.tokenx.configured && (s.tokenx.terminalId || s.tokenx.branchId)) || s.tokenx.webhookUrl) && (
              // Okunur genişlikte: geniş ekranda etiket ile değer kartın iki ucuna kaçmaz
              <div className="max-w-2xl">
                {s.tokenx.configured && s.tokenx.terminalId && (
                  <DefRow label="Terminal">
                    <span className="tabular break-all">{s.tokenx.terminalId}</span>
                  </DefRow>
                )}
                {s.tokenx.configured && s.tokenx.branchId && (
                  <DefRow label="Şube">
                    <span className="tabular break-all">{s.tokenx.branchId}</span>
                  </DefRow>
                )}
                {s.tokenx.webhookUrl && (
                  <DefRow label="Webhook adresi">
                    <span className="break-all">{s.tokenx.webhookUrl}</span>
                  </DefRow>
                )}
              </div>
            )}
            {!s.tokenx.webhookUrl && (
              <p className="text-xs text-muted">Webhook adresi yok: kafedeki sunucu internetten erişilemiyorsa LafPOS sepet durumunu 2,5 sn’de bir sorgular; sonuç yine gelir</p>
            )}
            {s.lastError && (
              <Notice tone="danger" title={`Son hata · ${fmtDateTime(s.lastError.at)}`} className="text-[13px]">
                {s.lastError.message}
              </Notice>
            )}
            {test && (
              // Denemenin sonucu kart içinde karo: cihaz ve kısımları (no, ad, oran), altında önerilen eşleme
              <div className="space-y-3 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-4 ring-1 ring-inset ring-[var(--admin-border)]">
                <div>
                  <p className="text-xs font-medium text-[var(--admin-text-mute)]">Cihaz</p>
                  <p className={cn('mt-0.5 [overflow-wrap:anywhere]', test.terminal.error ? 'text-[var(--admin-danger-ink)]' : 'tabular font-medium text-[var(--admin-text)]')}>
                    {test.terminal.error ? `Terminal bilgisi alınamadı: ${test.terminal.error}` : `${test.terminal.terminalId} · şube ${test.terminal.branchId}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--admin-text-mute)]">Kısımlar (KDV)</p>
                  <ul className="mt-1 max-w-md divide-y divide-[var(--admin-divider)]">
                    {test.sections.map((x) => (
                      <li key={x.sectionNo} className="flex items-center gap-2.5 py-1.5">
                        <span className="grid size-6 shrink-0 place-items-center rounded-[var(--r-chip)] bg-[var(--admin-surface)] text-xs font-semibold tabular-nums text-[var(--admin-text-soft)] ring-1 ring-inset ring-[var(--admin-border)]">{x.sectionNo}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--admin-text)]">{x.name}</span>
                        <span className="shrink-0 tabular-nums text-[var(--admin-text-mute)]">%{x.taxPercent / 100}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Button size="sm" variant="soft" onClick={() => editMap(Object.fromEntries(Object.entries(test.suggestedSectionMap).map(([k, v]) => [k, String(v)])))}>
                  Önerilen eşlemeyi kullan
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:grow">
              <Button icon={<PlugZap className="size-4" />} loading={checking === 'test'} disabled={!s.tokenx.configured} onClick={() => void runTest()}>
                Bağlantıyı dene
              </Button>
              <Button icon={<Webhook className="size-4" />} loading={checking === 'webhook'} disabled={!s.tokenx.configured || !s.tokenx.webhookUrl || !s.tokenx.webhookSecret} onClick={() => void registerWebhook()}>
                Webhook’u Token’a kaydet
              </Button>
            </div>
          </Card>
          {/* Bilgiler eksikken açık gelir: o an gereken tek şey bu, sayfanın sonunda aranmaz */}
          <TokenSetup open={!s.tokenx.configured} />
        </>
      )}

      {s.provider !== 'kapali' && s.provider !== 'pavo' && (
        // Açıklama kartın alt satırında (13 px soluk); Kaydet kartın dibinde ayraçlı şeritte, alanların hizasında (telefonda tam genişlik)
        <Card
          title="KDV oranı → cihazdaki kısım"
          subtitle={`Her KDV oranı cihazda tanımlı bir kısma (departman) gider. ${usedRates.length ? `Menüde kullanılan oranlar: ${usedRates.map((r) => `%${r}`).join(', ')}` : 'Menüde KDV oranı tanımlı ürün yok'}`}
          bodyClassName="space-y-4"
        >
          <div className="grid grid-cols-3 gap-3 sm:max-w-lg">
            {rates.map((r) => {
              const used = usedRates.includes(r);
              return (
                <Field
                  key={r}
                  // İki satırlık etiket her alanda aynı: dar ekranda kırılan ipucu alanları kaydırmaz
                  label={
                    <>
                      <span className="block">%{r} KDV</span>
                      {/* Menüde olan oran ev yeşili noktalı: eşlenmesi gereken oranlar bir bakışta ayrılır */}
                      <span className="flex items-center gap-1.5 text-xs font-normal text-muted">
                        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', used ? 'bg-[var(--admin-primary)]' : 'bg-[var(--admin-border-field)]')} />
                        {used ? 'menüde var' : 'menüde yok'}
                      </span>
                    </>
                  }
                  error={missing.includes(r) ? 'Kısım no gerekli' : invalid.includes(r) ? '1–99 arası' : null}
                >
                  <Input value={map[r] ?? ''} onChange={(e) => editMap({ ...map, [r]: e.target.value.replace(/\D/g, '').slice(0, 2) })} inputMode="numeric" maxLength={2} placeholder="Kısım no" className="tabular" />
                </Field>
              );
            })}
          </div>
          {/* Bağlantı ya da ödeme yeri kaydedilirken kapalı görünür (tıklama yutulmaz); Token denemesi sürerken kaydeder */}
          <div className="flex border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:flex-1">
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving === 'map'} disabled={!!saving || !mapDirty || missing.length > 0 || invalid.length > 0} onClick={() => void saveMap()}>
              Eşlemeyi kaydet
            </Button>
          </div>
        </Card>
      )}

      {/* Dört adım numaralı karolarda (açık nane dairede sıra no): telefonda alt alta, genişte ikişer; sırayı liste söyler,
          daire yalnız göz için */}
      <Card title="Nasıl çalışır">
        <ol className="grid gap-3 sm:grid-cols-2">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-3.5 text-sm text-[var(--admin-text-soft)] ring-1 ring-inset ring-[var(--admin-border)]">
              <span aria-hidden="true" className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums', TONE_SOFT.primary)}>
                {i + 1}
              </span>
              <span className="min-w-0 pt-0.5 leading-5">{step}</span>
            </li>
          ))}
        </ol>
      </Card>

      {s.provider !== 'tokenx' && <TokenSetup />}
      {s.provider !== 'pavo' && (
        <SetupNotes summary="Pavo kurulumu">
          <p>Pavo (N86 ve diğer PavoPay cihazları) kafenin ağında bağlanır: yukarıdan Pavo seçilir, cihazın IP adresi ve seri numarası yazılır (ya da cihaz ağda aranır), cihaz eşleştirilir. Ayrıntı: <code className={CODE}>docs/04-YAZARKASA.md</code></p>
        </SetupNotes>
      )}

      {/* Geliştirici bilgisi ana akışta kart değil: kurulum notu gibi kapalı durur, telefonda tablo yerine liste */}
      <SetupNotes summary="Diğer yazarkasa markaları">
        <ul className="divide-y divide-[var(--admin-divider)]">
          {OTHER_VENDORS.map((v) => (
            <li key={v.name} className="py-2 first:pt-0">
              <p className="text-[13px] font-medium text-[var(--admin-text)]">
                {v.name} <span className="font-normal text-[var(--admin-text-mute)]">· {v.channel}</span>
              </p>
              <p>{v.state}</p>
            </li>
          ))}
        </ul>
        <p>LafPOS’ta her marka ayrı bir sağlayıcıdır; üretici belgeyi ve test bilgilerini verince sağlayıcı eklenir, adisyon ve ödeme akışı değişmez. Masada ödemede GMP-3 §6.1 gereği üreticinin bulut kanalının bilgi fişi ve TSM kaydını desteklediği yazılı teyit edilmeli</p>
      </SetupNotes>
    </div>
  );
}
