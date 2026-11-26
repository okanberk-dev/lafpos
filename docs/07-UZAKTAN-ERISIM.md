# Uzaktan erişim: LafPOS'a kafenin dışından canlı bakmak

LafPOS'un sunucusu kafedeki kasa bilgisayarında çalışır (`docs/05-KASA-BILGISAYARI.md`). Kafenin Wi-Fi'ındaki
tabletler ona yerel adresle bağlanır. Patron evden ya da yoldan aynı ekranları **Tailscale** ile açar: masalar,
adisyonlar, bar ekranı, kasa, raporlar, patron paneli ve yönetim, kafedeki ekranlarla aynı anda güncellenir
(sunucu olayları anlık iletir). Uzaktan yapılan her işlem kafedeki gibi PIN ve yetkiyle olur, denetim
kaydına düşer.

## 1. Neden Tailscale

| Yol | Durum |
|---|---|
| **Tailscale** (önerilen) | Kasa bilgisayarı ve telefon aynı özel ağa girer; bağlantı uçtan uca şifreli, yalnız sizin hesabınızdaki cihazlar görür. Modemde ayar yok, sabit IP gerekmez. Kişisel kullanım ücretsiz |
| Modemden port açmak | **Yapmayın.** LafPOS internete açılır, PIN'i tahmin etmeye çalışan herkes kapıya gelir |
| Bulut sunucusu | Kafede internet kesilince kasa durur; LafPOS bilerek yerelde çalışır (`docs/06-TEK-SISTEM.md`) |

Gün sonu rakamları lafmaliyet'e zaten gider (`docs/03-ENTEGRASYON.md`); Tailscale anlık ekranlar ve uzaktan
işlem içindir.

## 2. Kurulum (bir kez, 10 dakika)

1. **Kasa bilgisayarı:** https://tailscale.com/download adresinden Windows sürümünü kurun, Google ya da
   Apple hesabınızla girin. Saat yanındaki Tailscale simgesinden **Preferences › Run unattended**'ı açın:
   Windows'a kimse girmeden de (elektrik kesintisinden sonra) bağlı kalır.
2. **Telefon:** App Store ya da Google Play'den Tailscale'i kurun, **aynı hesapla** girin.
3. Kafede LafPOS'ta **Yönetim › Ağ ve uzaktan erişim**'i açın. "Dışarıdan (Tailscale)" kartında "Bağlı"
   yazar; adres `http://100.x.y.z:4000` ve karekodu oradadır.
4. Telefonda Tailscale açıkken karekodu okutun ya da adresi yazın, PIN'inizle girin. Tarayıcı menüsünden
   "Ana ekrana ekle" ile uygulama gibi açılır.

LafPOS'un Windows kurulumu güvenlik duvarında 4000 numaralı portu yalnız kafenin ağına ve Tailscale aralığına
(`100.64.0.0/10`) açar; başka ayar gerekmez. Git ile kurulan bilgisayarda Windows ilk açılışta izin sorar:
"Özel ağlar"ı işaretleyin.

## 3. Ayrıntılar

- **Adres değişmez:** Tailscale cihaza sabit bir `100.x` adresi verir. Tailscale'de MagicDNS açıksa
  bilgisayarın adıyla da açılır (`http://<bilgisayar-adı>:4000`).
- **HTTPS (isteğe bağlı):** kasa bilgisayarında yönetici komut isteminde `tailscale serve --bg 4000` LafPOS'u
  `https://<bilgisayar-adı>.<tailnet>.ts.net` adresinde geçerli sertifikayla sunar. Tarayıcı bu adreste ekran
  kilidini ve panoyu da açar. Bu yolda bütün uzak istekler sunucuya bilgisayarın kendisinden gelmiş görünür:
  PIN deneme sınırı uzaktaki cihazları birbirinden ayıramaz, adres yine yalnız sizin Tailscale ağınıza açıktır.
  Kapatmak: `tailscale serve reset`.
- **Funnel kullanmayın:** `tailscale funnel` LafPOS'u herkese açık internete çıkarır.
- **Personel telefonları** uzaktan erişime gerek duymaz; kafede yerel adresle bağlanır. Tailscale hesabına
  yalnız patron ve yönetici cihazlarını ekleyin.
- **Bağlantı kopunca** ekranın üstündeki durum noktası kırmızıya döner, LafPOS kendini yeniden bağlar.

## 4. LafPOS Uzaktan (Vercel): kurulumsuz, salt okunur

Telefona uygulama kurmadan, herhangi bir tarayıcıdan: `https://lafpos.vercel.app`, patron parolasıyla. Patron
paneli, masalar, açık adisyonların kalemleri, bar kuyruğu ve Raporlar (aşağıda); işlem yapılmaz (iptal, ödeme, Tükendi kafedeki kasadan
ya da Tailscale ile). Kafedeki sunucu canlı özeti (`server/sync/cloud.ts`) şu ritimle iter:

- **Değişiklikte** (sipariş, ödeme, masa, bar): en sık 15 sn'de bir; aradaki değişiklikler bir sonrakine girer.
- **Değişmeyen özet gitmez:** içerik aynıysa istek atılmaz (özetin, açılış verisinin ve panelin saati değişiklik
  sayılmaz). Sunucu 5 dk'da bir nabızla bakar.
- **Gün açıkken** nabız özet değişmese de iter: uzaktan panelin saati ve adisyon süreleri 5 dk'da bir tazelenir.
- **Gün kapalıyken** (gece) nabız değişmeyen özeti yalnız son itmenin üstünden 15 dk geçtiyse iter: boşta 15 dk'da
  bir (bir değişiklikten sonraki ilk boş itme, nabız 5 dk'da bir baktığı için 15-20 dk içinde). Uzaktan sayfadaki
  "… itibarıyla" saati son itmenin saatidir.

Bulut özeti Upstash Redis'te tutar (`api/uzaktan.ts`), ekran gün açıkken 15 sn'de bir, kapalıyken 60 sn'de bir
yenilenir (aşağıda "Upstash bütçesi"). Maliyet ve kâr, PIN'ler, müşteri telefonları gitmez.

- **Upstash bütçesi** (`tests/uzaktan-kota.test.ts`): ekran gün boyu açık kalsa da ücretsiz planın komut sınırına
  yaklaşmasın diye:
  - **Sürüm kaydı:** her dükkânın özet sürümü tek bir hash'te (`lafpos:surum`, alan dükkân kimliği; kasanın son
    itmesinin anı, içerik özeti, açılış verisinin özeti, gün açık mı). Görünümün her yoklaması yalnız bunu okur
    (HGETALL, tek komut): dükkân listesi, en son veri gönderen dükkân ve sürüm aynı okumada. Eskiden istek başına
    dükkân listesi iki kez ve bütün özet (~100 KB) okunurdu.
  - **Koşullu yanıt (ETag, 304):** canlı uçlar (`reports/patron`, `floor`, `kitchen`, `kitchen/board`, `orders/<id>`)
    sürümle, `bootstrap` açılış verisinin kendi özetiyle etiketlenir. İstemci (`src/lib/api.ts`, yalnız Uzaktan
    derlemesinde) etiketi adresle saklar ve `If-None-Match` ile sorar; sürüm aynıysa 304 döner, özet Redis'ten
    okunmaz, ekran aynı nesneyi tutar. `auth/me` ve bar ekranının boş Hazır ve Geçmiş sekmeleri Redis'e hiç gitmez.
  - **Değişmeyen özet yeniden yazılmaz:** kasanın gün açıkken 5 dakikalık nabzı içerik aynıysa yalnız sürümü
    ilerletir (HGET + HSET); özetin saatleri sunulurken sürümün anına çekilir, "son güncelleme" ve "Kafeden veri
    gelmiyor" uyarısı eskisi gibi çalışır. Özetin süresi (7 gün) günde bir uzatılır; özet silinmişse sürüm düşer ve
    kasanın bir sonraki itmesi yazar. Eski ya da yeniden gönderilen özetin denetimi de yalnız sürümü okur.
  - **Yoklama:** gün açıkken 15 sn (kasa en sık 15 sn'de bir iter: satıştan ekrana en geç ~30 sn), gün kapalıyken
    60 sn, açılış verisi ve menüdeki Masalar 5 dk. Sekme gizliyken (telefon kilitli, başka sekme) hiç sorulmaz,
    görünür olunca bir kez yenilenir. Salon ve adisyon da 15 sn; bar ekranında yalnız aktif fişler yoklanır.
  - **Raporlar:** kasanın "bugün"ü, dönemin ve kıyas döneminin günleri ve ek sekmelerin verisi tek MGET'te (60
    anahtarlık parçalar); kasanın rapor itmesinde de "bugün" günlerle birlikte okunur.
  - Bir saat açık Patron paneli (gün açık, tek dükkân): sakin saatte (yalnız nabız) 1116 komut yerine 276, her
    dakika satışta 1260 yerine 480, gece (gün kapalı) 1092 yerine 72; Redis'ten okunan veri saatte ~38 MB yerine
    ~1,3 MB (sakin). Kafe bağlanmadan (demo) istek başına iki küçük komut.
  - **Uzaktan yönetim** (`api/_kontrol.ts`, `docs/UZAKTAN-YONETIM.md`, `tests/kontrol-bulut.test.ts`): Merkez nabzının
    komut sayısı artmaz (komut yokken yine MGET + SET + MGET). Kuyruk işareti `lafpos:kontrol:var:<kurulum>`, kasa
    özetinin parmak izi `…:ozet:<kurulum>` ve kasaya giden son komutun anı `…:teslim:<kurulum>` (kasaya ulaşan komut
    iptal edilmez) kurulum kaydıyla aynı MGET'te; kuyruk (HASH `…:komut:<kurulum>`) yalnız işaret varsa okunur. Özet
    (`…:durum:<kurulum>`, en çok 64 KB) ve sonuçlar (LIST `…:gecmis:<kurulum>`, en çok 100 satır) yalnız değişince
    yazılır; saatlik sayaç `…:sayac:<kurulum>:<saat>` (2 saat). Panelin `kontrol/durum` yoklaması MGET + LRANGE
    (bekleyen varken + HVALS); bir komut GET + HLEN + INCR + HSET + SET. Panel üyeleri: `lafpos:uye:<e-posta>` (rol
    yalnız davetle eklenende), `lafpos:uye-davet:<e-posta>` (kodun özeti, 7 gün), `lafpos:uyeler` (küme); rol oturumun
    zaten okuduğu üye kaydından gelir, ek okuma yok.
  - **Platform gelen kutusu** (Yemeksepeti, Getir; `docs/PAKET-PLATFORMLARI.md`): kasanın 20 saniyelik çekimi iki
    liste (iptaller, siparişler) için LRANGE + LLEN, silmesi liste başına LRANGE ve silinen kayıt başına LREM. Kutu
    restorana ayrılınca da (`?restoran=`, kimlik Vercel'de tanımlıysa) kasa yalnız kendi iki listesini okur: komut
    sayısı ortak kutuyla aynı, şube eklense de artmaz (Getir'de kimlik kasada saklanır, girişi düşen kasa da kendi
    kutusunu ister). Yalnız sorgusuz istek, yani güncellenmemiş eski kasa ya da Getir'e hiç girememiş yeni kurulum,
    ortak listeyle birlikte bütün restoranlarınkini okur (restoran başına iki LRANGE + iki LLEN fazla).
  - Geçiş: bu sürümden önce yazılmış kayıt (`lafpos:dukkanlar`, eski kasanın `lafpos:snapshot`'ı) sürüm yokken
    okunmaya devam eder (koşullu yanıt yok); kasanın ilk itmesi sürümü yazar, `lafpos:dukkanlar` artık yazılmaz.

- **İnternet yokken** itme gidemez; özet kaybolmaz, bir sonraki itme son hâli taşır. İnternet gelince bekleyenlerle
  birlikte hemen bir kez itilir (`server/sync/catch-up.ts`, `docs/05-KASA-BILGISAYARI.md` §6 "İnternet yokken").
  Kafede durum alanı "İnternet yok · N kayıt bekliyor", sonra "Bekleyenler gönderildi"; son başarılı itme Yönetim ›
  Genel bakış › Sistem sağlığı › LafPOS Uzaktan'da.
- **Anlık ciro (patron paneli):** bugünün cirosu, adisyon sayısı ve ortalaması, açık masaların tahsil edilecek
  tutarı, ödeme türleri, yazarkasadan geçmeyen kart ve nakit (Gün içi; kör kasa kuralıyla, `docs/04-YAZARKASA.md`
  §4.2), geçen haftanın aynı günüyle "bu saate kadar" kıyas ve saat saat grafik (bugün ve geçen
  hafta aynı gün), uyarılar (iptal, ikram, indirim sıçraması) canlı özetten gelir: satıştan en geç ~15 sn sonra
  itilir, sayfa gün açıkken 15 sn'de bir koşullu yeniler (yeni yoklama yok; özet değişmediyse 304). Durum satırı saniyesiyle "son güncelleme 14:05:09" yazar; gün açıkken son
  veri 10 dakikadan eskiyse (kasa nabzı 5 dk'da bir) "Kafeden veri gelmiyor" uyarısı çıkar (`remoteFreshness`,
  `src/lib/remote.ts`). Gün kapalıyken son gün sonunun kartı: Z, ciro, adisyon, ödeme türleri, yazarkasadan geçmeyen ve
  kasa farkı (beklenen, sayılan; kasa rakamları yalnız patron rolü kasa rakamlarını görüyorsa, kör kasa kuralı; bu alandan
  önce kapanan Z'de yazarkasadan geçmeyen satırı yok). Maliyet ve kâr yok.
- **"Bugün" kıyasları (patron paneli, kafede ve Uzaktan'da aynı; 22 Kasım 2026):** ciro kartında adisyon, ortalama
  adisyon ve masada oturan kişi; altında **Kıyas** kartı: dün, geçen hafta aynı gün ve geçen ay aynı gün (takvimde aynı
  gün; "22 Ekim Perşembe" gibi tarih ve gün adı yazılı). Her satır tutar, adisyon, fark (₺, işaretli) ve değişim
  (ok, işaret, yüzde; renk tek başına değil). Gün sürerken kıyas o günün **aynı saatine kadar** (gün başından, 05:00,
  aynı dakikaya kadar kapanan adisyonlar), küçük satırda o günün gün sonu toplamı; gün kapanınca tam gün; gün henüz
  açılmadıysa kıyas günlerinin gün sonu, yüzdesiz. O tarihte iş günü yoksa (kafe kapalıydı, LafPOS'a geçişten önce)
  "Veri yok" yazar, ₺0 değil; geçen ayda o gün yoksa (31 Ekim → Eylül) "Eylül ayında 31 yok". Altında **Gün boyu
  ciro** (bugün ve geçen hafta aynı gün birikimli, üst üste; dokununca ya da oklarla saatin iki değeri, ekran okuyucuya
  tablo), **Hafta ve ay** (hafta Pazartesi'den, ay 1'inden bugüne; önceki hafta ya da ayın aynı gün sayısıyla, aynı
  gün aynı saate kadar; geçen ayda bugünün günü yoksa önceki ayın tamamı) ve **gün sonu tahmini** (yalnız gün sürerken,
  "tahmini" etiketli: son 4 aynı haftagününün bu saate kadarki payı Σ aynı saate kadar / Σ gün sonu; bugünkü ciro bu
  paya bölünür; en az 2 satışlı gün ve %10 pay gerekir). En çok satanlar ilk 5 ve geçen haftanın aynı günü (aynı saate
  kadar adet ve değişim).
  - Hesap `shared/today-stats.ts`'te (saf; kasa ve Uzaktan aynı kod), ölçüt Raporlar › Ciro'nunki: kapanmış POS
    adisyonu (online ödenmiş sipariş, ikram ve ödenmez dışı), adisyon tutarı olan kapanmış adisyon, İstanbul iş günü.
    Hafta ve ay kıyası Raporlar'ın kıyas dönemiyle (`comparison`) aynı rakamı verir (`tests/patron-kiyas.test.ts`;
    altın testler `tests/today-stats.test.ts`: eksik gün, gün aşırı kapanış, hafta ve ay sınırı, 29-31 gün farkı).
    Bilinen tek fark: kıyas döneminin önceki bir gününde kıyas saatinden sonra kapanan adisyon (gün ertesi güne açık
    kalıp geç kapanan) burada tam gün sayılır.
  - Upstash bütçesi değişmez: kasa girdiyi patron özetine koyar (`stats`: kıyas günlerinin kapanış dakikaları, hafta ve
    ay için geçmiş günlerin toplamı, en çok satanların geçen haftaki kapanışları; birkaç KB). Girdi saatten bağımsızdır,
    yalnız satışla değişir; "aynı saate kadar" kesimini ekran özetin anıyla yapar. Yeni Redis okuması ya da yoklama
    yok, kıyas her yoklamada yeniden okunmaz (304 aynı). `stats` göndermeyen eski kasada (güncelleme gün
    kapanınca kurulur; o güne dek kasa eski derlemeyle iter) Uzaktan girdiyi bulutta zaten duran gün raporlarından kurar
    (`api/uzaktan.ts` `withStats`, `shared/remote-calc.ts` `statsFromReports`; yanıtta `stats.src: "rapor"`): kıyas
    günlerinin kapanış dakikaları gün raporunun `closes`'undan (yoksa saatlik kırılım, o da yoksa gün sonu toplamı ve
    satırda "gün sonu" notu), hafta ve ay toplamı geçmiş günlerin raporundan. Yeni yoklama yok: okuma yalnız özetin zaten
    okunduğu yanıtta (sürüm değişti) yapılır ve işlev örneğinin belleğinde yarım saat tutulur (dükkân başına yarım saatte
    en çok bir okuma, ~65 anahtar, iki MGET; `tests/uzaktan-kota.test.ts` "eski kasa"). Kasa güncellenince bu yol
    kendiliğinden kapanır. Gün raporu da yoksa (kafe bağlı değil, demo özeti) kart özetin iki rakamıyla çizilir: dünün gün
    sonu toplamı ve geçen haftanın bu saati (`summaryCompares`).
- **Raporlar:** kasa her iş gününün rapor özetini ayrıca iter (`server/sync/cloud-reports.ts`,
  `POST /api/uzaktan/rapor`): ciro ve döküm, ödeme türleri, yazarkasadan geçmeyen kart ve nakit (`s.off`; eski kasanın
  gününde yok, dönemde böyle bir gün varsa Ciro satırı yazmaz, `sumOffDevice`), satış türleri, KDV, ürün ürün satış (maliyetsiz), saatlik
  dağılım, Z numaraları, iptal, ikram, ödenmez, zayi, indirim, personel satışı ve kapanışların dakikası (bugünü
  içeren dönemin "aynı saate kadar" kıyası). Rakamlar Raporlar'ın kendi servisleriyle kurulur; Uzaktan'daki Raporlar
  (Ciro, Ürünler, Saatlik, Personel) dönemin günlerini toplar ve kafedekiyle aynı rakamı verir
  (`tests/uzaktan-raporlar.test.ts`). Dönem en çok 400 gün; kıyas dönemi 420 günden eskiyse boş görünür.
  - Ritim: bugün ve dün değişiklikte en sık 5 dk'da bir (değişmeyen gün gitmez); ilk açılışta geçmiş 400 gün dakikada
    7 günlük paketlerle (yaklaşık bir saat); sonra günde bir kez, gün kapalıyken aynı tarama yalnız sonradan değişen
    günü (ör. eski güne ödeme iptali) iter. İnternetsizken gidemeyen gün kuyrukta bekler, durum alanında sayılır
    ("Uzaktan raporu N gün"); internet dönünce catch-up onu bir kez gönderir.
  - Upstash: gün başına bir anahtar `lafpos:rapor:<dükkân>:gun:<tarih>` (dükkân Merkez'e bağlı kasada kurulum
    kimliği, bağlı olmayan eski kasada `default`), süresi günün kendisinden 420 gün (EXAT); kasanın "bugün"ü `lafpos:rapor:<dükkân>:son`. Okuma
    parça parça MGET (60 gün). Eski özet (aynı günün önceki kuruluşu) yenisini ezmez.
  - **Ek sekmeler** (hazırlama süresi, adisyonlar, paket platformları, iptal, ikram, indirim ve ödeme iptali
    listeleri, happy hour) ve CSV'ler de uzakta: kasa her günün tek günlük çıktısını ayrı anahtarda iter
    (`lafpos:rapor:<dükkân>:ek:<tarih>`), dönem `shared/remote-calc.ts` ile kasadaki kuralla birleşir; CSV satırları
    `shared/report-csv.ts`'ten (kasa da aynısını kullanır). Dönemde ürünün kategorisi kasadaki gibi bugünkü (itme
    bugünkü kategori haritasını taşır); gün aşırı ödeme (adisyon başka günde) dönemin içine düşüyorsa kapanmışların
    ödemesi ve adisyonun ödeme türü sayılır (`xpay`). Yalnız lafmaliyet aktarımı kafede. Kasadakiyle eşitlik
    `tests/uzaktan-raporlar.test.ts`.
  - **Yeniden gönder:** Redis silinir ya da eksik kalırsa Yönetim › Ağ ve uzaktan erişim › LafPOS Uzaktan ›
    "Raporları yeniden gönder" gönderim geçmişini sıfırlar; tarama 400 günü yaklaşık bir saatte yeniden iter.
  - **Silinen günler:** "Denemeyi bitir" ve "Geçişi tamamla" (`server/services/deneme.ts`) kasada sildiği günlerin
    tarihlerini silmeyle aynı işlemde yazar (`sync_state` `cloud.reports.silinen`). Sıradaki canlı bakışta (en geç 5 dk)
    o tarihlere satışsız gün raporu (`n: 0`, ek verisiz) gider: bulut eski deneme raporunun ve ek verisinin üstüne yazar,
    Uzaktan o günü gün listesine ve toplamlara katmaz. API değişmedi. O tarihte LafPOS günü kaldıysa (deneme günüyle aynı
    tarihte gerçek gün) ya da geçmiş ciro (ModPOS) günü varsa boş gün gitmez, aynı bakışta o günün raporu gider (deneme
    satışı çıkmış hâliyle; günlük taramayı beklemez). Gidemeyen tarih
    listede kalır; "Raporları yeniden gönder" listeyi silmez. Daha önce gönderilmiş ama kasada artık hiçbir şeyi olmayan
    tarih (bu sürümden önce yapılmış geçiş) günlük tarama ona gelince (en geç bir gün) aynı yolla boşaltılır
    (`tests/deneme-uzaktan.test.ts`).
  - Buluta gitmez: maliyet, kâr ve komisyon, PIN'ler, müşteri adı ve telefonu (ödenmez kişisi "Müşteri"), iptal,
    ikram, indirim ve iade nedenleri.
- **Güncelleme kanalı da bu projede:** aynı derleme `dist/web/guncelleme/`'yi yazar (`npm run kanal`): kafedeki
  kasa `https://lafpos.laffogato.net/guncelleme/surum.json`'dan yeni sürümü alır (anahtarsız; ayrıntı
  `docs/05-KASA-BILGISAYARI.md` §6 "Otomatik güncelleme"). `vercel.json` `/guncelleme/*`'ı arayüz sayfasına çevirmez.
- **Üyelik (e-posta ve parola):** Vercel'de `LAFPOS_UYE_EPOSTA` (virgülle birden çok e-posta) tanımlıysa giriş e-posta
  ve parolayla çalışır ve gerçek veri yalnız üyeye açılır; parolasız görünüm ve `LAFPOS_UZAKTAN_PAROLA` o zaman
  kullanılmaz. Parola hiçbir ortam değişkeninde ya da dosyada durmaz: üye ilk girişte ("Üyeliği oluştur") kendisi
  belirler, Redis'te yalnız scrypt özeti (`lafpos:uye:<e-posta>`) saklanır. İlk girişte davet kodu istenir
  (`LAFPOS_UYE_DAVET`, gizli, en az 8; büyük-küçük harf, boşluk ve tire fark etmez): e-postayı bilen başkası üyeliği
  sahipten önce açamaz; kod tanımlı değilse üyelik açılmaz. Üyelik bir kez açılır (sonraki deneme 409); parolayı
  sıfırlamak için Upstash'te o anahtar silinir, üye giriş ekranında "İlk kez mi giriyorsunuz? Üyeliği oluştur"a
  basıp davet koduyla yeniden oluşturur (başka üye varken de). Oturum 30 gün; imzaya parola
  özeti girer, parola değişince bütün oturumlar düşer. Deneme sınırı aynı (IP başına 15 dakikada 8); yanlış parola ve
  bilinmeyen e-posta aynı yanıtı alır ve aynı sürede (her yolda tek parola özeti). Kafe bağlanmadan önce site demoya yönlenmez: giriş ekranı görünür, demo orada
  "Demoyu dene" bağlantısıdır (`tests/uzaktan-uyelik.test.ts`, `e2e/uzaktan.mjs`). Ortamdaki e-posta sahiptir; sahip
  panelden başkasını da ekler (Uzaktan yönetim › Panel erişimi: yönetici ya da yalnız görür): kişiye bir kez görünen
  kişisel davet kodu verilir (7 gün), ilk girişte o kodla parolasını belirler. Kaldırılanın kaydı silinir, oturumu en
  geç bir dakikada düşer; ortamdaki e-posta panelden değişmez (`tests/kontrol-bulut.test.ts`).
- **Üye girişi ve İndir (siteden kurulum):** giriş ekranı sitenin "Üye girişi"dir; girişten sonra menüde **İndir**
  (`/indir`, yalnız Uzaktan derlemesinde). Kafeden veri gelmemişken üye girişten sonra doğrudan kabuksuz İndir'i görür;
  sayfa yarım dakikada bir `/api/uzaktan/durum`'a bakar, kafe bağlanınca canlı görünüm kendiliğinden açılır.
  Sayfa kanalın yanındaki anahtarsız web kurucusuna bağlanır: `/guncelleme/LafPOS-Kur.cmd` (`npm run kanal`
  yazar, `scripts/kasa/windows/kurulum/web-kurucu.mjs`; `vercel.json` onu indirme olarak sunar). Dosya herkese
  açıktır ama gizli bir şey taşımaz (`tests/web-kurucu.test.ts`); bağlantı yalnız oturumda görünür. Kurucu cmd ve
  PowerShell 5.1 iki dilli tek dosyadır: yönetici izni ister, kanalın surum.json'unu okur (okunamazsa içine gömülü
  derlemeyi kullanır), Node'u nodejs.org'dan, better-sqlite3'ün Windows ikilisini GitHub'dan, uygulama yükünü
  kanaldan SHA-256 ile doğrulayarak indirir, `lafpos.nsi` ile aynı klasörleri, görevi, güvenlik duvarını,
  kısayolları ve Uygulamalar kaydını yazar. Yeniden çalıştırmak onarır ya da son sürüme günceller (gün açıksa
  sorar, önce veritabanının kopyasını alır). Kurulum dosyasının Kaldir.exe'si yoksa kaldırma
  `LafPOS-Kaldir.ps1` ile. Tam kurulum dosyası (LafPOS-Kurulum.exe) GitHub Releases'ta kalır: depo özel ve
  Vercel NSIS derleyemez.

- **Merkez (`/merkez`): dükkânlar, lisans, seçerek güncelleme** (`api/_merkez.ts`, kasada `server/sync/merkez.ts`,
  kural `shared/lisans.ts`, `tests/merkez.test.ts`, `tests/denetim-merkez.test.ts`). Yalnız sahibin oturumuyla
  (ortamdaki üye ya da parolalı giriş); parolasız görünümde ve panele eklenen yönetici ya da izleyicide uçları 403
  `remote_admin` (oturum düşmez), kafe bağlanmadan örnek satır salt okunur.
  - **Kayıt:** kasa ilk açılışta gizli anahtar üretir, kurulum kimliği anahtarın özetidir (sha256'nın ilk 24'ü;
    `sync_state` `merkez.kimlik`, deneme bitirme silmez): kimliği gören başkası onu kendi anahtarıyla kaydedemez.
    Merkez adresi `LAFPOS_MERKEZ_URL`, yoksa `LAFPOS_CLOUD_URL`; `LAFPOS_MERKEZ_URL=0` kapatır, `LAFPOS_CLOUD_SECRET`
    yoksa da kapalıdır. İnternete ilk çıktığında `POST /api/merkez/kayit`, kafenin ortak anahtarıyla
    (`LAFPOS_CLOUD_SECRET`) imzalı: dışarıdan kimse kurulum açamaz; aynı kimliğe başka anahtar 409 (kasa o zaman yeni
    kimlik üretir), IP başına saatte 10 kayıt, onay bekleyen en çok 50 (429). Merkez'de "Onay bekliyor". Sonra 5
    dakikada bir `POST /api/merkez/nabiz`, kurulumun kendi anahtarıyla imzalı (`x-laf-kurulum` + imza başlıkları):
    sürüm, güncelleme durumu, gün açık mı. Nabız yalnız kendi alanlarını ayrı anahtara yazar
    (`lafpos:merkez:durum:<id>`): panelin aynı anda verdiği lisans ya da hedef ezilmez. Güncelleme sorunu bildirimi
    yalnız onaylı (aktif) dükkândan, sabit metinle ve kurulum başına 6 saatte en çok bir kez gider. Kayıt Merkez'de
    silinirse (panelde "Kaydı sil" ya da Redis sıfırlandı; 404) kasa bir sonraki nabızda yeniden kaydolur.
  - **Lisans:** onaysız kurulum kuruluştan 14 gün deneme; aktif lisans bitiş gününün (Uzaktan'da "Son gün")
    sonuna (İstanbul) kadar, bitişsiz süresiz. Bitişe 14 gün kala yalnız uyarı ("Lisans … tarihinde bitiyor"; kasada
    ayar yetkisi olana amber şerit, panelde "Yakında bitiyor"). Pasif ya da süresi dolmuşta önce uyarı (kasada amber
    şerit), 7 gün sonra yeni satış kapanır (adisyon açma, kalem ekleme, platform siparişi kabulü 403
    `license_blocked`; otomatik kabul "lisans kapalı" deyip siparişi bekletir); tahsilat, kalem taşıma, sitede ödenmiş
    online sipariş, kayıtlar ve raporlar her durumda açık. Kasa son yanıtı (`merkez.son`) saklar ve kendi saatiyle
    hesaplar.
    **Çevrimdışı kural (kesin): internetsiz kasada satış hiç kapanmaz.** Satışın kapanması için kasanın lisans
    kaydını Merkez'den son 15 dakikada (`CONFIRM_MS`, üç nabız) almış olması gerekir; değilse süresi dolmuş lisans en
    çok uyarıdır ("kasa Merkez'e ulaşamıyor, satış sürüyor"). Böylece sahibin uzattığı lisansı henüz alamamış kasa
    durmaz; bedeli, internetten kopan kasanın kapanmamasıdır. Panel aynı kuralı kasanın son görülmesiyle hesaplar
    (`shared/lisans.ts` `licenseState` `confirmedAt`). **Lisans zorlayıcı değildir:** Merkez adresi yoksa
    (`LAFPOS_MERKEZ_URL=0`, `LAFPOS_CLOUD_URL` ya da `LAFPOS_CLOUD_SECRET` tanımsız) lisans uygulanmaz; kasanın
    ayarlar.env'ine erişen kişi kapatabilir. Durum Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme'de (lisans, son
    günü, şube kodu).
  - **Şube kodu:** sahip dükkânın ayarlarında verir ("TZL"; büyük harf, rakam ve tire, en çok 12). Nabzın yanıtıyla
    kasaya gider (`kod`), Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme'de ve fişin başlığında ("Şube Tuzla · TZL",
    bootstrap `branch`) görünür. lafmaliyet'in şube kimliğinden (`branchId`) ayrıdır, sistemler arasında gitmez.
  - **Şimdi güncelle (uzaktan):** dükkânın ayarlarında "Şimdi güncelle" (`POST /api/merkez/simdi-guncelle`): hedef
    kanalın son derlemesi olur, kasa bir sonraki nabızda alır ve kasadaki "Şimdi güncelle"nin isteğini yazar; gün
    açıkken kurdurmaz (`docs/05-KASA-BILGISAYARI.md` §6). Panelde kasa alana kadar "Güncelleme istendi". Uzaktan
    yönetimin "Gün sonu al ve güncelle"si aynı kaydı yazar (`api/_merkez.ts` `requestUpdateNow`: hedef, gönderim anı,
    istek), isteğe gün sonunun komut kimliğiyle (`guncelleKomut`, nabzın yanıtında): kasa önce komutları uygular,
    güncellemeyi ancak o gün sonu uygulandıysa ister. Gün sonu reddedildiyse ya da 30 dakikada kasaya gelmediyse istek
    güncelleme başlatmadan kapanır ve kayda düşer; gönderilen hedef geçerli kalır (olağan yoldan gün kapanınca kurulur).
    Gün sonu kasaya gitmeden iptal edilirse bulut isteği de geri alır (`withdrawLinkedUpdate`; istek hâlâ o gün sonuna
    bağlıysa), hedef kalır. Eski kasa alanı görmez, isteği hemen işler.
  - **Seçerek güncelleme:** dükkân "Ben gönderince" (varsayılan) ya da "Otomatik". Panelde dükkânlar seçilip
    "Güncelleme gönder": hedef kanalın o anki son derlemesi olur. Nabzın yanıtı hedefi taşır; güncelleyici
    (`guncelle.mjs` `merkezCap`) kanalda daha yeni derleme görünce sunucuya (`/api/kasa/guncelleme-durumu`, yalnız bu
    bilgisayardan; Merkez'le imzalı konuşan sunucudur) sorar. Gönderilen hedef "kurulabilir" iznidir, üst sınır değil:
    kanal yalnız son derlemeyi tutar, hedef kurulu derlemeden yeniyse kasa gün kapanınca kanalda o an olanı kurar
    (gönderimden sonra main'e yeni PR girse de). Hedef kurulu derlemeyi geçmiyorsa beklenir. Sunucuya ulaşamazsa son
    bildiği kararda kalır; Merkez kapalıysa kanalın son sürümünü izler (eski davranış). Durum "Yeni sürüm … hazır;
    Merkez'den gönderilince kurulacak". Panel satırı kasanın bildirdiği durumu gösterir: "İndiriliyor", "Gün kapanınca
    kurulacak", "Kuruldu", "Sorun çıktı, eski sürüme döndü".
  - **Yeni sürüm hazır:** kanalın `surum.json`'u `not` taşır (son commit'in başlığı, squash'ta PR başlığı;
    `kanal.mjs` `changeNote`). Panel gönderilmemiş dükkânları "Bekleyenleri seç" ile seçer.
  - **Bildirim:** güncelleme sorunu (eski sürüme dönüş, hata) yalnız lisansı aktif dükkândan, sabit metinle ("Yeni
    sürüm kurulamadı; eski sürüm çalışıyor") ve sahibin verdiği adla; bir kurulumdan 6 saatte en çok bir kez. Kasanın
    yazdığı ileti yalnız panelde görünür. Bilinmeyen güncelleme durumu "bilinmiyor" olarak saklanır.
  - Redis: `lafpos:merkez:kurulum:<id>` (panelin alanları), `lafpos:merkez:durum:<id>` (nabzın alanları),
    `lafpos:merkez:kurulumlar` ve `lafpos:merkez:bekleyen` (küme). Panel listesi 100 kimlikte bir okunur.
  - **Dükkân bazında görünüm** (`tests/dukkan-raporlar.test.ts`): kasa canlı özeti ve raporları kurulum kimliğiyle
    iter (`x-laf-dukkan`; özet `lafpos:snapshot:<id>`, eski kasa `lafpos:snapshot`). Kimlik değişince (kasa Merkez'e
    ilk bağlandığında) rapor gönderimi geçmişi yeni kimlikle baştan iter (yaklaşık bir saat; `default` verisi okunur
    kalır, 420 günde düşer). Birden çok dükkân veri gönderiyorsa üst çubukta dükkân seçici (adlar Merkez'den); seçim
    tarayıcıda saklanır, seçilmezse en son veri gönderen dükkân. Dükkânların son itme anı sürüm kaydında
    (`lafpos:surum`, yukarıda "Upstash bütçesi").

- **Telefon bildirimleri** (Web Push; `api/_bildirim.ts`, kasada `server/sync/bildirim.ts`, `tests/bildirim.test.ts`):
  kasa önemli olayı imzalı iter (`POST /api/uzaktan/bildirim`), site abonelere bildirim atar. Olaylar: tek seferde
  eşik üstü iptal ya da ikram (varsayılan ₺500), gün sonunda kasa farkı (₺100), uzun internet kesintisi (15 dakika;
  dönünce süresiyle), Pavo gün sonu alınamadı; güncelleme sorununu (eski sürüme dönüş) Merkez nabızdan kendisi görür.
  Eşikler ve aç/kapa kasada Yönetim › Ağ ve uzaktan erişim › Telefon bildirimleri; internet yokken olay kuyrukta
  bekler (en çok 20, 24 saat). Telefonda patron Uzaktan › Merkez › Telefon bildirimleri › "Bu telefonda aç" der
  (iPhone'da önce Ana Ekrana Ekle); abonelik yalnız gerçek oturumla. Bildirimde neden, müşteri adı ve maliyet yok.
  Anahtarlar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Vercel); servis çalışanı `public/sw.js` (önbellek tutmaz).

| Nerede | Ne |
|---|---|
| Vercel › lafpos › Storage | Upstash Redis (ücretsiz plan yeter; `KV_REST_API_URL`, `KV_REST_API_TOKEN` kendiliğinden gelir) |
| Vercel › lafpos › Environment Variables | `LAFPOS_CLOUD_SECRET` (en az 32 karakter); üyelik için `LAFPOS_UYE_EPOSTA` ve gizli `LAFPOS_UYE_DAVET` (parola ilk girişte belirlenir); eski düzende parolayı açmak için `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` ve `LAFPOS_UZAKTAN_PAROLA` (en az 10) |
| Kafede `ayarlar.env` / `.env` | `LAFPOS_CLOUD_URL=https://lafpos.vercel.app`, `LAFPOS_CLOUD_SECRET` (Vercel'dekiyle aynı) |
| Vercel › lafpos › Environment Variables (Yemeksepeti) | `YEMEKSEPETI_PLUGIN_SECRET` (Delivery Hero'nun verdiği JWT anahtarı), isteğe bağlı `YEMEKSEPETI_<ŞUBE>_REMOTE_ID` (eski öneksiz `YEMEKSEPETI_REMOTE_ID` de sayılır; tanımlı her restoranın kendi gelen kutusu olur); aktarıcı `docs/PAKET-PLATFORMLARI.md` |
| Vercel › lafpos › Environment Variables (Getir) | `GETIR_WEBHOOK_SECRET` (bizim ürettiğimiz, en az 16 karakter, `LAFPOS_CLOUD_SECRET`'ten ve Yemeksepeti anahtarından ayrı, ör. `openssl rand -hex 24`; Getir'e `x-api-key` olarak sipariş ve iptal adresleriyle birlikte verilir), isteğe bağlı `GETIR_<ŞUBE>_RESTAURANT_ID` (eski öneksiz `GETIR_RESTAURANT_ID` de sayılır; tanımlı her restoranın kendi gelen kutusu olur); aktarıcı `docs/PAKET-PLATFORMLARI.md` |

**İlk etapta parolasız** (27 Ekim 2026 kararı): `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` yokken kafe bağlıyken de giriş parola
sormaz; bağlantıyı bilen herkes gerçek ciroyu ve personel adlarını salt okunur görür. Gerçek kullanıma geçmeden
parolayı açın.

Vercel yalnız `main`'i dağıtır: `vercel.json` `git.deploymentEnabled` `claude/**` dallarına önizleme açmaz (26 Ekim
2026: ekip Hobby planın 24 saatte 100 dağıtım sınırına takıldı ve canlı dağıtımlar da reddedildi). Dalda değişiklik
yerelde `npm run build` ile denenir.

Neden kasa Neon'a taşınmadı: kasa internet kesilince de çalışmalı; Neon'un ücretsiz planındaki aylık işlem süresi
açık saatler boyunca uyanık bir veritabanına yetmez ve lafmaliyet'in veritabanını da durdururdu. Kalıcı geçmiş gün
sonunda lafmaliyet'e (Neon) gider; anlık görünüm için Redis yeterli ve ucuz. Parola denemesi IP başına 15 dakikada 8.
Durum: Yönetim › Ağ ve uzaktan erişim › LafPOS Uzaktan. Giriş ekranı kurulumu baştan sorar (`GET
/api/uzaktan/kurulum`, yalnız var/yok döner): eksik adım varsa parola alanı yerine kontrol listesi görünür.

**Tek komutla kurulum** (operatörün Mac'inde, Vercel CLI girişiyle): `scripts/vercel/baglanti-kur.sh`. Üç ortak
anahtarı üretir ve Vercel'e yazar (laffogato ve lafmaliyet'e `LAFPOS_SYNC_SECRET`, lafpos'a `LAFPOS_CLOUD_SECRET`),
parolayı sorar (tanımlıysa dokunmaz), Upstash Redis'i ekler (koşulları operatör onaylar), üç projenin main'den gelen
son üretim dağıtımını yeniden derler ve kafe bilgisayarına girecek satırları `~/Downloads/lafpos-kasa-ayarlari.env`
dosyasına yazar (izin 600; lafmaliyet ve Uzaktan satırları 1. adım, site satırları kurulum modu kapandıktan sonra 2.
adım başlığıyla, `docs/03-ENTEGRASYON.md` §8). Anahtarlar ekrana basılmaz; tanımlı bir değişkene `--yenile` olmadan dokunmaz.

## 5. Sorun giderme

| Belirti | Bakılacak yer |
|---|---|
| Kartta "Kurulmadı" | Kasa bilgisayarında Tailscale kurulu ve girişli mi; sayfa 15 sn'de bir yenilenir |
| Telefonda sayfa açılmıyor | Telefonda Tailscale açık mı, iki cihaz aynı hesapta mı; Tailscale uygulamasında kasa bilgisayarı "Connected" mı |
| Kafede açılıyor, dışarıda açılmıyor | Kasa bilgisayarı uykuda olabilir: Windows kurulumundaki "Prizdeyken uyku kapalı" seçeneği |
| "Bu işlem için yetkiniz yok" | Uzaktan da rol yetkileri geçerli (Yönetim › Roller ve yetkiler) |
| LafPOS Uzaktan "Kafeden henüz veri gelmedi" | Kafede `LAFPOS_CLOUD_URL` ve `LAFPOS_CLOUD_SECRET`, Vercel'de aynı anahtar; Yönetim › Ağ'daki son hata |
| LafPOS Uzaktan "Upstash Redis bağlı değil" | Vercel › lafpos › Storage'dan Upstash Redis ekleyip yeniden yayınlayın |

Kod: adresler `server/lib/network.ts`, sayfa `src/pages/admin/NetworkAdmin.tsx`, bulut `api/uzaktan.ts`, `server/sync/cloud.ts` ve `server/sync/cloud-reports.ts`; testler `tests/network.test.ts`, `tests/cloud-api.test.ts`, `tests/uzaktan-raporlar.test.ts`.

## Geçmiş ciro (LafPOS'tan önceki kasa programı)

Dükkân LafPOS'a geçmeden önceki günlerini (ör. ModPOS) kaybetmesin diye o günler raporlarda görünür
(`shared/gecmis.ts`). İki kaynak var:

1. **lafmaliyet (asıl kaynak):** kasa ModPOS dönemini lafmaliyet'ten çeker (`GET /api/panel/pos/modpos-gunler`,
   docs/03-ENTEGRASYON.md §4.5): ciro, ödeme türleri, indirim, ciro dışı (ödenmez ve ikram), KDV (oran oran, geldiği
   gibi), ModPOS Z numarası ve dönemin ürün listesi. Yalnız föyden gelen günde indirim bilinmez: raporlar ₺0 değil "N
   ModPOS gününde bilinmiyor" der. İş günü başına bir kez kendiliğinden, Yönetim › Site ve lafmaliyet › "ModPOS dönemini
   çek" ile elle. Kasada `sync_state` `lafmaliyet.modpos`.
2. **Merkez (elle yüklenen, eski yol):** `POST merkez/gecmis` (yalnız panelin sahibi; ekranı yok). Kayıt dükkân başına
   tek anahtarda (`lafpos:gecmis:<kurulum>`); Merkez nabzıyla kasaya da gelir (yalnız değişince; kasa elindekinin anını
   `gecmisAt` ile söyler, kaynağın adını taşımayan eski kopyası için -1 söyler: kayıt bir kez adıyla yeniden gelir, Merkez'de
   silinmişse kopya da silinir), kasada `sync_state` `merkez.gecmis`.

Kasa ikisini birleştirir (aynı tarihte lafmaliyet'inki geçer; `mergeHistory`, `server/sync/modpos.ts` `historyStore`):

- **Kasanın kendi ekranları:** patron panelinin kıyası ve Raporlar › Ciro, Ürünler, Saatlik o günleri görür. Günler
  "ModPOS" etiketli (günlük grafiğin ipucunda ModPOS Z'siyle), ciro dökümüne indirimi, ciro dışı ve KDV'siyle girer;
  ürün listesi Ürünler'de ayrı "ModPOS · indirim öncesi" kartı (yalnız dönemin hepsi seçiliyse; bir kısmı seçiliyse not;
  LafPOS ürün cirosuna eklenmez); İndirim ve İkram listeleri ModPOS günlerinin toplamını, İptal, Happy hour ve
  Adisyonlar yalnız notu söyler (kalem ve adisyon kaydı yok; Adisyonlar fiş sayısını yazar). Saatlik'e kapanış dakikası
  olmayan gün girmez (gün sayısına ve haftanın günü ortalamasına da); Paket platformlarının payı LafPOS günlerinin
  cirosundandır. Bugünü içeren dönemin "aynı saate kadar" kıyasında kesimden önce biten geçmiş günü bütün sayılır, kesimi
  içeren gün kapanış dakikalarıyla (dakikası olmayan ModPOS günü orada sayılmaz); Uzaktan'ın `salesUntil`'i de aynı
  kuralla. Geçmiş günü yalnız LafPOS'ta gerçek iş günü olmayan tarihte geçer; gerçek kullanımda deneme günlerinin
  yerine geçer (`server/services/gecmis.ts` `historyFor`) ve o deneme günlerinin adisyonları hiçbir sekmede (İndirim,
  İkram, Adisyonlar, İade, Hazırlama, Personel, Paket platformları, CSV) okunmaz. Z raporu, Kasa › Geçmiş günler, iş
  günü, Z zinciri ve lafmaliyet'e giden gün paketi geçmişi hiç görmez.
- **LafPOS Uzaktan:** kasa bu günleri kendi dükkân kimliğiyle gün raporu olarak iter (`server/sync/cloud-reports.ts`,
  `historyReport`: kaynak ve `zText` alanlarıyla; bulut ikisini kısa metin olarak doğrular). Yalnız LafPOS'ta gerçek iş
  günü olmayan tarihte ve içerik değişince gider (kayıt ya da geçmişin geçtiği tarihler değişince, ör. kurulum modundan
  çıkınca deneme gününün yerine geçmiş geçer, bütün geçmiş günlerine bir kez bakılır; gün özeti aynıysa gitmez). Dönemin
  ürün listesi `urunler` alanında gider: bloğun dönemindeki her geçmiş günü dönemi ve dönemin geçmiş günü sayısını (`n`)
  taşır, satırları yalnız bloğun son geçmiş günü (liste her gün anahtarında kopyalanmaz: 400 gün × 500 satır uzun dönemin
  MGET'ini şişirirdi; bulut biçimini doğrular). Uzaktan Ürünler bloğu, seçilen dönem onu kapsıyor, `n` günün hepsi ve
  satırları taşıyan gün raporda duruyorsa ürün ürün gösterir, değilse not. lafmaliyet'te silinen ya da başka güne taşınan gün Uzaktan'da kalmaz: önceki bakışta
  geçmiş günü olarak giden tarih kayıttan çıkınca yerine satışsız gün raporu (`n: 0`; o tarihte artık LafPOS günü varsa
  onun raporu) gider. Böylece geçmiş bulutta başka bir dükkânın anahtarında dursa ya da hiç yüklenmemiş olsa da "Geçen
  hafta" ModPOS günlerini gösterir; "Denemeyi bitir"den önce itilmiş eski deneme raporunun yerine geçer (yeni an).
- **Buluttaki elle yüklenmiş kayıt** yine okunur: aynı tarihte LafPOS'un da gün raporu varsa cirosu büyük olan geçer
  (geçiş gününde LafPOS'ta yalnız deneme satışı olur); iki kaynak toplanmaz. Ek Redis komutu yok: kayıt gün raporlarıyla
  aynı MGET'te okunur; yeni kasanın özetinde yalnız geçmişi olan dükkânda, işlev örneği başına bir kez. Patron panelinin
  ETag'i geçmişin yükleme anını taşır (yeni yükleme 304'ün arkasında kalmaz).

Merkez gövdesi: `{ id, kaynak, gunler: [{ date, ciro, adisyon, kart?: [tutar, adet], nakit?, yemek?, indirim?, odenmez?,
kdv?: [[oran, dahil, matrah, kdv]], z?, closes?: [[dakika, kuruş, adisyon]] }] }` (tutarlar kuruş, dakika 05:00'ten;
KDV dahil toplamı ciroyu, matrah + KDV dahili tutmalı; KDV verilmezse %10 sayılır; Z en çok 40 karakter). Boş `gunler`
kaydı siler.
