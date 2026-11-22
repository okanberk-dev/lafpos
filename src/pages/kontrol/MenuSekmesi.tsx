import { PackageSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SearchInput, Segmented, Select, Toggle } from '@/components/ui/Field';
import { Card, EmptyState } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { fold } from '@/lib/shell';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { BekliyorRozeti, NEDEN, type SekmeProps } from './ortak';
import { satisGorunumu, secenekGruplari, urunSatirlari } from './yardimci';

type Liste = 'urun' | 'secenek';

/**
 * Menü: ürün ve seçeneklerde Satışta / Tükendi (Tükenen ürünler penceresinin uzaktaki hâli). Liste uzaktan özetin
 * açılış verisinden; anahtar `urun.satis` ya da `secenek.satis` komutu koyar, adı özet için istekle gider. Bekleyen
 * istek ve kasada uygulanıp özete henüz yansımamış işlem satırda görünür (yardimci.ts `satisGorunumu`)
 */
export function MenuSekmesi({ genel, neden, bekleyen, uygulanan, gonder }: SekmeProps) {
  const boot = useBoot();
  const [liste, setListe] = useState<Liste>('urun');
  const [q, setQ] = useState('');
  const [kategori, setKategori] = useState('');
  const [mesgul, setMesgul] = useState<string | null>(null);
  const urunler = useMemo(() => urunSatirlari(boot), [boot]);
  const gruplar = useMemo(() => secenekGruplari(boot), [boot]);
  const kategoriler = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of urunler) if (!seen.has(u.kategoriId)) seen.set(u.kategoriId, u.kategori);
    return [...seen];
  }, [urunler]);
  const k = fold(q.trim());
  const secenekListesi = liste === 'secenek' && gruplar.length > 0;
  const gorunenUrunler = urunler.filter((u) => (!kategori || u.kategoriId === kategori) && (!k || fold(u.ad).includes(k)));
  const gorunenGruplar = gruplar
    .map((g) => ({ ...g, secenekler: !k || fold(g.ad).includes(k) ? g.secenekler : g.secenekler.filter((s) => fold(s.ad).includes(k)) }))
    .filter((g) => g.secenekler.length > 0);
  const urunNeden = neden('urun.satis');
  const secenekNeden = neden('secenek.satis');
  const durumu = (anahtar: string, asil: boolean) => satisGorunumu(anahtar, asil, bekleyen, uygulanan);
  const tukenenUrun = urunler.filter((u) => !durumu(`urun:${u.id}`, u.satista).satista).length;
  const tukenenSecenek = gruplar.reduce((n, g) => n + g.secenekler.filter((s) => !durumu(`secenek:${s.id}`, s.satista).satista).length, 0);

  const degistir = async (anahtar: string, tur: 'urun.satis' | 'secenek.satis', id: string, ad: string, satista: boolean) => {
    setMesgul(anahtar);
    try {
      await gonder({ tur, veri: { id, satista }, ad });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setMesgul(null);
    }
  };

  const nedenSatiri = (n: string | null) => n && n !== genel && <p className={cn('border-b border-[var(--admin-divider)] px-5 py-2.5', NEDEN)}>{n}</p>;
  const aramaVar = !!q.trim();
  const bos = (ad: string) => (
    <EmptyState
      compact
      art={aramaVar ? 'arama' : undefined}
      icon={aramaVar ? undefined : <PackageSearch />}
      title={aramaVar ? `“${q.trim()}” ile eşleşen ${ad} yok` : `Kasada satılan ${ad} yok`}
      action={
        aramaVar ? (
          <Button size="sm" variant="ghost" onClick={() => setQ('')}>
            Aramayı temizle
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <Card
      title="Satışta ve tükendi"
      subtitle={secenekListesi ? `${tukenenSecenek} seçenek tükendi` : `${tukenenUrun} ürün tükendi`}
      actions={
        gruplar.length > 0 && (
          <Segmented<Liste>
            label="Liste"
            value={liste}
            onChange={setListe}
            options={[
              { value: 'urun', label: 'Ürünler' },
              { value: 'secenek', label: 'Seçenekler' },
            ]}
          />
        )
      }
    >
      <div className="flex flex-wrap gap-2 border-b border-[var(--admin-divider)] px-5 py-3">
        <SearchInput
          value={q}
          onChange={setQ}
          label={secenekListesi ? 'Seçenek ara' : 'Ürün ara'}
          placeholder={secenekListesi ? 'Seçenek ara (yulaf, karamel…)' : 'Ürün ara'}
          wrapperClassName="min-w-0 flex-[1_1_14rem]"
        />
        {!secenekListesi && kategoriler.length > 1 && (
          <label className="min-w-0 flex-[1_1_10rem]">
            <span className="sr-only">Kategori</span>
            <Select value={kategori} onChange={(e) => setKategori(e.target.value)}>
              <option value="">Tüm kategoriler</option>
              {kategoriler.map(([id, ad]) => (
                <option key={id} value={id}>
                  {ad}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      {secenekListesi ? (
        <>
          {nedenSatiri(secenekNeden)}
          {gorunenGruplar.length === 0
            ? bos('seçenek')
            : gorunenGruplar.map((g) => (
                <section key={g.id} aria-label={g.ad}>
                  <h4 className="flex items-baseline gap-2 border-b border-[var(--admin-divider)] bg-surface-2 px-5 py-1.5">
                    <span className="shrink-0 text-[13px] font-semibold text-ink">{g.ad}</span>
                    <span className="min-w-0 truncate text-xs text-muted">{g.kullanan.length > 2 ? `${g.kullanan.slice(0, 2).join(', ')} ve ${g.kullanan.length - 2} ürün daha` : g.kullanan.join(', ')}</span>
                  </h4>
                  <ul className="divide-y divide-[var(--admin-divider)] border-b border-[var(--admin-divider)]">
                    {g.secenekler.map((s) => {
                      const anahtar = `secenek:${s.id}`;
                      const d = durumu(anahtar, s.satista);
                      return (
                        <SatisSatiri
                          key={s.id}
                          ad={s.ad}
                          alt={null}
                          satista={d.satista}
                          bekliyor={d.bekliyor}
                          disabled={!!secenekNeden || d.bekliyor || mesgul === anahtar}
                          title={secenekNeden ?? (d.bekliyor ? 'İstek kasaya ulaşınca uygulanır; iptal Geçmiş’te' : undefined)}
                          onChange={(v) => void degistir(anahtar, 'secenek.satis', s.id, s.ozetAdi, v)}
                        />
                      );
                    })}
                  </ul>
                </section>
              ))}
        </>
      ) : (
        <>
          {nedenSatiri(urunNeden)}
          {gorunenUrunler.length === 0 ? (
            bos('ürün')
          ) : (
            <ul className="divide-y divide-[var(--admin-divider)]">
              {gorunenUrunler.map((u) => {
                const anahtar = `urun:${u.id}`;
                const d = durumu(anahtar, u.satista);
                return (
                  <SatisSatiri
                    key={u.id}
                    ad={u.ad}
                    alt={u.kategori}
                    satista={d.satista}
                    site={u.site && !d.satista}
                    bekliyor={d.bekliyor}
                    disabled={!!urunNeden || d.bekliyor || mesgul === anahtar}
                    title={urunNeden ?? (d.bekliyor ? 'İstek kasaya ulaşınca uygulanır; iptal Geçmiş’te' : undefined)}
                    onChange={(v) => void degistir(anahtar, 'urun.satis', u.id, u.ad, v)}
                  />
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** Ürün ya da seçenek satırı: ad, kategori, kırmızı "Tükendi" durumu (yazıyla), Bekliyor rozeti ve Satışta anahtarı */
function SatisSatiri({
  ad,
  alt,
  satista,
  site,
  bekliyor,
  disabled,
  title,
  onChange,
}: {
  ad: string;
  alt: string | null;
  satista: boolean;
  site?: boolean;
  bekliyor: boolean;
  disabled: boolean;
  title?: string;
  onChange: (satista: boolean) => void;
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-5 py-2" title={title}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{ad}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {alt && <span className="text-muted">{alt}</span>}
          {!satista && <span className="font-semibold text-[var(--admin-danger-ink)]">{site ? 'Sitede satışta değil' : 'Tükendi'}</span>}
          {bekliyor && <BekliyorRozeti />}
        </span>
      </span>
      <Toggle
        checked={satista}
        disabled={disabled}
        onChange={onChange}
        className="shrink-0"
        label={
          <>
            <span className="sr-only">{joinMeta([ad, alt])}: </span>Satışta
          </>
        }
      />
    </li>
  );
}
