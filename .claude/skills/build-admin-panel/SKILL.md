---
name: build-admin-panel
description: Research, scope, build and verify a new AsilPOS admin area (a new section under /yonetim, a new entity, a report or dashboard view) end to end, in the AsilPOS Pano look (finance-dashboard metrics in L'Affogato green: brand rail, floating white cards, Inter). Use when the user asks to add or redesign a management screen, "yönetime X ekle", "yönetim paneli", "panelde şunu yönet", "arka ofis", or asks what the panel should manage.
---

# Yönetim paneline bir alan eklemek: oku, kapsamı sor, kur, gerçekten doğrula

> **Kaynak:** `RiosenBeq/laffogato` `.claude/skills/build-admin-panel` @ `ab5c0ae` (operatörün kendi skill'i),
> AsilPOS'a uyarlandı (26 Eki 2026). Oradaki yöntem de
> [Owais232/Admin-Panel-Skill-LLM-Models](https://github.com/Owais232/Admin-Panel-Skill-LLM-Models)'in altı
> aşamasından yeniden yazılmıştı. Next.js, server action ve Postgres varsayımları burada geçerli değil:
> AsilPOS yerel bir Hono sunucusu, SQLite (Drizzle) ve React SPA'dır.

Görünümün kaynağı `DESIGN.md` (**AsilPOS Pano**, 20 Kasım 2026: finans panosunun ölçüleri L'Affogato kimliğinde; Inter,
tek açık gri zemin, zeminde yüzen beyaz kartlar (köşe 24), solda ev yeşilinin degradesinde marka rayı, ev yeşili ana eylem
ve açık nane ok halkası, durum kobalt mavisi, zamanı daralan ahududu; yönetimde solda beyaz alt menü kartı) ve tablo, KPI
şeridi ve çekmece ölçüleri için **Innex** tarifi (`docs/ADMIN-INNEX.md`). Renk ve yazı için tarifin hex değerleri değil `src/index.css`'teki
`--admin-*` değerleri geçerlidir. Yeni bir desen icat etmeden önce kite bak: `src/components/admin/`
(`AdminShell`, `PageHeader`, `Card`, `KpiStrip`, `StatusTabs`, `Segmented`, `DataTable`, `ActionMenu`,
`QuickLook`, `Timeline`, `Badge`, `CommandPalette`). Kütüphane sınırı: React, Tailwind, `lucide-react`;
Radix, shadcn, cmdk yok.

## Aşama 1: Önce oku, sonra sor

Kod yazmadan önce neyin yönetileceğini koddan öğren:

1. **Veri.** Tablo ve kolonlar `server/db/schema.ts`; zorunlu alanlar, sistemin yazdıkları (sayaç, durum,
   zaman), benzersizlik. Para kuruş tam sayı, tarih iş günü kuralıyla (`shared/time.ts`, 05:00).
2. **Yetki.** `shared/permissions.ts`: hangi izin okur, hangisi yazar. Sunucu her uçta
   `requirePermission` / `need` çağırır; istemcideki gizleme yalnız kolaylıktır (AGENTS.md kural 3).
   Maliyet ve kâr yalnız `rapor.maliyet` ile görünür (KVKK).
3. **İş kuralı nerede?** `server/services/*` içindeyse onu çağır, kopyalama. Hesap `shared/order-calc.ts`
   ve `shared/money.ts`'tedir.
4. **Dışarıya etkisi.** Değişen alan laffogato'ya (menü eşitleme, tükendi, online sipariş) ya da
   lafmaliyet'e (gün sonu, satış listesi, maliyet) gidiyor mu? Sözleşme `docs/03-ENTEGRASYON.md`; siteden
   gelen alanlar (ad, fiyat, boy, KDV) AsilPOS'ta değiştirilmez.
5. **Denetim ve canlılık.** Hassas işlem `Effects.audit` ile denetim kaydına yazılır, yazma bitince
   `bus.publish` ile ekranlara olay gider (AGENTS.md kural 4-5).

## Aşama 2: Kapsamı kullanıcıya sor (varsayma)

Okuduktan sonra, kod yazmadan, şu kararları `AskUserQuestion` ile tek seferde sor:

- **Sunucu değişikliği kapsamda mı?** Yeni kolon gerekiyorsa göç `npm run db:generate` ile üretilir
  (AGENTS.md kural 9). Kullanıcı yalnız görünüm istiyorsa mevcut uçlarla ne yapılabildiğini söyle.
- **Hangi roller görecek, hangileri yazabilecek?** (patron, müdür, kasiyer, garson, mutfak, kurye)
- **Hepsi mi, önce çekirdek mi?** Varsayılan öneri: liste, hızlı bakış ve **bir** yazım; sonra gerisi.
- **Siteye ya da lafmaliyet'e yansıyacak mı?** Yansıyacaksa sözleşme belgesi aynı PR'da güncellenir.

## Aşama 3: Plan

Sıra: (0) gerekiyorsa şema ve göç, (1) servis ve Zod şeması, (2) uç (`server/routes/admin.ts` ya da
alanın kendi dosyası), (3) liste + hızlı bakış + bir yazım, uçtan uca doğrulanmış, (4) kalan yazımlar,
(5) gezinme: `src/pages/admin/AdminPage.tsx` `SECTIONS` (kenar çubuğu grubu, telefon listesi) ve komut
paleti (`CommandPalette` aynı listeyi okur).

## Aşama 4: Kur, her adımda doğrula

- Her adımdan sonra `npm run typecheck` ve ilgili test (`tests/api-flow.test.ts` sunucu akışları için).
- Liste sayfası yönetim sahnesinin yaprağındadır (görünümü AsilPOS Sahne): sayfa başlığı şeridi (başlık, açıklama, sağda ikincil sonra birincil
  düğme), varsa KPI şeridi (her rakamın yanında referans), durum sekmeleri (sayılı), tek satır araç
  çubuğu, kart içinde tablo, satıra tıklayınca sağdan hızlı bakış.
- Telefon: kart yok, tablo satır kartına döner, çekmece alt sayfa olur, her hedef en az 44 px
  (`impeccable` skill'i `adapt`).

## Aşama 5: Gerçekten doğrula ("derleniyor" yetmez)

1. `npm run build && npm run e2e`: tarama her rolü, her ekranı telefon (390), tablet (768) ve bilgisayar
   (1280) boyutunda açar; konsol ve ağ hatası, yatay taşma, küçük hedef arar. Yeni ekranı `e2e/run.mjs`
   `ROUTES`'a ekle.
2. **Bir yazım, arayüzden.** Yalnız açılması yetmez: en az bir kaydı arayüzden oluştur ya da değiştir
   (`e2e/flows.mjs`'e bir akış), bildirimi ve sonucu gör, denetim kaydına düştüğünü kontrol et.
3. **Gözle bak.** `e2e/out/` görüntülerini aç: üst üste binme, kırpılan metin, boş durum. Düzen hatası
   testle değil gözle yakalanır.

## Aşama 6: Yayın

- Dal `claude/<konu>`, PR başlığı Türkçe; kapılar: `npm run typecheck`, `npm test`, `npm run build`,
  `npm run e2e` (CI de aynısını çalıştırır).
- **Kod yayını veri yaratmaz.** Yeni alan bir ayar, personel ya da ortam değişkeni istiyorsa bunu
  kullanıcıya ayrı bir adım olarak söyle.
