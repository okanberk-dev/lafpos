# Innex (Filllo) — Admin Paneli Tasarım Tarifi

> **2 Kasım 2026'dan beri:** bu tarif yalnız **yerleşim** kaynağıdır (kenar çubuğu, başlık
> şeridi, KPI şeridi, tablo, çekmece, ölçüler). Renk ve yazı LafPOS Sade'dir
> (`DESIGN.md`: Poppins, sıcak kırık beyaz, mürekkep birincil); aşağıdaki hex
> değerleri ve Inter tarihsel kayıttır.
>
> **LafPOS'ta:** yönetim paneli (`/yonetim/*`, `/raporlar`) bu tarifi 26 Ekim
> 2026'dan beri izler (operatör: _"laffogato admindeki innex admin skills
> md'yi çek, ona göre yap panel tasarımını ve biraz daha geliştir"_). Metin
> `RiosenBeq/laffogato` `docs/ADMIN-INNEX.md` @ `ab5c0ae`'den alındı.
> laffogato'nun erişilebilirlik sapmaları aynen geçerli: birincil mavi
> `#2F58F7` (tarifin `#325CFF`'i gri zeminde 4.43:1), alan kenarı `#898D94`,
> koyulaştırılmış yeşil ve turuncu rozet metni (§4), bilgi tonu camgöbeği,
> vurgu tonu mor. Değerler `src/index.css` `[data-area='admin']` içinde
> `--admin-*` adlarıyla (laffogato'yla aynı adlar), bileşenler
> `src/components/admin/`. LafPOS'un tarife ve laffogato'ya göre
> eklemeleri `DESIGN.md` "Yönetim paneli"nde: koyu tema, ⌘K komut paleti,
> daraltılabilen kenar çubuğu, sıkı görünüm, telefonda kartsız düzen ve satır
> kartları, Genel bakış'ta sistem sağlığı (§3 fikir 5).
>
> Aşağıdaki metin operatörün incelemesidir; değiştirmeden saklanır.

> **Kaynak:** Filllo – SaaS Design Agency'nin Dribbble'daki "Innex" otel yönetim paneli serisi (12 shot, 21 görsel). İnceleme tarihi: 22 Ekim 2026.
>
> **Ölçüler:** Görseller 3200×2400 px. Arayüz 1440×1024 px'lik bir çerçevede, 2x çözünürlükte çizilmiş. Aşağıdaki px değerleri 1x içindir ve ±2 px'lik tahminlerdir. Hex değerleri görsel piksellerinden örneklendi. Metin renkleri kenar yumuşatma yüzünden yaklaşıktır.
>
> **Telif:** Görseller tasarımcının telifli çalışması. Bu belge birebir kopya için değil, desen ve fikir kaynağı olsun diye yazıldı. Logo, illüstrasyon ve fotoğraflar tasarımcıya ait. Görsellerin kopyaları kaydedilmedi; bağlantılar aşağıdaki tabloda.

---

## 0. İncelenen görseller

Bağlantı biçimi: `https://dribbble.com/shots/<id>`

| No | Shot (id) | Ekran |
|---|---|---|
| innex-01 | B2B SaaS Admin Panel (27714991) | Misafir detayı, "Reservation Info" sekmesi |
| innex-02 | aynı shot | Misafir detayı, "Services" sekmesi |
| innex-03 | Data Table SaaS B2B Admin Panel (27711750) | Misafir tablosu, perspektif görünüm |
| innex-04 | aynı shot | Misafir tablosu, düz görünüm |
| innex-05 | SaaS Analytics Dashboard (27708486) | Genel bakış panosu |
| innex-06 | aynı shot | Aynı pano, yakın plan |
| innex-07 | SaaS Web App Onboarding (27706683) | Kayıt formu ve yanında canlı pano önizlemesi |
| innex-08 | B2B Admin Panel Task Table (27733750) | Kat hizmetleri görev tablosu |
| innex-09 | B2B Invoice Admin Panel (27718279) | Ödeme (checkout) paneli |
| innex-10 | aynı shot | Fatura sekmesi ve önizleme |
| innex-11 | SaaS Web App Booking (27725854) | Check-in formu (3 adım) ve özet paneli |
| innex-12 | aynı shot | "Rezervasyon bul" boş durumu |
| innex-13 | Reservation Calendar & List View (27727495) | Takvim ızgarası |
| innex-14 | aynı shot | Liste görünümü |
| innex-15 | SaaS Operations Dashboard (27730374) | Oda kartları ve sağ çekmece |
| innex-16 | B2B SaaS Finance Dashboard (27737030) | Gider yönetimi |
| innex-17 | aynı shot | Grafik ve bütçe kartları, yakın plan |
| innex-18 | SaaS Analytics Dashboard (27744586) | Raporlar (dizüstü mockup içinde) |
| innex-19 | aynı shot | Raporlar, düz görünüm |
| innex-20 | SaaS Admin Panel (27746301) | Personel listesi |
| innex-21 | aynı shot | Personel listesi, yakın plan |

---

## 1. Ortak tasarım sistemi

### 1.1 Yerleşim

- **Çerçeve:** 1440×1024.
- **Zemin:** Uygulama zemini açık gri (`#EDEFF1`). Kenar çubuğu ve içerik bu zeminin üstünde iki ayrı beyaz kart olarak durur (inset düzen).
- **Kenar çubuğu kartı:** ~248 px genişlik, tam yükseklik, köşe 12 px.
- **Boşluklar:** Kartlar arası ~12 px, pencere kenarına ~6–8 px.
- **İçerik kartı:** Kalan genişliği kaplar (~1165 px), köşe 12 px.
  - Başlık şeridi ~56 px; alt başlık varsa ~70 px. Altında 1 px ayraç.
  - Solda sayfa başlığı, sağda eylem düğmeleri: ikincil düğmeler önce, birincil en sağda.
- **İç boşluk:** İçerik kartında 20 px, kart içinde 16 px, kartlar arasında 12–16 px. Ritim 4'ün katları: 4/8/12/16/20/24.
- **Pano ızgarası:** Ana sütun ~2/3, sağ sütun ~1/3 (~300–340 px). KPI şeridi tam genişlik, 4 ya da 5 hücre.
- **Köşe yuvarlaklıkları:**
  - Kart: 12
  - İç kutu: 10
  - Düğme ve girdi: 8
  - Durum rozeti: 6
  - Filtre ve izin chip'leri: tam hap
  - Avatar: tam daire
- **Gölge:** Kartlarda neredeyse yok; ayrımı 1 px kenarlık yapıyor. Gölge yalnız seçili segmentte, sabit tablo sütununda ve kart görselli ödeme önizlemesinde kullanılmış.

### 1.2 Kenar çubuğu

- **Logo alanı:** 32 px yuvarlak logo, işletme adı (14/600), altında konum satırı (12/400, ikincil) ve bayrak emojisi.
- **Gruplar:** GUESTS / PROPERTY / FINANCE / ADMIN.
  - Etiket büyük harf, 11–12 px, 500 ağırlık, `#606264`, hafif harf aralıklı.
  - Gruplar arası ~16–20 px.
- **Öğe:** 16 px çizgi ikon ve 14/500 etiket.
  - Yükseklik ~32 px, iç boşluk 8–10 px, köşe 8.
  - Öğeler arası 0–2 px.
- **Sayaç rozeti:** Sağa yaslı küçük hap. Zemin `#F3F5F7`, 12/500, ~18–20 px yükseklik. Örnek: "Check-In 1", "Reservations 2".
- **Etkin öğe:** Zemin `#F3F5F7`, metin koyu (`#0F1123`). Renkli çizgi ya da mavi vurgu yok; bilinçli olarak sakin tutulmuş.
- **Alt kısım:**
  - "Help & Support" ve "Settings".
  - Bir ayraç.
  - Kullanıcı kartı: 28 px avatar, ad ve sağda `›`.
- **Shot'larda olmayanlar:**
  - Daraltılmış hâl. Öneri: 64–72 px'lik ikon rayı ve tooltip.
  - Kenar çubuğunda arama. Öneri: üst çubukta ⌘K komut paleti.

### 1.3 Renkler (ölçülen)

| Rol | Hex | Not |
|---|---|---|
| Zemin (uygulama) | `#EDEFF1` | Kartların arasındaki gri |
| Yüzey | `#FFFFFF` | Kartlar, kenar çubuğu, paneller |
| Yüzey – soluk | `#F9FBFC` | Tablo başlığı, iç kutular, lejant satırları |
| Yüzey – gri | `#F3F5F7` | Etkin menü, sayaçlar; segment rayı `#F5F7F9` |
| Kart kenarlığı | `#E8E8E8` | (`#E7E7E7`–`#EAEAEA`) |
| Satır ayracı | `#F2F2F2` | (`#F5F5F5`) |
| İkincil düğme kenarı | `#E3E3E3` | |
| Etkin filtre kenarı | `#12151D` | Koyu çerçeve |
| Metin – birincil | `#0C0E1B` | Koyu lacivert-siyah (`#0B0C1E`–`#121319`) |
| Metin – ikincil | `#616367` | Etiket, alt yazı, tablo başlığı (`#5F6163`–`#646466`) |
| Metin – soluk | `#9D9D9E` | Placeholder, devre dışı |
| Vurgu (birincil) | `#325CFF` | Düğme, seçili kenar, onay kutusu; bağlantı `#325EF3` |
| Vurgu – açık | `#ECF1FF` | "View ›" düğmesi; metni `#285DFD` |
| Başarı | metin `#24C16C`, zemin `#E1FAED` | Artış oku `#1DC374` |
| Dikkat / hata | metin `#DC422B`, zemin `#FEEBED` | Düşüş oku `#D8433C` |
| Uyarı | metin `#FE9D45`, zemin `#FFF2E6` | "Today" etiketi: metin `#E96E00`, zemin `#FFFBEC` |
| Bilgi | metin `#2D55F0`, zemin `#EBF7FF` | "In Progress", "Pre Booked", "Yesterday" |
| Mor (yardımcı vurgu) | `#794FFD`, zemin `#F6F1FF` | İkon kutuları |
| İkon kutusu tonları | `#EEFBF2`, `#F1FCFF`, `#EFF1FE`, `#F6F1FF` | Yeşil, camgöbeği, çivit, mor |
| Grafik çizgisi | `#2132BA` | Dolgu `#DDE1FF` → `#E6EAFF` |
| Vurgulu grafik sütunu | `#2C41FE` → `#DABBFC` | Dikey gradyan |
| Tooltip | `#181D34` | Beyaz metin |
| Doluluk çubuğu | `#E94335` / `#FFA047` / `#325CFF` | Dolu / bakım / boş |
| Kaynak chip'leri | Booking `#DFEBFF`, Airbnb `#FFE4E6`, Expedia `#FEFADC`, Direkt `#F4F6F8` | |

Dribbble'ın her shot için çıkardığı otomatik paletler de var (örneğin `#F5F5F7`, `#9D9D9E`, `#121319`, `#505356`, `#1A2BED`). Bunlar gradyan arka planı ve avatar tonlarını da içerdiği için arayüz renkleri olarak yukarıdaki ölçümler daha güvenilir.

### 1.4 Yazı

- **Aile:** Inter benzeri bir neo-grotesk (Inter ya da SF Pro). Tablolardaki rakamlar için `font-variant-numeric: tabular-nums` önerilir.
- **Ölçek (1x, boyut/ağırlık):**
  - Sayfa başlığı 18/600
  - Kart başlığı 15–16/600; alt başlık 12/400, ikincil renk
  - KPI değeri 24–28/700; detaydaki büyük tutar 24/700
  - Gövde ve tablo hücresi 14/400–500; tablo başlığı 13/500, ikincil renk
  - Yardımcı metin 12/400; büyük harf etiket 11–12/500
  - Chip ve rozet 12/500
  - Onboarding'deki H1 24/500
- **Ağırlıklar:** 400 / 500 / 600; rakamlarda 700.

### 1.5 Bileşenler

#### Düğmeler

Ortak ölçüler: yükseklik ~32 px, köşe 8, 14/500, ikon 16 px.

- **Birincil:** Zemin `#325CFF`, beyaz metin, genellikle başta `+` ("+ New Check-In", "+ Add Expense"). Formlarda tam genişlik ve hafif mavi gölge ("Sign Up ›").
- **İkincil:** Beyaz zemin, 1 px `#E3E3E3` kenar, koyu metin ve ikon ("Export CSV ⤓", "Sync ⟳", "Report Issue").
- **Açık tonlu:** Zemin `#ECF1FF`, metin `#285DFD`, sonda `›` ("View ›", "Change room").
- **Birincil çerçeveli:** Beyaz zemin, 1 px mavi kenar, mavi metin ("Assign").
- **Metin/hayalet:** "⊗ Cancel Request", "See all ›", altı çizili "Add Services" ve "Download".
- **İkon düğmesi:** 28–32 px kare, çerçeveli (arama, ⋮, karusel okları).

#### Girdiler

- Yükseklik ~40–44, 1 px açık kenar, köşe 8.
- Solda arama ikonu, placeholder `#9D9D9E`.
- Şifre alanında göz ikonu. Altında yeşil tikli kural metni (12 px).
- Telefon alanında bayraklı ülke kodu seçici.
- Zorunlu alanlarda kırmızı `*`.

#### Filtre çubuğu

- **Kutucuk chip'ler** (köşe 8): ikon, etiket ve gri sayaç rozeti ("In-House 4"). Etkin chip koyu kenarlı ve kalın.
- **Hap chip'ler:** Renkli nokta ve etiket (departman, oda tipi). Etkin "All" koyu kenarlı.
- **Sağ taraf:** Arama ikon düğmesi (ya da arama kutusu), "Filter" düğmesi, arada dikey ayraç.
- **Dönem seçici:** "Week ▾", ardından çerçeveli hap içinde "‹ 01 May – 07 May, 2026 ›".
- **Görünüm anahtarı:** Izgara ve liste ikonları; gri ray üzerinde etkin olan beyaz kutu.

#### Sekmeler

- **Alt çizgili sekmeler:** İkon, etiket ve isteğe bağlı sayaç rozeti. Etkin sekme koyu metin ve 2 px koyu alt çizgi; edilgen sekme `#636566`.
- **Kart sekmeler (raporlar):** İkon dairesi, başlık, açıklama ve altta özet sayı ("Total arrivals: 273"). Etkin olanın zemini açık mavi, başlığı mavi, alt çizgisi 2 px mavi. Fikir: Kullanıcı tıklamadan önce cevabı görüyor.
- **Segment kontrol:** Gri ray (`#F5F7F9`); etkin seçenek beyaz hap ve hafif gölge (Card / Cash / Apple Pay).

#### KPI şeridi

- Tek kart, 4–5 hücre, dikey ayraçlar, yükseklik ~95–115 px.
- Her hücre, yukarıdan aşağı:
  - 24–28 px açık tonlu ikon kutusu (köşe 6–8) ve 13–14/500 etiket.
  - 24/700 değer ve yanında değişim göstergesi (▲/▼, 12/500, yeşil ya da kırmızı).
  - 12 px ikincil açıklama ("Previous day: 90", "71% of total staff").
- **İlke:** Hiçbir sayı tek başına durmaz; yanında hep bir referans vardır (dün, geçen ay, bütçe).

#### Tablo

- **Konteyner:** Bir kartın içinde.
- **Başlık satırı:** Zemin `#F9FBFC`, üst köşeler yuvarlak, metin 13/500 ikincil, yükseklik ~40.
- **Satırlar:**
  - Yükseklik: ad ve alt yazıdan oluşan satırlarda **56 px**; ikonlu iki satırlık satırlarda **72 px**.
  - Ayraç `#F2F2F2`, zemin beyaz.
- **Sütunlar (soldan sağa):**
  - Seçim kutusu (16 px, açık gri kenar)
  - Avatar 24 px, ad 14/500, telefon 12 ikincil
  - E-posta ve kopyalama ikonu
  - Kod / tarih
  - Tutar (sağa yaslı)
  - Kaynak chip'i (marka mini ikonu ve açık zemin)
  - Durum rozeti
  - Eylem
- **Durum rozeti:** Açık zemin üzerinde renkli metin, köşe 6, ~22 px, 12/500.
  - Checked Out: yeşil
  - Checked In: kırmızı
  - Pre Booked / In Progress: mavi
  - Waiting / Canceled: turuncu
  - Not Approved ve "7 hours ago": gri
- **Eylem sütunu, iki yaklaşım:**
  - (a) Son sütun sabit (yapışkan), solunda ince gölge, içinde `⋮` menüsü.
  - (b) Düğme satırın durumuna göre değişir: Done → dolu "Approve", Waiting → çerçeveli "Assign", In Progress → açık tonlu "View ›".
- **Grup satırları:** "Invited / Guest / Member" gibi gri bant başlıkları. Davet bekleyen satırlarda ad soluk, eylem "⊗ Cancel Request".
- **İzin chip'leri:** Çerçeveli hap ("All Access", "Expenses", "Reports", "+2").
- **Sayfalama:**
  - Solda "Page [01 ▾] out of 18".
  - Sağda gri ray üzerinde "‹ 1 2 … 20 ›"; etkin sayfa beyaz kutu, devre dışı ok soluk.

#### Kart

- Beyaz zemin, 1 px kenar, köşe 12, iç boşluk 16.
- Başlık satırında solda başlık ve alt başlık; sağda açılır seçici ("Semi annually ▾", "Monthly Activity ▾") ve çerçeveli `⋮`.

#### Lejant ve istatistik satırları

- Açık gri zeminli satırlar.
- Renkli dikey çentik, etiket ve parantez içinde gri sayı.
- Sağda değişim ("▲ +5% vs last month").

#### Grafikler

- **Basamaklı alan grafiği:**
  - 2 px koyu mavi üst çizgi ve açık lavanta dolgu.
  - Seçili dönem mavi→lila gradyanlı dolu sütun olarak çizilir. Üstünde koyu tooltip: renk kutusu, "Total Revenue" ve değer.
  - Kesikli yatay ızgara, eksen etiketleri 12 px gri.
- **Gruplu sütun:** Gerçekleşen değer yeşil gradyanlı ve üstü yuvarlak; hemen yanında bütçe açık nane renginde ve çapraz taralı.
- **Hap sütunlar:** Gri sütunlar arasında tek bir vurgulu turuncu gradyan sütun; altta kanal ikonları.
- **Yatay dağılım çubuğu:** Bölünmüş çubuk (48% / 35% / 17%), üstünde etiketler.
- **İlerleme çubukları:** ~6 px, yuvarlak, gradyan dolgulu; üstünde "$38k / $45k". Sütunlar kesikli dikey çizgilerle ayrılmış, karusel oklarıyla kayıyor.
- **Doluluk çubuğu:** Tek çubukta kırmızı / turuncu / mavi bölümler; altında lejant satırları.

#### Zaman çizelgesi (log)

- Solda kesikli dikey çizgi.
- Olay türüne göre açık tonlu ikon dairesi (~28 px).
- Kalın başlık ve gri açıklama; sağda saat ("10:00, 22 Apr 2026"); altında durum satırı.
- İsteğe bağlı açık renkli not balonu (köşe 10).

#### Etkinlik akışı

- "Today / Yesterday / Last Week / Last Month" renkli etiketli, katlanabilir gruplar (yuvarlak chevron).
- Avatar yığını ve özet ("3 Checkouts today!").
- İç içe çerçeveli kartlar, solda ağaç bağlantı çizgisi.

#### Boş durum

Ortada bir kart, içinde sırayla:
- Mavi gradyan üzerinde illüstrasyon
- Başlık (16/600) ve açıklama
- Arama kutusu
- "OR" ayracı
- Tam genişlik birincil düğme ("Continue manually ›")
- Yardımcı metin

#### Detay görünümleri

- **(a) Üç bölgeli panel** (innex-01, 02, 09, 10): Liste arkada, gri örtü altında kalır (~%15–20 karartma).
  - Sol sütun ~370 px ve **sabit**: büyük ödenecek tutar, durum, iletişim bilgileri, belgeler.
  - Sağ sütun ~755 px: **yalnız burada** sekmeler var (Reservation / Services / Invoice).
  - Sağ altta yapışkan alt çubuk. Birincil eylem ("Proceed to Check-Out ›") her sekmede aynı köşede durur.
- **(b) Sağ çekmece** (innex-15, ~420 px):
  - Kapat düğmesi; fotoğraf; kod, tip ve durum rozeti; "Occupied by" ve avatar.
  - Olanak chip'leri ve "Show all 8 amenities".
  - ACTIONS listesi: gri kap içinde beyaz satırlar. Her satırda renkli dolu ikon kutusu, başlık, açıklama ve `›`.
  - RECENT ACTIVITY listesi.
  - Altta sağda birincil düğme.

#### Form ve adım göstergesi (innex-11)

- **Adım göstergesi:** 3 adım; numaralı daire ve etiket, etkin adım açık mavi hap içinde, adımlar arasında `›`.
- **Form:** İki sütunlu alan ızgarası.
- **Takvim:** Çift ay. Aralığın uçları dolu mavi kare, ara günler açık mavi. Altta "Clear dates" ve "Apply".
- **Sağdaki özet paneli:**
  - Daha 1. adımda yerinde duruyor; değerler "–" ve "000 USD".
  - Seçim yapıldıkça doluyor.
  - En altta açık mavi "Total Amount" kutusu.

#### Ödeme (innex-09)

- Segment kontrolle ödeme yöntemi seçimi ve kart önizlemesi.
- Anahtar-değer özeti: etiket solda gri, değer sağda koyu.
- Fiyat dökümü: "Advance −$600" yeşil; ardından ayraç ve kalın "Due".

#### Fatura önizleme (innex-10)

- Belge kartı: büyük "Invoice" başlığı ve fatura no; sağ üstte logo.
- Büyük harf etiketli iki sütunlu bilgi alanı.
- Gri başlık satırlı kalem tablosu; "IN STAY SERVICES" grup başlığı.
- Sağa yaslı ara toplam / vergi / avans / ödenecek satırları.
- Altta ortalanmış teşekkür satırı. Üstte "Export PDF" düğmesi.

#### Kişi kartı (innex-01)

- 48 px avatar, ad (18/600) ve kimlik no.
- "Current status:" ve durum rozeti.
- "PAYABLE AMOUNT" kutusu (zemin `#F9FBFC`): 24/700 tutar, altında "Total" ve "Paid" chip'leri.
- Sekmeli iletişim kartı: büyük harf etiket ve değer; telefon ve e-posta mavi bağlantı.
- Belge kartları: PDF rozeti, dosya adı, boyutu ve "Download".

### 1.6 Görsellerde görünen durumlar

- **Seçili:**
  - Menüde gri zemin
  - Oda kartında 2 px mavi kenar
  - Segmentte beyaz hap
  - Sekmede alt çizgi
  - Grafikte vurgulu sütun ve tooltip
  - Takvimde aralık seçimi
- **Karartma:** Detay paneli açıkken liste ve kenar çubuğu gri örtü altında.
- **Devre dışı:** Sayfalamadaki soluk `‹`.
- **Hover:** Gösterilmemiş. Öneri: satır zemini `#F9FBFC`, düğmelerde %6–8 koyulaşma.
- **Açık açılır menü:** Gösterilmemiş; yalnız kapalı tetikleyiciler var ("Today ▾", "Week ▾", "Export as ▾"). Öneri: beyaz popover, köşe 10, hafif gölge, 32 px'lik öğeler.

---

## 2. Görsel bazında notlar

- **innex-01 – Misafir detayı, Rezervasyon sekmesi:**
  - Bu, üç bölgeli detay düzeninin örneği; ilkesi "kararı belirleyen sayı sekmenin içinde yaşayamaz".
  - Rezervasyon kartının içinde sağda "Change room" açık tonlu düğmesi var.
  - Oda ücreti bir denklem gibi dizilmiş: "Room rate $300 × Nights 2 = Sub total $600 | Advanced paid $600 | Due $00".
  - Altında "Payment History & Log" zaman çizelgesi.
- **innex-02 – Hizmetler sekmesi:**
  - Üstte 3 hücreli istatistik şeridi: Total Charges, Pending, Most Recent (son hücrede ikon dairesi).
  - "In Stay Services" tablosu 72 px satırlı: ikon dairesi, ad, durum, Rate, Quantity, Total Price ve çöp kutusu.
  - Tablonun altında "+ Add Services" bağlantısı.
- **innex-03/04 – Misafir tablosu:**
  - Başlık ve alt başlık; sağda "Export CSV" ve "+ New Check-In".
  - Filtre chip'leri sayaçlı: All Guests / In-House 4 / Checked-Out 6 / Pre-Booking 3.
  - Durum renkleri dikkat çekmek için: kırmızı "şimdi senin işin", yeşil "bitti, geç".
  - Eylem sütunu yapışkan ve `⋮`; altta sayfalama.
- **innex-05/06 – Genel bakış panosu:**
  - Üstte 4 KPI, her biri "Previous day" referanslı.
  - Sağ üstte "130 Total Room" doluluk çubuğu ve lejant.
  - Basamaklı gelir grafiği (Revenue/Expenses sekmeleri).
  - Kompakt "Guest Overview" tablosu (arama ve "View All").
  - Sağda gruplu etkinlik akışı.
- **innex-07 – Kayıt ekranı:**
  - Kart ikiye bölünmüş: solda form, sağda canlı pano önizlemesi.
  - Formda Google/Microsoft ile giriş, "OR" ayracı, e-posta, şifre (kural ipucuyla), sözleşme onay kutusu, tam genişlik "Sign Up" ve "Log in" bağlantısı.
  - İlke: Ödül, istenen bilginin yanında gösteriliyor.
- **innex-08 – Görev tablosu:**
  - Üstte 4 KPI (Total / In Progress / Completed / Urgent) ve "Task List / Worker Assignments / History" sekmeleri.
  - Satırda baş harf rozetli atanan kişi ya da gri "Not assigned".
  - Eylem düğmesi satırın durumuna göre değişiyor; menü kullanılmıyor.
- **innex-09 – Ödeme:**
  - Başlık "Guest Checkout" ve açıklama.
  - Solda ödeme yöntemi ve kart bilgileri, sağda özet ve fiyat dökümü.
  - Tek kahraman sayı ödenecek tutar; toplam ve ödenen küçük chip'lerde.
- **innex-10 – Fatura önizleme:** "Preview" etiketi ve "Export PDF"; belge kartı; "Proceed to Check-Out" aynı yerde kalıyor.
- **innex-11 – Check-in formu:** 3 adım, iki sütunlu form, çift aylık takvim. Sağdaki özet daha 1. adımda yerini alıyor.
- **innex-12 – Boş durum:** "Find Reservation": illüstrasyon, arama kutusu, OR ve "Continue manually ›".
- **innex-13/14 – Takvim ve liste:**
  - Aynı ekran, iki görünüm; sekmeler, tarih aralığı, arama ve filtre ortak durumda kalıyor.
  - Izgarada odalar sütun, günler satır. Rezervasyon blokları duruma göre renkli: açık zemin ve 2 px sol kenar. "Not Available" sütunu sarı, "Maintenance" gri.
  - Oda tipleri katlanabilir bölümler; renkli nokta ve "Total rooms: 16" chip'i.
- **innex-15 – Oda kartları:**
  - Sekmelerde sayaç var: Available 22 / Occupied 34 / Maintenance 16.
  - Renkli noktalı tip filtresi.
  - Kat bölümleri ("1st Floor" ve "Total rooms" chip'i). Kartlar 4'lü ızgarada.
  - Kart içeriği: tip ikon kutusu, durum rozeti, kod, tip, temizlik durumu (Clean/Dirty), olanak ikonları ve "$1000/Night".
  - **İki bağımsız durum** (satış ve temizlik) aynı kartta birbirini ezmeden duruyor.
- **innex-16/17 – Gider yönetimi:**
  - 5 KPI.
  - "Spend vs Budget": her harcama sütunu bütçe sütununun yanında.
  - "Approval Activity" listesi.
  - "Top Vendors": ödeme türü dağılımı ve sıralı liste.
  - "Department Budget Tracker": % değer, "harcanan / bütçe" ve ilerleme çubuğu.
  - "Expense Register" tablosu.
- **innex-18/19 – Raporlar:**
  - Üstte 5 KPI.
  - "Select Report" kart sekmeleri cevabı sekmenin üzerinde gösteriyor (Total arrivals: 273 …).
  - Rapor kartında 2×2 metrik ızgarası, kanal sütunları ve günlük alan grafiği.
- **innex-20/21 – Personel:**
  - 4 KPI ve renkli noktalı departman filtresi.
  - Rol sütunu yerine **izinler satırda**.
  - Davetliler en üstte ve tek eylemleri "Cancel Request".
  - Durum "Active Now" ya da "7 hours ago".

---

## 3. Kafe yönetim paneline uyarlarken öne çıkan 10 fikir

1. **Kenar çubuğunu gruplara ayır.** Panelde ~25 menü öğesi var. Innex gibi büyük harfli gruplar önerisi:
   - SATIŞ: Siparişler, İadeler, Faturalar, Promosyon
   - KAFE: Kasa · damga, Masalar · QR, Canlı durum, Karaoke
   - KATALOG: Ürünler, Menü, Kategoriler, Stok
   - İÇERİK: Mağaza Hero, Hikaye, Basın, Site metinleri, Mobil uygulama
   - MÜŞTERİ: Müşteriler, Bülten
   - YÖNETİM: Raporlar, Olay kaydı, Kullanıcılar, Yasal belgeler, Ayarlar

   Sayaç rozetleri yalnız iş bekleyen yerlerde olsun ("Siparişler 2", "Faturalar 1").
2. **Sipariş detayını üç bölgeye böl.**
   - Sol sütun sabit: ödenecek ya da iade edilecek tutar, durum rozeti, müşteri, belgeler (fatura PDF).
   - Sağda sekmeler: Kalemler / Ödeme & İade / Fatura / Zaman çizelgesi.
   - Sağ altta, her sekmede aynı yerde tek birincil eylem ("Kargoya ver", "Faturayı kesinleştir").
3. **Renk durumu değil dikkati göstersin.** Kırmızı "şu an senin işin" (iade bekliyor, fatura son gün), yeşil "bitti". Mevcut "Dikkat" filtresi ve rozetleriyle birebir uyumlu.
4. **Eylem düğmesi satırın durumuna göre değişsin.**
   - Siparişte: Ödendi → dolu "Hazırla", Hazır → çerçeveli "Kargoya ver", Tamamlandı → açık "Gör ›".
   - Faturada: Taslak → "Kesinleştir", Kesildi → "PDF".
5. **Her sayının yanında referans olsun.** Örnekler: "Bugünkü sipariş 12 ▲3 · dün 9", "Bugün verilen damga 48 · geçen hafta aynı gün 41", "Karaoke doluluğu %70 · geçen cuma %55". Genel bakışa bir de "Sistem sağlığı" kartı eklenebilir (Neon CU-saat, Vercel kotası, son fatura çalıştırması).
6. **Cevabı sekmenin üzerine yaz.** Raporlar'da "Gelir ₺… / Gider ₺… / Online sipariş … / Damga …" sayılı kart sekmeleri. Faturalar'daki "Dikkat 0 · Bekleyen 0 · Kesilen 2" bunun küçük bir hali, aynı dil yaygınlaştırılabilir.
7. **Takvim ve liste görünümü tek ekranda.** Karaoke ve masa rezervasyonları için: ızgarada odalar ya da masalar × saat dilimleri, listede rezervasyonlar. Filtre durumu iki görünüm arasında korunsun.
8. **Ürün ve menü kalemleri için sağ çekmece.** Fotoğraf, "Satışta/Tükendi" durumu, alerjen chip'leri ("Show all 8" gibi), eylem listesi (Stok güncelle, Fiyat değiştir, Menüden kaldır) ve son hareketler. Oda kartlarındaki çift durum, ürün kartına "Satış durumu" ve "Stok durumu" olarak uyarlanabilir.
9. **Kullanıcılar'da izinler satırda görünsün.** "Kasa · damga, Siparişler, Faturalar" chip'leri; davet bekleyenler üstte ve "Daveti iptal et"; "Şu an aktif / 3 saat önce"; 2FA durumu ayrı bir rozet.
10. **Bütçe ve gerçekleşen yan yana.** Stok ve giderlerde "harcanan / hedef" ilerleme çubukları, kategori bazında (kahve çekirdeği, süt, ambalaj…). Ödeme ve iade ekranlarında tek kahraman sayı ("İade edilecek ₺369" büyük, toplam ve ödenen küçük chip'lerde).

Ek fikir: Kurulum adımlarına "Sonra ayarla" atlama seçenekleri, boş durumlara da arama, OR ve "elle devam et" kalıbı.

---

## 4. Uyarlama notları

- **Kontrast:** Açık zemin üstündeki yeşil (`#24C16C`/`#E1FAED`) ve turuncu (`#FE9D45`/`#FFF2E6`) rozet metinlerinin kontrastı ≈2:1, okunabilirlik için düşük. Kendi temanda bu metinleri koyulaştır (örneğin yeşil `#15803D`, turuncu `#B45309`); zeminler aynı kalabilir.
- **Yoğunluk:** 56–72 px satırlar ferah duruyor. Kasada ya da küçük ekranda 44–48 px daha verimli olabilir. Yoğunluğu bir ayar olarak düşün.
- **Mobil:** Shot'ların hepsi masaüstü. Mevcut panelin telefondaki alt sekme çubuğu (Genel bakış / Siparişler / Karaoke / Kasa / Tümü) korunmalı; kenar çubuğu yalnız geniş ekranda görünsün.
- **Marka:** Mavi vurgu (`#325CFF`) yerine L'Affogato'nun kendi vurgu rengi kullanılabilir. Sistemin geri kalanı (gri zemin, beyaz kartlar, 1 px kenarlık, açık tonlu durum rozetleri) markadan bağımsız işler.
