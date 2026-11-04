# Plan: mimari, veri modeli ve dalgalar

## 1. Mimari kararlar

| Karar | Seçim | Neden |
| --- | --- | --- |
| Çalışma biçimi | Kafedeki bir bilgisayarda yerel sunucu; cihazlar Wi-Fi'dan tarayıcıyla bağlanır | İnternet kesilince satış durmamalı (robotPOS'un hibrit yapısının karşılığı). Neon kotasına yük bindirmez |
| Sunucu | Node.js 22+, Hono, `tsx` ile TypeScript | Hafif, hızlı, tek süreç; Next.js'in bulut odaklı yapısı yerel POS'a gereksiz |
| Veritabanı | SQLite (WAL) + Drizzle ORM 0.45 | Kurulumsuz, tek dosya, günlük yedeği kopyalamak yeter; Drizzle ve Zod sürümleri lafmaliyet ile aynı |
| Arayüz | React 19 + Vite 6 + Tailwind 4, tek sayfa uygulama | Dokunmatik, hızlı; tablet ana ekrana eklenebilir |
| Gerçek zamanlı | Sunucu olayları (SSE, `fetch` akışıyla, başlıkta oturum) | WebSocket kütüphanesi gerektirmez, kopunca kendini yeniden bağlar; jeton adres satırına düşmez |
| Para | Kuruş tam sayı; ortak hesap çekirdeği (`shared/order-calc.ts`) hem sunucuda hem istemcide | Tek doğruluk kaynağı; indirim kalemlere en büyük kalan yöntemiyle dağıtılır, kuruş kaybolmaz |
| Kimlik | PIN (sunucu anahtarlı HMAC), süreli oturum, deneme sınırı | Kafede hızlı kullanıcı değişimi; veritabanı dosyası tek başına sızarsa PIN çözülemez |
| Kayıt kimlikleri | ULID (zamana göre sıralı) | Buluta senkronda çakışmaz |
| Node sürümü | 22.11 ile çalışacak paket sürümleri (Vite 6, React Router 7, Vitest 4) | Makinede Node 22.11 var; sistem Node'una dokunulmadı. Üretimde Node 24 LTS önerilir |

## 2. Klasör yapısı

```
lafpos/
  shared/        para, adisyon hesabı, yetkiler, olay tipleri (sunucu + istemci ortak)
  server/
    db/          şema, bağlantı, göç (migration), örnek veri
    lib/         kimlik, olay yayını, denetim, hata, imza (HMAC)
    services/    iş kuralları: adisyon, ödeme, kasa/Z, rapor, karaoke
    routes/      HTTP uçları (modül başına bir dosya)
    sync/        laffogato menü + online sipariş, lafmaliyet dışa aktarım + giden kutusu
    print/       ESC/POS üretici, ağ yazıcısı
  src/           React arayüzü (sayfalar modül başına)
  drizzle/       üretilen SQL göçleri
  tests/         birim ve uç testleri
  docs/          prompt, analiz, plan, entegrasyon sözleşmesi
  data/          (git dışında) veritabanı, gizli anahtar, yedekler
```

## 3. Veri modeli (özet)

| Tablo | Amaç | Not |
| --- | --- | --- |
| `settings` | anahtar → JSON ayar | işletme adı, fiş metinleri, servis oranı, otomatik kilit, senkron ayarları, servis modu (`serviceMode`) |
| `users`, `sessions` | personel, PIN, rol, kişi bazlı yetki; oturumlar | PIN `HMAC(secret, pin)` olarak tekil |
| `time_entries` | eski personel mesaisi (giriş-çıkış) | mesai 4 Kasım 2026'da kaldırıldı: tablo ve kayıtları durur, hiçbir kod okumaz ya da yazmaz (göç 0014; silinmedi, `db:generate` göç üretmez) |
| `sections`, `tables` | masa planı | `kind: masa | oda` (karaoke), `siteTableCode` (site QR masası eşlemesi), saatlik ücret |
| `stations`, `printers` | bar/mutfak yönlendirme, yazıcılar | ağ yazıcısı (IP:9100) ya da tarayıcı |
| `categories`, `products` | menü | `price` (M/tek), `priceL` (L), `kdvRate`, `extSource/extId` (`laffogato`/`mnu-0011`), POS'a özel alanlar, porsiyon sayacı, `isService` |
| `option_groups`, `option_items`, `product_option_groups` | süt, kavrum, şurup, ekstra shot, şeker | site kodlarıyla (`oat`, `vanilla`…); seçeneğin kasadaki Tükendi'si (`soldOut`, göç 0013; yalnız LafPOS'ta, `docs/03-ENTEGRASYON.md` §2.3) |
| `happy_hours` | saat/gün/kategori indirim kuralı | |
| `payment_methods` | nakit, kart, yemek kartları, havale, cari | `zField` → lafmaliyet Z alanı (`cash`, `card`, `meal_card`, `online`, `other`), `channel` → komisyon kanalı (`pluxee`…) |
| `business_days` | iş günü (05:00 kuralı), açılış/sayım, Z özeti | `zNo`, `lastOrderNo` |
| `orders`, `order_items`, `payments` | adisyon, kalem, ödeme | kalemde KDV, boy, seçenekler, iptal/ikram/indirim bilgisi (iptal anında bara gitmiş miydi, hesabı yazdırılmış mıydı: `voidAfterSend`, `voidAfterBill`, göç 0015), istasyon durumu, ödenen adet; online sipariş alanları (`extId`, `extPaid`); ödemede istemcinin deneme kimliği (`request_id`, adisyon başına tekil: yanıtı kaybolup yeniden gelen aynı istek ikinci kez yazılmaz, ilk sonuç döner; aynı kimlikle başka tür, tutar, pay ya da kalem gelirse ya da o ödeme iptal edildiyse 409 `request_reused` / `request_refunded`, göç 0004; açık hesap tahsilatı da kimlik gönderir ve bakiyeden fazlası tahsil edilmez: 409 `over_balance`); yarı self serviste masa no / numaratör (`numarator`, göç 0005) |
| `cash_movements` | harcama, teslim, giriş | lafmaliyet `cash_outs` türleriyle uyumlu |
| `shift_counts` | vardiya kasa sayımı (gün içinde kasiyer değişirken) | sayılan, o anki beklenen nakit ve fark, banknotlar, devralan ve PIN onayı; kasa hareketi değil, Z'yi değiştirmez, lafmaliyet'e gitmez (göç 0014) |
| `room_sessions` | karaoke odası sayacı | `bookingId`, `booking`, `prepaidMinutes`: sitedeki rezervasyona bağlı sayaç (`docs/03-ENTEGRASYON.md` §2.4) |
| `customers`, `customer_addresses`, `customer_ledger` | müşteri, adres, açık hesap | damga kartı sayacı |
| `reservations` | rezervasyon | |
| `audit_log` | denetim ve patron uyarıları | `severity: info | uyari | alarm` |
| `outbox`, `sync_state` | giden kutusu, senkron durumu (ETag, son çekim) | |

## 4. Dalgalar ve görevler

Her dalga: kod + birim testleri + tip denetimi + tarayıcıda deneme + GitHub'a push (dal ve PR).

### Dalga 0: plan ve iskelet

- [x] Ortam (Node 22.11 uyumu), repo, paketler
- [x] Para ve adisyon hesap çekirdeği, testleri
- [x] Geliştirilmiş prompt, analiz, plan, entegrasyon sözleşmesi

### Dalga 1: çekirdek POS (kafede bir gün satış yapılabilir)

1. Şema, göç, örnek veri (L'Affogato menüsü sitenin yapısıyla, köşk masa planı, personel, ödeme türleri)
2. PIN girişi, oturum, yetki, yetkili onayı, denetim kaydı
3. Uygulama kabuğu: gezinme, gün durumu, bağlantı göstergesi, kilit, tema
4. Masa planı: bölümler, durum renkleri, süre/tutar/garson, tezgâh ve gel-al hızlı satış
5. Adisyon: ürün ızgarası, arama, boy ve seçenek penceresi, not, adet, gönder (istasyona yönlendirme), happy hour.
   Varyant (boy) eklerken seçenek (27 Eki 2026, kullanıcı: "varyant ekleme de seçenekli olsun"): iki boylu ürünün
   boy düğmesi hemen ekler; zorunlu seçimi olan üründe (Türk kahvesinde şeker) seçenek penceresini o boy seçili açar.
   Pencerede zorunlu grup boyun hemen altında, önseçimsiz, başlığında "Zorunlu" yazar; seçilene kadar Ekle kapalı,
   altında "Şeker seçin". İsteğe bağlı grupta varsayılan seçili gelir (Normal süt). Yönetim › Ayarlar › Seçenekleri sor
   (`askOptions`): "Zorunlu seçim varsa" (`zorunlu`, varsayılan) ya da "Seçenekli her üründe" (`hep`: Latte da
   pencereyle). Tek boylu seçenekli ürün her iki ayarda pencereyle eklenir. Sunucu değişmedi: kasa satışında (eski
   istemci) seçeneksiz gelen zorunlu tek seçimlik gruba sunucu varsayılanı yazar; varsayılan kasada tükendiyse 409
   `option_sold_out` ("Orta tükendi; Şeker seçin", `docs/03-ENTEGRASYON.md` §2.3). İsteğe bağlı grubun tükenen
   varsayılanı (Normal süt) satışı durdurmaz: sunucu o grup için seçenek yazmaz, pencerede yalnız "Normal tükendi"
   bilgisi çıkar (su ve espresso süt sormadan satılır). Paket platformu ve site satırına varsayılan yazılmaz, seçim notta
   ya da sitenin döküm metninde gelir. Sepetteki tahmini tutar ve satır metni sunucunun yazacağı seçeneklerle
   hesaplanır: hızlı eklenen satırda (seçimsiz tek seçimlik grup) tükenmemiş varsayılan ücretiyle ve adıyla girer
   (`menuUnit`, `pendingOptionsText`; `tests/secenek-tahmin.test.ts`). Kurallar `src/lib/boot.ts` (`needsChoice`,
   `asksOptions`, `defaultPicks`, `missingChoice`), testi `tests/varyant-secenek.test.ts`
6. Masa işlemleri: taşı, birleştir, kalem taşı (böl), kişi sayısı, garson değiştir
7. İptal, ikram, kalem ve adisyon indirimi: gerekçe, yetki, yetkili PIN onayı, uyarı
8. Ödeme: nakit (para üstü, hızlı banknot), kart, yemek kartı, havale, cari; parçalı, kalem bazlı, kişi başı;
   bahşiş; ödeme iptali; yeniden açma
9. Canlı olay yayını: bütün ekranlar anında güncellenir

Kabul: kabul ölçütlerinin ilk üçü (bkz. geliştirilmiş prompt).

### Dalga 2: bar/mutfak ekranı, kasa, çıktılar

1. Bar/mutfak ekranı: istasyon filtresi, süre renkleri, hazırlanıyor/hazır/servis, ses, iptal fişi, geçmiş
2. Kasa: gün aç, harcama/teslim/giriş, X raporu, Z (ödeme türü, KDV, iptal/ikram/indirim, banknot sayımı, fark)
3. Çıktılar: adisyon, mutfak fişi, Z; 80 mm tarayıcı yazdırma ve ESC/POS ağ yazıcısı

### Dalga 3: entegrasyon

1. laffogato menü senkronu: herkese açık menü (ETag), eşleme, fark önizleme, uygula, POS alanlarını koru
2. İmzalı panel bağlantısı (anahtar varsa): Tükendi/Satışa aç siteye; Tükendi kalemleri görme
3. Online siparişler (anahtar varsa): bar ekranında ve masa planında; aşama düğmeleri; tekrar tahsil yok
4. lafmaliyet: günlük/aylık ürün satış listesi (Satışlar biçimi), Z özeti (Kasa raporu alan sırası),
   ikram listesi; imzalı uç için giden kutusu ve istemci (lafmaliyet tarafı yazılınca açılır)
5. İmza uyumu testi: iki projenin sabitlediği vektörler

### Dalga 4: müşteri, paket, rezervasyon, karaoke, porsiyon

1. Müşteri/cari: telefonla bul, adresler, açık hesap, tahsilat, geçmiş, damga kartı
2. Gel-al ve paket panosu: kurye, durumlar
3. Rezervasyon: gün görünümü, masa ataması, planda gösterim
4. Karaoke odası sayacı: başlat/durdur, saatlik ücret, HİZMET satırı; sitedeki rezervasyona bağlanır, sitede ödenen
   blok yeniden alınmaz (`docs/03-ENTEGRASYON.md` §2.4)
5. Porsiyon sayacı: günlük adet, sıfırda otomatik Tükendi (ve siteye bildirim); hazırlanmadan iptal edilen kalemin
   porsiyonu geri döner

### Dalga 5: raporlar, patron paneli, yönetim

1. Raporlar: özet, ürün/kategori, saatlik, ödeme türü, personel, iptal/ikram/indirim, KDV, CSV
2. Patron paneli: canlı ciro, geçen haftayla kıyas, saatlik grafik, en çok satanlar, açık masalar,
   uyarı akışı ve anomali kuralları
3. Yönetim: menü ve seçenekler, masa planı düzenleyici, personel ve yetkiler, ödeme türleri,
   istasyon/yazıcı, happy hour, fiş metinleri, entegrasyon ayarları, denetim kaydı, yedekleme

### Dalga 6: sağlamlaştırma

1. Uç testleri (adisyon akışı, ödeme, yetki, gün sonu)
2. Uçtan uca tarayıcı denemesi (tablet ve telefon genişliği)
3. Kurulum kılavuzu (kafe bilgisayarı, tabletler, uzaktan patron erişimi), otomatik yedek

### Durum (26 Ekim 2026)

Dalga 1-6 tamam ve birleşti (RiosenBeq/lafpos#1, 26 Ekim 2026; laffogato#263 ve lafmaliyet#34/#36 aynı gün canlıda). Planın üstüne yapılanlar: yazarkasa POS (TokenX Connect,
`docs/04-YAZARKASA.md`), Innex yönetim paneli ve telefon/tablet uyarlaması (`DESIGN.md`), düzenlenebilir
roller, kör kasa ve kasadan tükendi (Yönetim › Roller ve yetkiler), kasa bilgisayarı kurulumu
(`docs/05-KASA-BILGISAYARI.md`), tek sistem kararı (`docs/06-TEK-SISTEM.md`). Doğrulama (akşam turundan sonra): 107
birim ve API testi, gerçek Chrome'da 121 ekran ve 10 akış (`npm run e2e`, CI'da da).

Bağımsız inceleme (26 Ekim 2026) ve düzeltmeleri, her biri `tests/review-fixes.test.ts`'te bir testle:
yazarkasada sepeti bekleyen adisyonun tutarı ve ödemesi kilitli; indirim, ikram ve iptal ödenmiş tutarın altına
inemez; QR siparişine kalem taşınmaz; aynı kalem iki kez seçilince bir kez ücretlenir; yeniden açma ve ödeme
iptali müşterinin ziyaret, harcama ve damgasını geri alır; cihazda açık hesap müşterisiz ya da sınır aşınca
alarm, fiş iptali cari ekstresini düzeltir; iptal sayılan sepete geç gelen "ödendi" alarm verir; servis ücreti
cihaza ayrı satır; kör kasada kapanmış adisyonun ödeme dökümü gizli; fiş iptali ve kaydedilmiş sayımı
değiştirmek yetkili onayı ister; yetki yükseltme, kendi rolünü değiştirme ve son patronu kapatma yok; PIN
sınırı `X-Forwarded-For`'a bakmaz, ağ genelinde de sınır var; bir iş gününe tek Z, kapanıştan sonra "Günü
yeniden aç"; lafmaliyet'e `cashIn` ve `expectedCash` gider, 409 kalıcıdır. Ayrıca düzenleme uçları
`patchOf` kullanır: Zod 4'te `.partial()` varsayılanı uyguladığı için masanın adı değişince konumu ve türü,
rezervasyonun durumu değişince kişi sayısı ve süresi sıfırlanıyordu.

İkinci bağımsız inceleme (aynı gün, düzeltmelerin üstüne; `tests/review-round2*.test.ts`): patron olmayan yetkili
üstündekinin PIN'ini değiştiremez, onu kapatamaz, rolünü boşaltamaz, kendi indirim sınırının üstünde sınır
veremez; ağ geneli PIN kilidi kayan pencereyle sayar ve doğru PIN'le girmiş cihazları ve yetkili onayını durdurmaz
(alarm yazar); Token kesintisinde takılan sepet yetkili onayıyla LafPOS'ta iptal sayılır; kör kasa süzgeci adisyon
döndüren bütün uçlarda; indirim kayması cihaza "Servis ücreti" diye gitmez; yeniden açılan gün öbür cihazlara
yayılır ve otomatik gün sonu onu hemen kapatmaz (`business_days.reopened_at`); oda sayacı çalışırken hesap cihaza
gitmez, kapanmış adisyona oda ücreti yazılmaz; lafmaliyet'e gönderim sürerken basılan "Gönder" gerçekten gönderir.

Denetim düzeltmeleri, adisyon ve oda (`tests/audit-adisyon-oda.test.ts`): çalışan oda sayacı faturalanacak ücrettir.
Sayacı çalışan adisyon iptal edilmez (`room_running`; önce durdurulur, oda ücretinin iptali yetkili onayı ister),
kalemlerinin hepsi başka masaya taşınınca kapanmaz (sayaç kaynakta kalır), yazarkasada ödenince kapanmaz (uyarı
düşer). Bir odada aynı anda tek sayaç çalışır: odanın öbür hesabında başlatılmaz (`room_running`, sayacı tutan
adisyonun numarasıyla); kalemlerin hepsi aynı odadaki başka hesaba taşınınca sayaç da oraya geçer, boşalan kaynak
kapanır. Sepet cihazda beklerken ve sitede ödenmiş siparişte sayaç başlamaz; sitede ödenmiş sipariş masaya taşınmaz,
kasadan kapatılmaz. Masayı açmak QR siparişini değil masadaki kasa adisyonunu döndürür (yoksa yenisini açar).
Adisyon iptali boş adisyonda da, adisyon ve kalem indirimini kaldırmak da `siparis.al` ister; kaldırılan indirim
denetime yazılır (`order.discount_removed`, `item.discount_removed`). Hazırlanmaya başlanmamış kalem iptal edilince
porsiyonu geri döner; sıfırdan dönen ürün yeniden satışa açılır, sitede de. Başlamış kalem bekleyene ("yeni")
çekilemez, başlama zamanı silinmez: hazırlanmış ya da servis edilmiş kalem "hiç başlanmamış" gösterilip porsiyonu
geri alınamaz.

Aynı gün akşam (RiosenBeq/lafpos `claude/kasa-sade-tasarim`): kasa ekranları da Innex'e geçti (`DESIGN.md` §1);
**paylaşımlı hesap**: hesap N kişiye kuruşu kuruşuna bölünür, her pay ayrı ödenir, sonradan eklenen kalem ya da
iptal edilen pay kalanlara dağılır (`orders.split_people`, `payments.share_no/share_of`, göç 0003;
`tests/split-bill.test.ts` ve e2e akışı); **Windows kurulum dosyası** (`npm run kurulum:windows`,
`docs/05-KASA-BILGISAYARI.md` §2); **uzaktan canlı erişim** Tailscale ile ve Yönetim › Ağ ve uzaktan erişim
(`docs/07-UZAKTAN-ERISIM.md`, `tests/network.test.ts`); logo laffogato.net'in L'Af vektörü.

Simpra ve robotPOS karşılaştırmasından (26 Ekim gece, `claude/ust-duzey-kasa`): tezgâhta tek ekran (Öde gönderir
ve ödemeyi açar, satış bitince yeni satış; boş tezgâh adisyonu yeniden kullanılır, gün sonunda boşlar kapanır), bar
ekranında Toplam görünümü, Hazır çağrı ekranı (`/cagri`), hazırlama süresi raporu, siparişi alana hazır bildirimi,
elle fiyat, müşteri ekranı (`/musteri-ekrani`), adisyonda görselli ürün kartları ve kategori listesi, LafPOS Uzaktan
(Vercel, salt okunur; `docs/07-UZAKTAN-ERISIM.md` §4). Sırada: patronun telefonuna alarm bildirimi (lafmaliyet Web
Push), kampanya kuralları (fiyatın sahibi site; karar gerekir).

**Servis modu** (27 Ekim 2026, `claude/servis-modu`): Yönetim › Ayarlar'da masaya servis (varsayılan, bugünkü
akış), yarı self ve self servis. Self modlarda açılış ve menünün ilk sekmesi yeni tezgâh satışı (`/satis`), "Öde"
birincil; yarı selfte "Öde" ve "Gönder" bir kez masa no / numaratör sorar (`PUT /orders/:id/numarator`; harfli masa
adı klavyeden; ödenmiş satışta da düzeltilir ve denetime yazılır, gün sonu alınmış günde değişmez `day_closed`;
masaya taşınınca kalkar, "Ayrı hesap"la bölünen kalemlere geçer; kayıt sürerken ikinci basış kalemi yinelemez), bar ekranı, çağrı ekranı, hazır uyarısı ve fiş numara yerine "Masa 12" yazar; self serviste
numara ödeme sonucunda, bar fişinde ve adisyonda büyük. Ödeme kuralları ve bara gidiş değişmez. Mod değişikliği
ayrı denetim kaydı (`settings.servis_modu`, eski ve yeni mod). Testler `tests/servis-modu.test.ts`, e2e'de mod başına
bir akış. **QR + self servis** (`qr_self`, `claude/qr-self-servis`): self gibi kasada sipariş ve ödeme, ama Masalar
menüde kalır çünkü masadaki QR'ı okutan müşteri uygulamadan masaya sipariş verir ve sipariş masaya düşer. QR'ı LafPOS
üretir ve saklar (`tables.qrCode`, göç `0010_masa_qr`; sitenin 10 simgelik Crockford kuralı, içerik
`https://laffogato.net/masa/<kod>`, `shared/table-qr.ts`); Yönetim › Masa planı'nda masa başına QR, kod yenileme ve
A4 masa kartları (`printNow(…, { sheet: true })`). Sipariş eşlemesi önce `tableCode`, sonra etiket; sitenin kodu
tanıması için sözleşmeye eklenen `PUT /api/panel/tables` (giden kutusu `tables.sync`; site henüz almıyorsa
yeniden denenmez) `docs/03-ENTEGRASYON.md` §2.3. Benzerleri: Square'in hızlı servis (quick service) ve tam servis modları, Toast'un "service prompt"u
(gönderirken ya da öderken masa no sorar), tezgâhta numaratör veren kafeler.

**Seçenek grupları** (28 Ekim 2026, `claude/k-secenek`): kasaya özel (yerel) grup, ürün çekmecesindeki "Yeni grup"
ile orada açılır ve ürüne seçili gelir (orada "Grup açık" anahtarı yok: yeni grup hep açık); ürün ve grup bağları tek
istekte, tek işlemde yazılır (`POST /admin/products`
ve `PATCH /admin/products/:id` gövdesinde isteğe bağlı `groupIds`; gönderilmezse bağlar değişmez, eski
`PUT /admin/products/:id/groups` geriye uyum için yerinde). Grup penceresi (`src/components/admin/OptionGroupEditor.tsx`)
Seçenekler'de bağlı ürünleri de seçer (`productIds`, aynı işlem; yalnız bağlar için `PUT /admin/option-groups/:id/products`:
yeni bağ ürünün öteki gruplarının sonuna eklenir, bir ürüne en çok 12 grup) ve grubu kapatır ("Grup açık"; kapalı grup
kasada sorulmaz, bağlar durur). Denetim kaydı: seçenek ek fiyatı `menu.option_price` (eski → yeni, eklenen ve
kaldırılan seçenek, tek seçimlik grubun varsayılanı ücretli bir seçenekten ya da ücretli bir seçeneğe geçince
`defaultChange`: seçeneksiz kasa satışının tutarı değişir; etkin varsayılan grubun açıklığına bağlı, ücretli
varsayılanlı grubu kapatmak "grup kapatıldı; varsayılan Karton +₺5,00 → yok", açmak tersini yazar; yalnız ad,
ücretsizden ücretsize varsayılan ya da ücretsiz varsayılanlı grubun açılıp kapanması yazılmaz), ürün ↔ grup bağı
`menu.product_groups` (eklenen, çıkarılan);
ikisi de yazmayla aynı işlemde. Süt, şurup ve shot sitenin kod sabitinden gelir (laffogato
`src/lib/mobile/customization.ts`, mobil v1 sözleşmesi); LafPOS'ta salt okunur, panelden düzenlenmez. Testler
`tests/secenek-grubu.test.ts`, e2e'de `/yonetim/menu` › `yeni-urun` ve `yeni-grup` durumları ve telefonda akış.

**Hazır ve teslim** (28 Ekim 2026, `claude/k-hazir`): bar ekranında üç görünüm, Fişler, **Hazır** ve Geçmiş. Hazır
sekmesi son 30 dakikada hazır olup alınmamış siparişleri sipariş başına tek fişle, en uzun bekleyen üstte gösterir
(sekmede sayısı; `GET /kitchen?ready=1`); fişte tek dokunuşla **Teslim edildi** (`POST /kitchen/status` `servis`,
teslim zamanı `served_at`), bildirimde **Geri al** (`servis` → `hazir`: hazır anı korunur, hazır uyarısı yinelenmez).
Bar Geçmiş'inin Geri al'ı (ve Geçmiş'te kaleme dokunuş) bir adım geri gider: teslim edilmiş kalem "Hazır"a (teslimin
geri alınışı: hazır anı korunur, uyarı yok, sipariş kuyruğa dönmez), yalnız hazır kalem "Hazırlanıyor"a; sunucu da
teslim edilmiş kalemi "Hazırlanıyor"a götürmez, "Hazır"a indirir (gözden geçirme 2: iki adım geri giden sipariş
kuyruğa dönüyor, çağrı ekranında Hazırlanıyor oluyor, hazır uyarısı yeniden gidiyor ve hazırlama süresi şişiyordu).
Geçmiş fişinde hazır kalem varsa (kasanın siparişi; site ve platform değil) Geri al'ın yanında **Teslim edildi** de
durur (aynı uç): hazır anı korunduğu için teslimi geri alınan 30 dakikadan eski sipariş Hazır sekmesine, Fişler'e ve
çağrı ekranına dönmez, barista onu buradan yeniden teslim eder (`historyHandIds`; gözden geçirme son).
Kasada aynı düğme adisyonda (hazır tezgâh ve gel-al, kapanmış self servis satışı da) ve Siparişler kartında; önce
ödenip kapanmış tezgâh ve gel-al satışı hazır olunca Siparişler › Açık'ta da (sayıda da) görünür, "Ödendi" rozetiyle.
Bu kartlar bar Hazır sekmesiyle **aynı koşulla** süzülür (sunucuda tek koşul, `awaitingHandWhere`: son 30 dakikada
hazır olmuş, teslim edilmemiş bar kalemi, açık günün; açık gün yoksa hiç; `GET /orders?ready=1`, `kitchenTickets`
`ready`) ve yalnız teslim edebilene (`mutfak.ekran` ya da `siparis.al`) gelir: eskiden hazır kalemi teslim edilmemiş her
ödenmiş satış gün boyu ve gün sonundan sonra önceki günlerinki de görünüyor, yoğun günde gerçek açık adisyonları aşağı
itiyor, "son 100" sınırında taze sipariş düşebiliyor, kurye düğmesiz kart görüyordu. Self modlarda kartın adı çağrı
numarasıdır ("No 34"); paket platformunun gel-al'ında her modda platformun kısa kodu ("K9TX · Deniz Öztürk", çağrı
ekranı gibi; müşteri LafPOS numarasını bilmez; `orderCardName`). Site ve
paket platformu siparişleri Hazır sekmesine gelmez, teslimleri kendi akışlarında. Kasanın gel-al siparişinin aşaması
bara giden kalemlerden türetilir (`pickupStageOf`): hepsi teslim edildiyse "Teslim edildi", hepsi hazırsa "Hazır",
değilse "Hazırlanıyor". Kalem durumu değişince, bara kalem gidince (teslim edilmiş, kapanıp yeniden açılmış siparişe
eklenen kalem de), bar kalemi iptal edilince, kalem başka hesaba taşınınca (kaynak ve hedef) ve adisyonlar
birleşince yeniden türetilir; barın Geri al'ı "Hazır"ı da geri alır (denetimde `delivery.done` / `delivery.undo`;
teslimden dönüşün nedeni yazılır: "bara yeni kalem gitti", "bar hazırı geri aldı", "#N adisyonun kalemi barda"). Bara
kalem giden kasa gel-al'ında Siparişler'in elle aşama düğmeleri (Hazır, Yola çıktı, Teslim edildi) yoktur, sunucu da
elle aşamayı 409 `stage_from_bar` ile reddeder (`pickupFromBar`): elle "Teslim edildi" bar kalemi beklerken verilir,
bar sonra Hazır deyince aşama geri döner ve teslimin geri alınışı barista adına denetime düşerdi. Teslim kalemin Teslim
edildi düğmesiyle; bara kalem gitmeyen gel-al'da elle aşama sürer. Çağrı ekranı, Hazır sekmesi ve kasadaki
Teslim edildi düğmesi kasanın siparişinde kalemin durumuna bakar (teslimden sonra eklenen kalem yeniden görünür),
platform siparişini teslim aşamasında düşürür; paket platformunun gel-al siparişini LafPOS numarası yerine platformun
kısa koduyla ve adıyla gösterir. Platform siparişinin "N ürün hazır" uyarısı paket yetkili her cihazda çalar (kabul
eden, otomatik kabulde, kafede olmayabilir).
Müşteri ekranının teşekkürü bara giden kalemi olan self servis satışında çağrı numarasını da söyler ("Numaranız 34",
yarı selfte "Masa 12"; `thanks.call`, eski kasa göndermezse ekran bugünkü gibi); uzun masa no ("Masa WWWWWW") kutuyu
390 px'te taşırmaz (yazı ekranla küçülür, kelime kırılır; e2e taramasında `/musteri-ekrani` › `uzun-masa`). Hazırlama süresi raporunda
**Hazırdan teslime** ortancası (her teslim dokunuşu bir kez). Testler `tests/pickup-board.test.ts`,
`tests/prep-report.test.ts`, `tests/display.test.ts`; e2e'de iki akış ve self servis akışında ödeme penceresinin
gerçek teşekkür gönderimi (bara giden satışta numara, gitmeyende numarasız) ve önce ödenen satışın Siparişler › Açık'ta
"Ödendi" ve çağrı numarasıyla teslim edilmesi. Teşekkür gidince 300 ms toplanan
adisyon görüntüsü iptal olur ve gönderimler sırayla gider (`src/lib/display.ts`): ödemeden hemen önce kurulan
zamanlayıcı teşekkürü ezip ekranı ödenmemiş adisyona döndürüyordu (bu akış buldu).

**Mesai ve vardiya kasa sayımı** (2 Kasım 2026, `claude/mesai-vardiya`; mesai kısmı 4 Kasım'da kaldırıldı, aşağıda
"Mesai kaldırıldı"; vardiya kasa sayımı yerinde): personel girişini
kasa oturumundan (`POST /api/time/clock-in`, `/clock-out`) ya da kilit ekranında oturum açmadan PIN'le yapar
(`POST /api/time/punch`: PIN giriş ekranıyla aynı denetim ve deneme sınırı; yön verilmezse durum değişir, bir dakika
içindeki ikinci basış yok sayılır). Kurallar her yazmada: çıkış girişten sonra, ileri tarih yok, mesai en çok 24 saat
(çıkışı unutulan mesai şimdiye uzatılmaz, yetkili düzeltir: önceki iş gününde başlayıp 8 saatten uzun süren açık
mesai unutulmuştur, `shiftForgotten`; ne kilit ekranındaki basış ne kullanıcı menüsü onu kapatır, 409 `stale_shift`;
raporda sayılmaz, CSV'de "Açık (çıkış girilmeli)"), kişi başına tek açık mesai, aynı kişide çakışma yok. Yeni
yetki `mesai.yonet` (Yönetim grubu; müdür ve patron): çizelge (`GET /api/time`, en çok 93 gün, kişi toplamları ve şu an
içeridekiler), elle mesai, düzeltme, açık mesaiyi kapatma, silme, CSV; kendi mesaisini yalnız patron düzeltir. Yöneticinin
her yazması denetime düşer (düzeltme ve silme uyarı), kişinin kendi basışı düşmez; canlı konu `time`. Vardiya kasa
sayımı (`POST /api/cash/shift-counts`, `kasa.gun`, açık ve bugünün günü): devreden kasayı sayar, o anki beklenen nakit
ve fark (günün başından) saklanır; uyarı ya da alarm gün sonu sayımının eşiğiyle ve vardiyanın kendi farkıyla
(`shiftDiff`: önceki sayımdan bu yana), önceki devirde bulunan eksik sonraki devirde yeniden alarm olmaz
(`cash.shift_count`); devralan kendi PIN'iyle
onaylayabilir. Kör kasada beklenen ve fark, başkasının sayımında sayılan da gitmez; sayımlar `GET /api/cash/day` ve
`/days/:id`'de. Kasa hareketi değildir, lafmaliyet'e gitmez. Testler `tests/mesai.test.ts`, `tests/vardiya-sayim.test.ts`.

**Ekranlar, müşteri ekranı ayarı ve görünüm** (2 Kasım 2026): giriş ekranında **Mesai** sekmesi (aynı PIN, oturum
açılmaz; sonuç kartı kişinin adıyla "Hoş geldiniz, …" ya da "Görüşmek üzere, …"), kullanıcı menüsünde mesai
satırı (avatarda yeşil nokta),
Yönetim › Mesai çizelgesi (`/yonetim/mesai`, `mesai.yonet`: dönem, kişi toplamları, düzeltme, şimdi kapatma, CSV);
Kasa'da **Vardiya devri** penceresi (banknotla sayım, devralanın PIN'i, not) ve günün sayımları kartı. Müşteri ekranı
ayarlanır: `settings.customerDisplay` (tema gece, porselen ya da ev yeşili; saat; karşılama, alt satır ve teşekkür
metni; 6 saniyede bir dönen en çok 6 duyuru; karekod adresi ve etiketi), Yönetim › Müşteri ekranı
(`/yonetim/musteri-ekrani`, `ayar.yonet`) birebir önizlemeyle. Ekran ayarı oturumsuz `GET /api/public/display-config`'ten
alır (yalnız bu alanlar ve işletme adı), son görünümü cihazda saklar: sonraki açılışta ilk kare ayar gelmeden doğru temada, ayar ucu yanıt vermezse bu görünümle
çizilir (çevrimdışı açılış yok: sayfanın kendisi sunucudan gelir). Görünüm laffogato.net
kimliğindedir (`DESIGN.md`). Test `tests/musteri-ekrani-ayar.test.ts`; e2e taramasında yeni ekranlar ve durumları,
akışlarda mesai ve vardiya devri.

**Mesai kaldırıldı** (4 Kasım 2026, operatör kararı): kilit ekranının Mesai sekmesi (yalnız "Oturum aç" kalır),
kullanıcı menüsündeki mesai satırı ve avatarın "mesaide" noktası, Yönetim › Mesai çizelgesi, patron panelindeki "Şu an
mesaide" karosu (kalan beş karo ızgarayı boşluksuz doldurur), `/api/time` uçları, `mesai.yonet` yetkisi, `time` canlı
konusu ve mesai yardımcıları (`shiftForgotten`) kalktı. **Vardiya devri** (banknotla sayım, devralanın PIN'i) olduğu
gibi kalır; kasa, gün ve Z değişmedi. `time_entries` tablosu ve kayıtları silinmedi (şemada not, yeni göç yok); eski
denetim kayıtları (`time.*`) "Mesai" adıyla okunur. Kayıtlı rol setlerinde ya da kişinin ek yetkilerinde kalan
`mesai.yonet` okurken düşer (`isPermission`): roller ve personel ekranı açılır, düzenleme "Bilinmeyen yetki"ye takılmaz.
Testi `tests/mesai-kaldirildi.test.ts`.

Açık: ESC/POS ağ yazıcısına doğrudan basım (şimdilik tarayıcıdan 80 mm), yemek platformlarının canlı
bağlantısı, kasada damga (laffogato M2M), gerçek cihazla (iPhone, Android, fiş yazıcısı, ÖKC) kurulum turu,
kurulum dosyasının gerçek Windows'ta ilk turu (`docs/05-KASA-BILGISAYARI.md` §2 sonundaki liste), kurulum
dosyasının kod imzası (imzasız dosyada Windows SmartScreen uyarır).

## 5. Diğer repolarda gereken işler (ayrı PR, kullanıcı onayıyla)

Durum 27 Ekim 2026; sözleşme ve açılış sırası `docs/03-ENTEGRASYON.md` §6 ve §8. Bağlantıların hepsi varsayılan
kapalıdır: anahtar, `.env` ve lafmaliyet'teki geçiş günü yokken hiçbiri çalışmaz.

| Repo | İş | Neden | Durum |
| --- | --- | --- | --- |
| lafmaliyet | İmzalı `POST /api/pos/gun` ucu: günlük satış satırları + Z alanları + ikram; `pos_daily_sales`, Kasa raporunda "LafPOS'tan doldur" | Elle Z ve aylık liste girişini bitirir; sözleşme `docs/03-ENTEGRASYON.md` §4 | Birleşti (lafmaliyet#34, #36); durum, onarım ve geçiş günü B07 (#44), günlük satışlar aylık modele B08 (#46); kasa uzlaşması, komisyon ve ikram, ModPOS metinleri B09-B11 açık |
| lafmaliyet | İmzalı `GET /api/panel/pos/urunler`: ürün, boy, reçete maliyeti | Patron panelinde ürün kârlılığı (yalnız `rapor.maliyet` yetkisi) | Birleşti (#34); LafPOS günde bir, gün sonunda çeker (L2) |
| laffogato | Ayrı anahtarlı `/api/pos/*` (ortak `KARAOKE_SYNC_SECRET` yerine): RiosenBeq/laffogato#263 | Kafedeki makineye panel anahtarı koymamak, ayrı döndürülebilir anahtar | Birleşti (d1de10f) |
| laffogato | Online sipariş için ucuz "değişti mi" sinyali: `GET /api/pos/orders/version` (#263) | 5 dk sorgu sınırı varken siparişi saniyesinde görmek | Birleşti (#263) |
| laffogato | Bugünün karaoke rezervasyonları LafPOS'a (F1; LafPOS L4) | Sitede rezerve oda kasada boş görünmesin, ödenmiş saat yeniden ücretlenmesin | Birleşti (laffogato#264 cc0e40a, #265); LafPOS tarafı L4 (`docs/03-ENTEGRASYON.md` §2.4) |
| laffogato | Kasada damga (M2M) | Uygulama üyesine kasada damga vermek | Faz 2 |

## 6. Riskler

| Risk | Önlem |
| --- | --- |
| Neon kotası (site) | Menü ucu (CDN) gün açıkken 15 dakikada bir, gece hiç; imzalı uçlar en sık 5 dakikada bir ya da elle; sipariş sürüm sinyali veritabanına gitmez; `LAFFOGATO_URL` yoksa hiç istek yok (`docs/03-ENTEGRASYON.md` §2, §5) |
| Ortak anahtarın kafe makinesinde durması | Opsiyonel; `.env`'de, dosya izinleri 600; ayrı anahtar için laffogato PR'ı önerildi |
| Mali mevzuat | Adisyon "mali değeri yoktur" bilgi fişi; mali fiş ÖKC'den (TokenX Connect bağlantısı, `docs/04-YAZARKASA.md`) |
| Tek makine arızası | Günlük otomatik SQLite yedeği; kurulum kılavuzunda yedeğin başka diske/buluta kopyası |
| Online siparişin çift sayımı | `extPaid` siparişler tahsil edilmez, lafmaliyet satış listesine girmez |
