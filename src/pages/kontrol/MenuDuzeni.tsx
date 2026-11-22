import { EyeOff, ListPlus, PackagePlus, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { Button } from '@/components/ui/Button';
import { Field, Input, SearchInput, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Card } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { fold } from '@/lib/shell';
import { toast } from '@/lib/toast';
import { NEDEN, type SekmeProps } from './ortak';

type Pencere = 'urun' | 'grup' | 'oge' | null;
type Oge = { ad: string; fiyat: string };

/**
 * Menüyü uzaktan düzenleme (sahibin isteği, 22 Kas 2026): ürün ekle (`urun.ekle`), yeni seçenek grubu (`secenek.grubu`),
 * var olan gruba seçenek ve ürün ekle (`secenek.duzenle`), kasada gizli ürünleri göster (`urun.gorunum`). Görünür ürünü
 * gizlemek satırdaki "Gizle" düğmesiyle (MenuSekmesi). Komutlar kasada kendi yönetim ucuyla uygulanır
 */
export function MenuDuzeni({ neden, gonder }: Pick<SekmeProps, 'neden' | 'gonder'>) {
  const boot = useBoot();
  const [pencere, setPencere] = useState<Pencere>(null);
  const [mesgul, setMesgul] = useState(false);
  const gizli = boot.products.filter((p) => p.hidden && !p.isService);
  const kategoriler = useMemo(() => [...boot.categories].sort((a, b) => a.sort - b.sort), [boot.categories]);
  // Sitenin sabit grupları (süt, şurup, shot) kasada değişmez: kasa reddeder, nedeni Geçmiş'te yazar
  const gruplar = boot.optionGroups;
  const kapali = neden('urun.ekle') ?? neden('secenek.grubu');

  const gonderVe = async (istek: Parameters<SekmeProps['gonder']>[0], tamam: string) => {
    setMesgul(true);
    try {
      await gonder(istek);
      toast.ok(tamam);
      setPencere(null);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setMesgul(false);
    }
  };

  return (
    <Card title="Menüyü düzenle" subtitle="Kasaya uzaktan ürün ve seçenek ekleyin; istek bir sonraki nabızda (en geç 5 dk) uygulanır">
      {kapali && <p className={`border-b border-[var(--admin-divider)] px-5 py-2.5 ${NEDEN}`}>{kapali}</p>}
      <div className="flex flex-wrap gap-2 px-5 py-4 max-sm:[&>*]:grow">
        <Button icon={<PackagePlus className="size-4" />} disabled={!!kapali} onClick={() => setPencere('urun')}>
          Ürün ekle
        </Button>
        <Button icon={<ListPlus className="size-4" />} disabled={!!kapali} onClick={() => setPencere('grup')}>
          Seçenek grubu ekle
        </Button>
        <Button icon={<Plus className="size-4" />} disabled={!!kapali || !gruplar.length} onClick={() => setPencere('oge')}>
          Gruba seçenek ekle
        </Button>
      </div>
      {gizli.length > 0 && (
        <section aria-label="Kasada gizli ürünler" className="border-t border-[var(--admin-divider)]">
          <h4 className="flex items-center gap-2 bg-surface-2 px-5 py-1.5 text-[13px] font-semibold text-ink">
            <EyeOff aria-hidden="true" className="size-3.5 text-muted" />
            Kasada gizli ({gizli.length})
          </h4>
          <ul className="divide-y divide-[var(--admin-divider)]">
            {gizli.map((p) => (
              <li key={p.id} className="flex min-h-14 items-center gap-3 px-5 py-2">
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="tabular text-sm text-muted">{tl(p.price)}</span>
                <Button size="sm" variant="ghost" disabled={mesgul || !!neden('urun.gorunum')} onClick={() => void gonderVe({ tur: 'urun.gorunum', veri: { id: p.id, gorunur: true }, ad: p.name }, `${p.name} kasada yeniden görünecek`)}>
                  Göster
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <UrunEkle open={pencere === 'urun'} onClose={() => setPencere(null)} kategoriler={kategoriler} mesgul={mesgul} onSave={(veri) => void gonderVe({ tur: 'urun.ekle', veri, ad: veri.ad }, `${veri.ad} kasaya eklenecek`)} />
      <GrupPenceresi
        open={pencere === 'grup' || pencere === 'oge'}
        yeni={pencere === 'grup'}
        onClose={() => setPencere(null)}
        gruplar={gruplar}
        urunler={boot.products.filter((p) => !p.isService)}
        mesgul={mesgul}
        onYeni={(veri) => void gonderVe({ tur: 'secenek.grubu', veri }, `"${veri.ad}" grubu kasaya eklenecek`)}
        onEkle={(veri, ad) => void gonderVe({ tur: 'secenek.duzenle', veri }, `${ad} grubuna ekleme kasaya gidecek`)}
      />
    </Card>
  );
}

function UrunEkle({
  open,
  onClose,
  kategoriler,
  mesgul,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  kategoriler: { id: string; name: string }[];
  mesgul: boolean;
  onSave: (v: { ad: string; kategori: string; fiyat: number; kdv: number; gruplar: string[] }) => void;
}) {
  const [ad, setAd] = useState('');
  const [kategori, setKategori] = useState('');
  const [fiyat, setFiyat] = useState('');
  const [kdv, setKdv] = useState('10');
  const [hata, setHata] = useState<string | null>(null);
  const kaydet = () => {
    const k = parseTL(fiyat);
    if (!ad.trim()) return setHata('Ürün adını yazın');
    if (!kategori) return setHata('Kategori seçin');
    if (k == null || k <= 0) return setHata('Fiyatı yazın (ör. 250)');
    setHata(null);
    onSave({ ad: ad.trim(), kategori, fiyat: k, kdv: Number(kdv), gruplar: [] });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ürün ekle"
      subtitle="Kasada yerel ürün olarak açılır; stoktan düşmesi için ladmin'de aynı adla reçete gerekir"
      footer={
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={mesgul} onClick={kaydet}>
            Kasaya ekle
          </Button>
        </div>
      }
    >
      <div className="space-y-3 p-5">
        <Field label="Ürün adı">
          <Input value={ad} onChange={(e) => setAd(e.target.value)} maxLength={80} placeholder="Ör. Meyveli Cup" />
        </Field>
        <Field label="Kategori">
          <Select value={kategori} onChange={(e) => setKategori(e.target.value)}>
            <option value="">Seçin</option>
            {kategoriler.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fiyat (₺)">
            <Input value={fiyat} onChange={(e) => setFiyat(e.target.value)} inputMode="decimal" placeholder="250" />
          </Field>
          <Field label="KDV">
            <Select value={kdv} onChange={(e) => setKdv(e.target.value)}>
              <option value="10">%10</option>
              <option value="20">%20</option>
              <option value="0">%0</option>
            </Select>
          </Field>
        </div>
        {hata && <p role="alert" className="text-[13px] font-medium text-[var(--admin-danger-ink)]">{hata}</p>}
      </div>
    </Modal>
  );
}

function GrupPenceresi({
  open,
  yeni,
  onClose,
  gruplar,
  urunler,
  mesgul,
  onYeni,
  onEkle,
}: {
  open: boolean;
  yeni: boolean;
  onClose: () => void;
  gruplar: { id: string; name: string }[];
  urunler: { id: string; name: string; hidden: boolean }[];
  mesgul: boolean;
  onYeni: (v: { ad: string; zorunlu: boolean; ogeler: { ad: string; fiyat: number; varsayilan: boolean }[]; urunler: string[] }) => void;
  onEkle: (v: { grup: string; ogeler: { ad: string; fiyat: number }[]; urunler: string[] }, ad: string) => void;
}) {
  const [ad, setAd] = useState('');
  const [grup, setGrup] = useState('');
  const [ogeler, setOgeler] = useState<Oge[]>([{ ad: '', fiyat: '' }]);
  const [secili, setSecili] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState('');
  const [hata, setHata] = useState<string | null>(null);
  const k = fold(q.trim());
  const liste = urunler.filter((u) => !u.hidden && (!k || fold(u.name).includes(k)));
  const kaydet = () => {
    const dolu = ogeler.filter((o) => o.ad.trim());
    const cevrilmis = dolu.map((o) => ({ ad: o.ad.trim(), fiyat: o.fiyat.trim() ? parseTL(o.fiyat) : 0 }));
    if (cevrilmis.some((o) => o.fiyat == null || o.fiyat < 0)) return setHata('Fiyatları sayı olarak yazın (ör. 50); ücretsizse boş bırakın');
    const temiz = cevrilmis as { ad: string; fiyat: number }[];
    if (yeni) {
      if (!ad.trim()) return setHata('Grup adını yazın');
      if (!temiz.length) return setHata('En az bir seçenek yazın');
      setHata(null);
      return onYeni({ ad: ad.trim(), zorunlu: false, ogeler: temiz.map((o, i) => ({ ...o, varsayilan: i === 0 })), urunler: [...secili] });
    }
    if (!grup) return setHata('Grup seçin');
    if (!temiz.length && !secili.size) return setHata('Seçenek ya da ürün ekleyin');
    setHata(null);
    onEkle({ grup, ogeler: temiz, urunler: [...secili] }, gruplar.find((g) => g.id === grup)?.name ?? 'Seçilen');
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={yeni ? 'Seçenek grubu ekle' : 'Gruba seçenek ekle'}
      subtitle={yeni ? 'Tek seçimli grup (ör. Latte çeşidi); ilk seçenek varsayılan gelir' : 'Var olan seçenekler ve bağlı ürünler olduğu gibi kalır; yalnız eklenir'}
      footer={
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={mesgul} onClick={kaydet}>
            Kasaya gönder
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-5">
        {yeni ? (
          <Field label="Grup adı">
            <Input value={ad} onChange={(e) => setAd(e.target.value)} maxLength={40} placeholder="Ör. Latte çeşidi" />
          </Field>
        ) : (
          <Field label="Grup">
            <Select value={grup} onChange={(e) => setGrup(e.target.value)}>
              <option value="">Seçin</option>
              {gruplar.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">Seçenekler (ad ve ek fiyat ₺)</legend>
          {ogeler.map((o, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={`Seçenek ${i + 1} adı`} value={o.ad} onChange={(e) => setOgeler((l) => l.map((x, j) => (j === i ? { ...x, ad: e.target.value } : x)))} maxLength={40} placeholder={i === 0 && yeni ? 'Ör. Klasik' : 'Ör. Spanish Latte'} className="min-w-0 flex-1" />
              <Input aria-label={`Seçenek ${i + 1} ek fiyatı`} value={o.fiyat} onChange={(e) => setOgeler((l) => l.map((x, j) => (j === i ? { ...x, fiyat: e.target.value } : x)))} inputMode="decimal" placeholder="0" className="w-24" />
              <Button variant="ghost" aria-label={`Seçenek ${i + 1} sil`} icon={<Trash2 className="size-4" />} disabled={ogeler.length === 1} onClick={() => setOgeler((l) => l.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={ogeler.length >= 30} onClick={() => setOgeler((l) => [...l, { ad: '', fiyat: '' }])}>
            Seçenek ekle
          </Button>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">Bağlanacak ürünler ({secili.size})</legend>
          <SearchInput value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ara" wrapperClassName="mb-2" />
          <ul className="max-h-64 divide-y divide-[var(--admin-divider)] overflow-y-auto rounded-[var(--r-tile)] border border-[var(--admin-border)]">
            {liste.map((u) => (
              <li key={u.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--admin-ink-fill)]"
                    checked={secili.has(u.id)}
                    onChange={(e) =>
                      setSecili((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(u.id);
                        else n.delete(u.id);
                        return n;
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{u.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {hata && <p role="alert" className="text-[13px] font-medium text-[var(--admin-danger-ink)]">{hata}</p>}
      </div>
    </Modal>
  );
}
