import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, KeyRound, ShieldCheck, Store, UsersRound, UtensilsCrossed } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { KomutIstegi, KomutTuru, KontrolPaneli } from '@shared/kontrol';
import type { Role } from '@shared/permissions';
import { buttonClass } from '@/components/ui/Button';
import { Badge, EmptyState, ErrorState, FLOAT_CARD, Notice, RAIL_FADE, Skeleton, useRail } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { ApiError } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { DOWNLOAD_PATH, MERKEZ_PATH } from '@/lib/download';
import { useTick } from '@/lib/hooks';
import { komutGonder, kontrolAnahtari, kontrolDurumSorgusu } from '@/lib/kontrol';
import { REMOTE, remoteShopsQuery, storedShop } from '@/lib/remote';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { confirmLeave } from '@/lib/unsavedGuard';
import { EkipSekmesi } from './EkipSekmesi';
import { ErisimSekmesi } from './ErisimSekmesi';
import { GecmisSekmesi } from './GecmisSekmesi';
import { KasaSekmesi } from './KasaSekmesi';
import { MenuSekmesi } from './MenuSekmesi';
import { NOT, type SekmeProps } from './ortak';
import { RollerSekmesi } from './RollerSekmesi';
import {
  bekleyenHaritasi,
  gecerliDurum,
  genelNeden,
  gorulmeMetni,
  hedefBulucu,
  islemNedeni,
  kasaCevrimici,
  type Sekme,
  SEKME_ETIKET,
  sekmeler,
  sekmeSec,
  secenekGruplari,
  urunSatirlari,
  uygulananHaritasi,
} from './yardimci';

const SEKME_IKON: Record<Sekme, ReactNode> = {
  ekip: <UsersRound aria-hidden="true" />,
  roller: <ShieldCheck aria-hidden="true" />,
  menu: <UtensilsCrossed aria-hidden="true" />,
  kasa: <Store aria-hidden="true" />,
  erisim: <KeyRound aria-hidden="true" />,
  gecmis: <History aria-hidden="true" />,
};

/** Biten işlemden sonra menü özetinin yeniden sorulduğu anlar: hemen ve kasanın bir sonraki itmesinden sonra */
const MENU_YENILE_MS = [0, 30_000];
/** Sonucu beklenen (kuyruktan düşmüş, geçmişte henüz görünmeyen) en çok bu kadar işlem izlenir */
const IZLENEN_EN_COK = 100;

/**
 * LafPOS Uzaktan › Uzaktan yönetim (docs/UZAKTAN-YONETIM.md): kasanın personeli, PIN'leri, rol yetkileri, Tükendi'si ve
 * servis modu telefondan. Her değişiklik buluttaki kuyruğa girer, kasa Merkez nabzında alır ve kasadaki yönetim
 * ekranının kurallarıyla uygular; ekranda "Bekliyor → Uygulandı / Reddedildi" görünür. Sahip burada panele kimin
 * gireceğini de belirler (Erişim). Rol kapısı arayüzde de var (izleyici yalnız görür, yönetici patron hesabına ve rol
 * yetkilerine dokunamaz); asıl denetim bulutta ve kasada
 */
export default function KontrolPage() {
  const qc = useQueryClient();
  const q = useQuery(kontrolDurumSorgusu);
  const boot = useBoot();
  const shops = useQuery({ ...remoteShopsQuery, enabled: REMOTE });
  const [params, setParams] = useSearchParams();
  const now = useTick(30_000);
  const p = q.data;
  const rol = p?.ben.rol;
  const liste = sekmeler(rol);
  const sekme = sekmeSec(params.get('sekme'), rol);
  const rail = useRail<HTMLDivElement>(`${sekme}:${liste.length}`);
  const durum = gecerliDurum(p?.durum);
  const dukkan = boot.branch?.name || shops.data?.find((s) => s.id === storedShop())?.ad || boot.settings.businessName || 'Kafe';

  // Sekme adreste (?sekme=): yenileyince ve paylaşılan bağlantıda aynı sekme açılır. Roller'de kaydedilmemiş değişiklik
  // varken sekme değişmeden önce sorulur (sekme değişince taslak gider)
  const sec = async (s: Sekme) => {
    if (s === sekme || !(await confirmLeave())) return;
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (s === 'ekip') n.delete('sekme');
        else n.set('sekme', s);
        return n;
      },
      { replace: true },
    );
  };

  // Bekleyen işlemin satırı: ürün ve seçenek adları menü özetinden, kişiler kasanın özetinden
  const bul = useMemo(
    () =>
      hedefBulucu({
        personel: durum?.personel.map((k) => ({ id: k.id, ad: k.ad })) ?? [],
        urun: urunSatirlari(boot).map((u) => ({ id: u.id, ad: u.ad })),
        secenek: secenekGruplari(boot).flatMap((g) => g.secenekler.map((s) => ({ id: s.id, ad: s.ozetAdi }))),
      }),
    [durum?.personel, boot],
  );
  const bekleyen = useMemo(() => bekleyenHaritasi(p?.bekleyen ?? [], bul), [p?.bekleyen, bul]);
  const uygulanan = useMemo(() => uygulananHaritasi(p?.gecmis ?? [], boot.serverTime, bul), [p?.gecmis, boot.serverTime, bul]);

  // Bir işlem bitince (kuyruktan düştü) menü özeti hemen ve kasanın bir sonraki itmesinden sonra yeniden sorulur
  // (değişmediyse 304): Tükendi'nin yeni hâli 5 dakikalık yoklamayı beklemesin. Sonucu da duyurulur: reddedilen işlem
  // satırdaki "Bekliyor" rozeti düşünce uygulanmış gibi görünmesin (toast, ekran okuyucu ve Geçmiş'te kırmızı sayı)
  const onceki = useRef<string[]>([]);
  const sonucuBeklenen = useRef(new Set<string>());
  const zamanlar = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [yeniRet, setYeniRet] = useState<string[]>([]);
  const [duyuru, setDuyuru] = useState('');
  const bekleyenIdler = (p?.bekleyen ?? []).map((b) => b.id).join(',');
  const gecmis = p?.gecmis;
  useEffect(() => {
    const simdi = bekleyenIdler ? bekleyenIdler.split(',') : [];
    const dusen = onceki.current.filter((id) => !simdi.includes(id));
    onceki.current = simdi;
    if (dusen.length) {
      for (const ms of MENU_YENILE_MS) zamanlar.current.push(setTimeout(() => void qc.invalidateQueries({ queryKey: ['bootstrap'] }), ms));
      for (const id of dusen) sonucuBeklenen.current.add(id);
      // Sonucu hiç gelmeyen (geçmişten taşmış) kimlik birikmesin
      for (const id of [...sonucuBeklenen.current].slice(0, Math.max(0, sonucuBeklenen.current.size - IZLENEN_EN_COK))) sonucuBeklenen.current.delete(id);
    }
    // Kuyruktan düşen işlemin sonucu geçmişte (aynı yanıtta ya da bir sonrakinde): iptal sessiz, öteki duyurulur
    const retler: string[] = [];
    const metinler: string[] = [];
    for (const id of [...sonucuBeklenen.current]) {
      const g = gecmis?.find((x) => x.id === id);
      if (!g) continue;
      sonucuBeklenen.current.delete(id);
      if (g.durum === 'reddedildi') {
        retler.push(id);
        const metin = `Reddedildi: ${g.ozet}${g.mesaj ? `. ${g.mesaj}` : ''}`;
        metinler.push(metin);
        toast.err(metin);
      } else if (g.durum === 'uygulandi') {
        metinler.push(`Uygulandı: ${g.ozet}`);
        toast.ok(`Kasada uygulandı: ${g.ozet}`);
      }
    }
    if (retler.length) setYeniRet((x) => [...x, ...retler]);
    if (metinler.length) setDuyuru(metinler.join('. '));
  }, [bekleyenIdler, gecmis, qc]);
  useEffect(() => () => zamanlar.current.forEach(clearTimeout), []);
  // Geçmiş açıkken (ya da açılınca) görülmemiş ret sayısı sıfırlanır
  useEffect(() => {
    if (sekme === 'gecmis' && yeniRet.length) setYeniRet([]);
  }, [sekme, yeniRet.length]);

  const panelKasa = p?.kasa;
  const gonder = useCallback(
    async (istek: KomutIstegi) => {
      const r = await komutGonder(istek);
      // Satır hemen "Bekliyor" olsun; kasa çevrimiçiyse yoklama 15 sn'ye iner
      qc.setQueryData<KontrolPaneli>(kontrolAnahtari.durum, (d) => (d && !d.bekleyen.some((b) => b.id === r.komut.id) ? { ...d, bekleyen: [...d.bekleyen, r.komut] } : d));
      void qc.invalidateQueries({ queryKey: kontrolAnahtari.durum });
      // Kasa kapalıysa "5 dakikada" sözü verilmez: işlem kasa açılınca (24 saat içinde) uygulanır
      if (kasaCevrimici(panelKasa?.sonGorulme, Date.now())) toast.ok('Sıraya alındı; kasa en geç 5 dakikada uygular');
      else toast.warn('Sıraya alındı. Kasa şu an çevrimdışı: açılınca uygulanır (24 saat içinde)');
      return r.komut;
    },
    [qc, panelKasa?.sonGorulme],
  );

  const genel = p ? genelNeden(p) : null;
  const neden = useCallback((tur: KomutTuru, hedefRoller?: (Role | undefined)[]) => (p ? islemNedeni(p, tur, hedefRoller) : 'Yükleniyor'), [p]);
  const ortak: SekmeProps | null = p ? { panel: p, durum, genel, neden, bekleyen, uygulanan, gonder } : null;

  // Ekranın sekmeleri: tablette ve bilgisayarda üst çubuğun ortasında, telefonda başlığın altında yatay kayan şerit;
  // seçili sekme şeritte görünür kalır (?sekme=gecmis ile açılınca da), gizli içeriğin kenarı solar (useRail)
  const menu = (
    <div ref={rail} role="tablist" aria-label="Uzaktan yönetim bölümleri" className={cn('lp-menu', RAIL_FADE)}>
      {liste.map((s) => (
        // relative: sayının ekran okuyucu eki (sr-only, mutlak konumlu) şeridin kaydırma kabında kalsın; yoksa sahnenin
        // başlığına göre konumlanıp sayfayı yana taşırırdı
        <button key={s} id={`kontrol-sekme-${s}`} type="button" role="tab" aria-selected={sekme === s} aria-controls="kontrol-paneli" onClick={() => void sec(s)} className="lp-menu-item relative">
          {SEKME_IKON[s]}
          <span className="min-w-0 flex-1 truncate">{SEKME_ETIKET[s]}</span>
          {s === 'gecmis' && sekme !== 'gecmis' && yeniRet.length > 0 && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--admin-danger-soft)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--admin-danger-ink)]">
              {yeniRet.length}
              <span className="sr-only"> yeni reddedilen</span>
            </span>
          )}
          {s === 'gecmis' && !!p?.bekleyen.length && (
            <span className="n">
              {p.bekleyen.length}
              <span className="sr-only"> bekliyor</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    // Telefonda ekranın adını kabuğun üst şeridi yazar (sahnedeki başlık ekran okuyucuda kalır), açıklama görünür
    <Stage name="Uzaktan yönetim" sub="Kasanın personeli, rol yetkileri, Tükendi’si ve servis modu" leafLabel="Uzaktan yönetim" float menu={menu}>
      {/* Tek sütun en çok yaprak kadar (minmax(0, 1fr)): uzun kategori adlı seçici ya da e-posta kartı yapraktan taşırmasın */}
      <div className="lp-leaf-pad grid grid-cols-[minmax(0,1fr)] gap-[var(--grid-gap)]">
        {q.isPending ? (
          <div role="status" aria-label="Yükleniyor…" className="grid gap-[var(--grid-gap)]">
            <Skeleton className="h-28 rounded-[var(--r-card)]" />
            <Skeleton className="h-64 rounded-[var(--r-card)]" />
          </div>
        ) : !p || !ortak ? (
          q.error instanceof ApiError && q.error.code === 'remote_admin' ? (
            // Parolasız görünüm: gerçek giriş yok, yeniden denemek bir şey değiştirmez
            <EmptyState className={FLOAT_CARD} icon={<KeyRound />} title="Bu girişle kasa yönetilmez">
              Uzaktan yönetim yalnız üye girişiyle açılır. Kurulumda panele sahip üyeliği açılınca (sahip e-postası) buradan personel, PIN ve Tükendi yönetilir
            </EmptyState>
          ) : (
            <ErrorState className={FLOAT_CARD} title="Uzaktan yönetim açılamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
          )
        ) : (
          <>
            {/* İşlem sonuçları ekran okuyucuya (toast'a ek olarak) */}
            <div aria-live="polite" className="sr-only">
              {duyuru}
            </div>
            <KasaKarti panel={p} dukkan={dukkan} now={now} />
            {p.demo ? (
              <Notice tone="info" role="note">
                Örnek görünüm: işlem düğmeleri kapalı. Kafe bağlanınca kasa buradan yönetilir
              </Notice>
            ) : p.ben.rol === 'izleyici' ? (
              <Notice tone="info" role="note" title="Yalnız görme yetkiniz var">
                Değişiklik yapamazsınız; yetkiyi panelin sahibi verir
              </Notice>
            ) : !durum && !p.kasa ? (
              // Kasa Merkez'e hiç bağlanmadı: güncellenecek bir kasa yok, önce program kurulur
              <Notice
                tone="warn"
                title="Kasa henüz bağlanmadı"
                action={
                  <Link to={DOWNLOAD_PATH} className={buttonClass('secondary', 'sm')}>
                    İndir
                  </Link>
                }
              >
                Programı kasa bilgisayarına kurun; kasa internete çıkınca burası açılır
              </Notice>
            ) : !durum ? (
              p.ben.rol === 'sahip' ? (
                <Notice
                  tone="warn"
                  title="Kasa güncel değil"
                  action={
                    <Link to={MERKEZ_PATH} className={buttonClass('secondary', 'sm')}>
                      Merkez’e git
                    </Link>
                  }
                >
                  Merkez’den güncelleme gönderin; kasa kurunca burası açılır
                </Notice>
              ) : (
                <Notice tone="warn" title="Kasa güncel değil">
                  Kasanın güncellenmesi için panelin sahibine haber verin; kasa kurunca burası açılır
                </Notice>
              )
            ) : !durum.acik ? (
              <Notice tone="warn" title="Kasada uzaktan yönetim kapalı">
                Kasada Yönetim › Ağ ve uzaktan erişim › Uzaktan yönetim açılınca işlemler kasaya gider
              </Notice>
            ) : genel ? (
              <Notice tone="warn" title="Kasa daha yeni bir sürümde">
                Sayfayı yenileyin; yeni sürüm yüklenince işlemler açılır
              </Notice>
            ) : !kasaCevrimici(p.kasa?.sonGorulme, now) ? (
              <Notice tone="warn" title="Kasa çevrimdışı">
                Gönderilen işlemler kasa açılınca uygulanır; 24 saat içinde ulaşmayan işlem uygulanmaz
              </Notice>
            ) : null}
            <div role="tabpanel" id="kontrol-paneli" aria-labelledby={`kontrol-sekme-${sekme}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[var(--grid-gap)]">
              {sekme === 'ekip' && <EkipSekmesi {...ortak} />}
              {sekme === 'roller' && <RollerSekmesi {...ortak} />}
              {sekme === 'menu' && <MenuSekmesi {...ortak} />}
              {sekme === 'kasa' && <KasaSekmesi {...ortak} />}
              {sekme === 'erisim' && <ErisimSekmesi panel={p} />}
              {sekme === 'gecmis' && <GecmisSekmesi panel={p} />}
            </div>
          </>
        )}
      </div>
    </Stage>
  );
}

/** Sayfanın başı: dükkân, kasanın son görülmesi ve sürümü, uzaktan yönetimin kasadaki anahtarı, teslim süresi */
function KasaKarti({ panel, dukkan, now }: { panel: KontrolPaneli; dukkan: string; now: number }) {
  const kasa = panel.kasa;
  const durum = gecerliDurum(panel.durum);
  const online = kasaCevrimici(kasa?.sonGorulme, now);
  return (
    <section aria-label="Kasa" className={cn(FLOAT_CARD, 'p-5')}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold leading-6 tracking-[-0.015em]">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', online ? 'bg-[var(--admin-success)]' : 'bg-[var(--admin-text-mute)]')} />
            <span className="truncate">{dukkan}</span>
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {kasa
              ? joinMeta([online ? 'Kasa çevrimiçi' : `Kasa son görülme ${gorulmeMetni(kasa.sonGorulme, now)}`, kasa.surum ? `Sürüm ${kasa.surum}` : 'Sürüm bilinmiyor', kasa.gunAcik == null ? null : kasa.gunAcik ? 'gün açık' : 'gün kapalı'])
              : 'Kasa henüz Merkez’e bağlanmadı'}
          </p>
        </div>
        {durum ? (
          <Badge tone={durum.acik ? 'success' : 'warning'} dot>
            {durum.acik ? 'Uzaktan yönetim açık' : 'Uzaktan yönetim kapalı'}
          </Badge>
        ) : (
          <Badge tone="warning">{kasa ? 'Kasa güncel değil' : 'Kasa bağlı değil'}</Badge>
        )}
      </div>
      <p className={cn('mt-3 border-t border-[var(--admin-divider)] pt-3', NOT)}>
        {online || !kasa
          ? 'Değişiklik kasaya en geç 5 dakikada ulaşır; komut aldıktan sonra kasa 10 dakika dakikada bir uğrar'
          : 'Kasa çevrimdışı: değişiklik kasa açılınca uygulanır (24 saat içinde)'}
      </p>
    </section>
  );
}
