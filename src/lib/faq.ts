import type { Permission } from '@shared/permissions';

/**
 * Sık sorulan sorular (`/yardim`): kasadaki kişinin ve yöneticinin gerçekten sorduğu sorular. Yanıtlar yalnız kodun ve
 * `docs/`'un anlattığını söyler (02-PLAN, 03-ENTEGRASYON, 04-YAZARKASA, 05-KASA-BILGISAYARI, 07-UZAKTAN-ERISIM;
 * yapılmamışlar KALANLAR.md'de): olmayan özellik yazılmaz.
 *
 * Ekrandaki düğme ve menü adları `[[…]]` içinde, yol `›` ile (`[[Yönetim › Personel]]`); sayfa onları etiket gibi çizer.
 * `tests/sss.test.ts` her adın arayüzde gerçekten yazdığını denetler: düğmenin adı değişirse test düşer, yanıt düzeltilir.
 *
 * Rol gözetilir: her soru yalnız işi o kişiye düşene görünür (`show`), maliyet ve kâr yalnız `rapor.maliyet`, kasa
 * rakamları yalnız onları gören (`seesCash`: sunucuyla aynı kural, kasa.rakam ya da rapor.gor) olana anlatılır; gerisi
 * kör kasadır. Yanıtta hiçbir zaman verinin kendisi (tutar) yazmaz.
 * Saf modül: React ve tarayıcı yok, testler doğrudan okur.
 */

export interface FaqContext {
  can: (p: Permission) => boolean;
  /** Ödeme ekranında bahşiş alanı açık mı (ayarlarda `tipsEnabled`) */
  tips: boolean;
  /** Bar ekranı ve "Bara gönder" açık mı (ayarlarda `barEnabled`) */
  bar: boolean;
}

export const FAQ_GROUPS = [
  { key: 'gun', label: 'Gün ve kasa' },
  { key: 'satis', label: 'Satış ve ödeme' },
  { key: 'siparis', label: 'Bar ve siparişler' },
  { key: 'cihaz', label: 'Cihaz ve internet' },
  { key: 'ekip', label: 'Ekip, yetki ve raporlar' },
] as const;

export type FaqGroup = (typeof FAQ_GROUPS)[number]['key'];

export interface FaqItem {
  id: string;
  group: FaqGroup;
  question: string;
  /** Düz metin; ekrandaki adlar `[[…]]` içinde */
  answer: string;
}

interface Entry {
  id: string;
  group: FaqGroup;
  question: string | ((c: FaqContext) => string);
  answer: (c: FaqContext) => string;
  show: (c: FaqContext) => boolean;
}

const any =
  (...perms: Permission[]) =>
  (c: FaqContext) =>
    perms.some((p) => c.can(p));
const all = () => true;
/** Kasa rakamlarını (ara rapor, beklenen nakit, Z özeti) görür mü: sunucunun `seesCashNumbers` kuralı (server/lib/auth.ts) */
const seesCash = (c: FaqContext) => c.can('kasa.rakam') || c.can('rapor.gor');

const ENTRIES: Entry[] = [
  // ——— Gün ve kasa
  {
    id: 'gun-ac',
    group: 'gun',
    show: any('kasa.gun'),
    question: 'Günü nasıl açarım?',
    answer: (c) =>
      seesCash(c)
        ? '[[Kasa]] ekranında çekmecedeki açılış nakdini sayıp yazın ve [[Günü aç]]’a basın. Önceki günün devri [[Beklenen açılış]] olarak görünür; tutuyorsa [[Bu tutarı yaz]] yeter. Sayım devirden farklıysa [[Farkın nedeni]] istenir.'
        : '[[Kasa]] ekranında çekmecedeki açılış nakdini sayıp yazın ve [[Günü aç]]’a basın. Tutar önceki günün devriyle karşılaştırılır; fark varsa [[Farkın nedeni]] istenir.',
  },
  {
    id: 'gun-sonu',
    group: 'gun',
    show: any('kasa.gun'),
    question: 'Gün sonunu (Z) nasıl alırım?',
    // Kör kasada sunucu Z özetini göndermez (server/routes/cash.ts): kasa yalnız "Gün kapandı" bildirimini gösterir
    answer: (c) =>
      `[[Kasa]] ekranında [[Gün sonu (Z)]]’ye basın. Pencerenin başında [[Kayda geçecekler]] ayrıntılı gün sonunun neyi kaydettiğini söyler (satışlar, ödeme türleri, kasa hareketleri, sayım); sonra [[Gün sonu adımları]]’nı sırayla yapın: açık adisyon kalmasın, banka POS’unun ve yemek kartı cihazlarının slip toplamlarını girin, çekmecedeki nakdi sayın, sonra [[Günü kapat]]. Kapanış saati ayarlıysa kapanışa 30 dakika kala sağ altta [[Gün sonu al]] bildirimi çıkar. ${
        seesCash(c)
          ? 'Ayrıntılı Z raporu ekranda açılır, özeti üstte; Yazdır ile basılır.'
          : 'Rolünüzde kör kasa açık: gün kapanınca Z numarası bildirimde yazar, Z raporu ve sayım farkı yöneticinin ekranında görünür.'
      } Bilgisayarı sonra en az 10 dakika açık ve internete bağlı bırakın: güncellemeler gün sonundan sonra kendiliğinden kurulur.`,
  },
  {
    id: 'gun-yeniden',
    group: 'gun',
    show: any('kasa.gun'),
    question: 'Gün sonundan sonra müşteri geldi, ne yapmalıyım?',
    answer: () =>
      'Gece 05:00’e kadarki satışlar aynı güne yazılır. Z alındıysa [[Kasa]] ekranında nedenini yazıp [[Günü yeniden aç]]’a basın; yetkili onayı ister, Z numarası değişmez. Gün yeniden kapanınca Z raporu ve lafmaliyet’teki kayıt güncellenir.',
  },
  {
    id: 'pavo-gun-sonu',
    group: 'gun',
    show: any('kasa.gun'),
    question: 'Pavo’nun banka gün sonunu ayrıca almam gerekir mi?',
    answer: (c) =>
      `Hayır. Pavo bağlıysa LafPOS’ta günü kapatınca cihaz bankaların gün sonunu kendiliğinden alır ve slibini basar ([[Gün kapanınca cihazda gün sonu al]] açıkken; varsayılan açık). Cihaz yanıt vermese de LafPOS’un günü kapanır. ${
        c.can('ayar.yonet')
          ? 'Gerekirse [[Yönetim › Yazarkasa POS › Gün sonu (banka)]]’dan [[Cihazda gün sonu al]] ile elle alınır, kâğıt çıkmadıysa [[Kâğıdı yeniden bas]].'
          : 'Gerekirse yönetici cihazın gün sonunu yönetimden elle alır.'
      }`,
  },
  {
    id: 'vardiya',
    group: 'gun',
    show: any('kasa.gun'),
    question: 'Vardiya değişirken ne yapmalıyım?',
    answer: () =>
      '[[Kasa]] ekranında [[Vardiya devri]]’ne basın, çekmeceyi sayın, [[Devralan]]’ı seçip PIN’ini girdirin. Bu bir ara sayımdır, gün sonu değildir: gün açık kalır.',
  },
  {
    id: 'kasa-rakam',
    group: 'gun',
    show: any('kasa.gun', 'kasa.hareket', 'odeme.al'),
    question: (c) => (seesCash(c) ? 'Gün içinde kasada ne kadar olmalı?' : 'Kasa ekranında rakamları neden göremiyorum?'),
    answer: (c) =>
      seesCash(c)
        ? '[[Kasa]] ekranındaki [[Ara rapor (X)]] günün o anki satışını, ödeme türlerini ve beklenen nakdi gösterir. Çekmece yalnız [[Vardiya devri]]’nde ve gün sonunda sayılır.'
        : 'Rolünüzde kör kasa açık: ara rapor ve kasa rakamları gizlidir. Gün sonunda ve vardiya devrinde çekmeceyi sayıp girersiniz; farkı yönetici görür.',
  },
  {
    id: 'kasa-hareketi',
    group: 'gun',
    show: any('kasa.hareket'),
    question: 'Kasadan para çıkınca ya da kasaya para girince ne yapmalıyım?',
    answer: (c) =>
      `[[Kasa]] ekranında masraf için [[Harcama]], patrona ya da bankaya verilen nakit için [[Teslim]], bozuk para gibi eklenen nakit için [[Kasaya giriş]]’e basın; tutarı ve açıklamayı yazın. Teslimde paranın kime verildiğini [[Kime]]’den seçin (Banka ya da Başka da olur); Z raporu teslimi kişi kişi döker. Her hareket denetim kaydına yazılır${seesCash(c) ? ', beklenen nakde işlenir' : ''} ve gün sonunda ladmin’e (lafmaliyet) satır satır gider.`,
  },

  // ——— Satış ve ödeme
  {
    id: 'hesap-bol',
    group: 'satis',
    show: any('odeme.al'),
    question: 'Hesabı nasıl bölerim?',
    answer: (c) =>
      `[[Öde]]’ye basın: [[Tutar]] ile istediğiniz kadarını, [[Kalem seç]] ile kişinin kalemlerini, [[Paylaş]] ile eşit ya da kişi kişi payları alın. Her parçayı ayrı türle (biraz nakit, biraz kart) alabilirsiniz; kalan ekranda yazar, nakitte [[Verilen]]’i yazınca [[Para üstü]] görünür.${c.can('masa.islem') ? ' Kalemleri ayrı bir adisyona almak için [[Böl]].' : ''}`,
  },
  {
    id: 'bahsis',
    group: 'satis',
    show: any('odeme.al'),
    question: 'Bahşişi nasıl girerim?',
    answer: (c) =>
      c.tips
        ? '[[Öde]] ekranında “Bahşiş ekle”ye dokunup tutarı yazın. Bahşiş ciroya girmez, ayrı raporlanır; açık hesaba bahşiş yazılmaz.'
        : 'Bu kasada bahşiş kapalı (varsayılan): ödeme ekranında bahşiş alanı yoktur. Açıldığında bahşiş ciroya girmez, ayrı raporlanır.',
  },
  {
    id: 'ikram',
    group: 'satis',
    show: any('siparis.al', 'odeme.al'),
    question: 'İkram, ödenmez ve zayi arasındaki fark ne?',
    answer: () =>
      'Üçü de ücret almadan kapatır ve denetim kaydına yazılır. [[İkram]] müşteriye ikramdır; [[Ödenmez]] personel yemeği ya da patron hesabı gibi kayıtlı bir kişinin adına yazılır; [[Zayi]] dökülen, yanlış hazırlanan ya da bozulan üründür. Tek kalem için satıra dokunun, bütün adisyon için [[Öde › Ciro dışı kapat]]. Yetkiniz yoksa yetkili onayı istenir.',
  },
  {
    id: 'iptal',
    group: 'satis',
    show: any('siparis.al'),
    question: 'Yanlış girilen ürünü nasıl silerim?',
    answer: (c) =>
      `${c.bar ? 'Bara gönderilmemiş' : 'Kaydedilmemiş'} kalemi adisyonda adetten azaltın ya da silin. ${c.bar ? 'Bara gitmiş' : 'Kaydedilmiş'} kalemde satıra dokunup [[İptal et]]’e basın ve nedenini yazın; iptal denetim kaydına girer, yetkiniz yoksa yetkili onayı istenir.`,
  },
  {
    id: 'iade',
    group: 'satis',
    show: any('odeme.al'),
    question: 'Kapanmış adisyonda iade nasıl yapılır?',
    answer: () =>
      '[[Siparişler › Kapanan]]’da adisyonu açıp [[Kalem iade et]]’e basın, iade edilecek kalemi seçip nedenini yazın; [[Geri verilecek]] tutar ekranda yazar. Adisyonu baştan düzeltmek gerekirse [[İşlemler › Yeniden aç]]; ikisi de yetkili onayı isteyebilir.',
  },
  {
    id: 'odeme-duzelt',
    group: 'satis',
    show: any('odeme.al'),
    question: 'Ödemeyi yanlış türden aldım, nasıl düzeltirim?',
    answer: () => '[[İşlemler › Alınan ödemeler]]’de ödemenin yanındaki [[Ödemeyi iptal et]]’e basıp nedenini yazın, sonra doğru türle yeniden alın. Ödeme iptali denetim kaydına girer.',
  },
  {
    id: 'indirim',
    group: 'satis',
    show: any('siparis.al'),
    question: 'İndirim nasıl yapılır?',
    answer: () =>
      'Bütün adisyona [[İndirim]], tek kaleme satıra dokunup [[Kaleme indirim]]. Yüzde ya da tutar yazıp nedeni seçin; hazır bir neden seçerseniz yüzdesi kendiliğinden yazılır. Kişinin indirim sınırını aşan indirim yetkili onayı ister.',
  },
  {
    id: 'acik-hesap',
    group: 'satis',
    show: any('cari.yonet'),
    question: 'Veresiye (açık hesap) nasıl yazılır?',
    answer: () =>
      'Adisyonda [[Müşteri ekle]] ile müşteriyi seçin, [[Öde]]’de açık hesap türüyle kapatın; tutar müşterinin hesabına borç yazılır. Müşterinin sınırı aşılıyorsa uyarı çıkar. Bakiye ve tahsilat [[Müşteriler]] ekranında.',
  },
  {
    id: 'yetkili-onay',
    group: 'satis',
    show: any('siparis.al', 'odeme.al'),
    question: 'Yetkim olmayan bir işlemde ne olur?',
    answer: (c) =>
      `[[Yetkili onayı]] penceresi açılır: yetkisi olan kişi (müdür ya da patron) PIN’ini girer, işlem o an yapılır ve iki kişi de denetim kaydına yazılır.${c.can('ayar.yonet') || c.can('patron.panel') ? ' Kim neyi iptal etti, ikram etti ya da indirdi: [[Yönetim › Denetim kaydı]].' : ''}`,
  },

  // ——— Bar ve siparişler
  {
    id: 'bara-gonder',
    group: 'siparis',
    show: any('siparis.al'),
    question: (c) => (c.bar ? 'Sipariş bara nasıl gider?' : 'Sipariş neden bara gitmiyor?'),
    answer: (c) =>
      c.bar
        ? 'Ürünleri ekleyip [[Bara gönder]]’e basın; bar ekranına fiş düşer. Bar hazırlayınca adisyonda hazır kalem yeşil görünür.'
        : 'Bu kasada bar ekranı kapalı: adisyonda [[Bara gönder]] yerine [[Kaydet]] çıkar ve sipariş bara gitmez. Açılıp kapanması yönetimin ayarıdır.',
  },
  {
    id: 'bar-ekrani',
    group: 'siparis',
    show: (c) => c.bar && c.can('mutfak.ekran'),
    question: 'Bar ekranında fiş nasıl biter?',
    answer: () => 'Fişte [[Başla]] ile hazırlamaya geçin, bitince [[Hepsi hazır]]’a basın; fiş [[Hazır]] sekmesine geçer. Süresi uzayan fiş önce ambere, sonra kırmızıya döner.',
  },
  {
    id: 'online',
    group: 'siparis',
    show: any('siparis.al', 'paket.yonet'),
    question: 'Siteden gelen online siparişte ödeme alınır mı?',
    answer: () =>
      'Hayır. Sitedeki sipariş sitede ödenmiştir: [[Sitede ödendi]] yazar, kasada tahsil edilmez ve lafmaliyet’in satış listesine girmez. Gelince zil çalar ve üstte şerit çıkar; [[Gördüm]] bu cihazdaki zili susturur, sipariş [[Siparişler › Online]]’da durur.',
  },
  {
    id: 'platform',
    group: 'siparis',
    show: any('paket.yonet', 'siparis.al'),
    question: 'Yemeksepeti, Getir ya da Trendyol Go siparişi gelince ne yapmalıyım?',
    answer: () =>
      'Üstte [[Platform siparişi onay bekliyor]] şeridi çıkar. [[Gör]]’e basın, [[Hazırlık]] süresini seçip kabul edin ya da nedenini seçip [[Reddet]]’e basın. Kabul edilen sipariş adisyon olarak açılır.',
  },
  {
    id: 'tukendi',
    group: 'siparis',
    show: any('urun.tukendi'),
    question: 'Biten ürünü nasıl tükendi yaparım?',
    answer: () =>
      'Bar ekranında [[Tükendi]]’ye ya da adisyonda [[İşlemler › Tükenen ürünler]]’e basın; ürünü ya da yulaf sütü gibi bir seçeneği işaretleyin. Gelince aynı yerden [[Satışa aç]]. İnternet yokken de kasada hemen geçerlidir, site internet gelince güncellenir.',
  },

  // ——— Cihaz ve internet
  {
    id: 'internet',
    group: 'cihaz',
    show: all,
    question: 'İnternet giderse satış durur mu?',
    answer: () =>
      'Hayır. Kasa kendi bilgisayarında çalışır: satış, masa, ödeme ve Pavo internetsiz sürer. Dışarı gidecek kayıtlar (lafmaliyet gün sonu, sitenin Tükendi bilgisi, Uzaktan özeti) bekler; üstte “İnternet yok · N kayıt bekliyor” yazar. İnternet gelince kendiliğinden gönderilir ve [[Bekleyenler gönderildi]] görünür. Tablet kasaya ulaşamazsa da sipariş bekletilir, bağlantı gelince bir kez gönderilir.',
  },
  {
    id: 'yazarkasa',
    group: 'cihaz',
    show: any('odeme.al'),
    question: 'Ödemede yazarkasa ne yapar?',
    answer: () =>
      'Pavo bağlıysa ödeme yazarkasaya gider: ödemeyi cihazdan alırsınız, mali fişi cihaz keser. Müşteri cihazda vazgeçerse ya da cihaz ödemeyi almazsa LafPOS ödemeyi kaydetmez; [[Yeniden dene]] ya da başka yoldan alın.',
  },
  {
    id: 'yazici',
    group: 'cihaz',
    show: any('ayar.yonet'),
    question: 'Fiş yazıcısını nasıl tanıtırım?',
    answer: () =>
      'Yazıcıyı USB ile takıp sürücüsünü kurun, kasa ekranını kapatıp açın. Yazıcı [[Yönetim › Ayarlar ve yedek › Fiş yazıcısı]]’nda görünür; [[Deneme fişi yazdır]] ile deneyin.',
  },
  {
    id: 'kilit',
    group: 'cihaz',
    show: all,
    question: 'Kasadan ayrılırken ne yapmalıyım?',
    answer: (c) =>
      `[[Araçlar › Ekranı kilitle]]: oturum kapanır, sıradaki kişi PIN’iyle girer.${c.can('ayar.yonet') ? ' Kasa dokunulmadan beklerse kendiliğinden kilitlenmesi için [[Yönetim › Ayarlar ve yedek]]’te [[Otomatik kilit (dk)]] süresini yazın.' : ''}`,
  },

  // ——— Ekip, yetki ve raporlar
  {
    id: 'pin',
    group: 'ekip',
    show: all,
    question: 'PIN’imi unuttum, ne yapmalıyım?',
    answer: (c) =>
      c.can('personel.yonet')
        ? '[[Yönetim › Personel]]’de kişiyi açıp yeni PIN verin; kişi o PIN’le girer.'
        : 'PIN’i personel yönetimi yetkisi olan kişi (patron) [[Yönetim › Personel]]’den yeniler; ondan yeni PIN isteyin.',
  },
  {
    id: 'roller',
    group: 'ekip',
    show: any('personel.yonet'),
    question: 'Kimin neyi yapabileceğini nereden ayarlarım?',
    answer: (c) =>
      `[[Yönetim › Roller ve yetkiler]]’de rol başına yetki seti (kör kasa ve kasadan tükendi dahil), [[Yönetim › Personel]]’de kişiye özel yetki ve indirim sınırı. Patron rolü kilitlidir, her şeyi yapar.${c.can('rapor.maliyet') ? ' Personel varsayılan olarak maliyet ve kârı görmez.' : ''}`,
  },
  {
    id: 'maliyet',
    group: 'ekip',
    show: any('rapor.maliyet'),
    question: 'Ürünlerin maliyeti ve kârı nerede?',
    answer: () =>
      '[[Raporlar › Ürünler]]’deki [[Brüt kâr]] sütununda ve patron panelinin en çok satanlarında. Maliyetler lafmaliyet’teki reçetelerden gelir; reçetesi girilmemiş üründe kâr yazmaz. Bu rakamları yalnız maliyet yetkisi olanlar görür.',
  },
  {
    id: 'lafmaliyet',
    group: 'ekip',
    show: any('rapor.gor', 'senkron.yonet'),
    question: 'lafmaliyet’e ne gider?',
    answer: (c) =>
      `Gün sonunda günün Z özeti, ürün satış listesi, kasa hareketleri ve o gün çalışanlar gider. Sitede ödenmiş online siparişler satış listesine girmez. İnternet yoksa kayıt bekler, gelince gider; gün yeniden açılıp kapanırsa ya da yeniden sayılırsa aynı gün yeniden gönderilir. ${
        c.can('senkron.yonet') || c.can('ayar.yonet') ? 'Gönderimin durumu [[Yönetim › Site ve lafmaliyet]]’te.' : 'Satış listesi [[Raporlar › lafmaliyet aktarımı]]’nda.'
      }`,
  },
  {
    id: 'uzaktan',
    group: 'ekip',
    show: any('patron.panel'),
    question: 'Kafede değilken rakamlara nasıl bakarım?',
    answer: (c) =>
      `LafPOS Uzaktan’dan (lafpos.laffogato.net): telefonun tarayıcısından girersiniz; patron paneli, masalar, bar kuyruğu ve raporlar kasadan gelen özetle görünür, işlem yapılmaz.${c.can('rapor.maliyet') ? ' Maliyet ve kâr, PIN’ler ve müşteri telefonları buluta gitmez.' : ' PIN’ler ve müşteri telefonları buluta gitmez.'}`,
  },
];

/** Kişiye görünen sorular, grup sırasıyla */
export function faqFor(c: FaqContext): FaqItem[] {
  const order = FAQ_GROUPS.map((g) => g.key);
  return ENTRIES.filter((e) => e.show(c))
    .map((e) => ({ id: e.id, group: e.group, question: typeof e.question === 'function' ? e.question(c) : e.question, answer: e.answer(c) }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** Yanıtı düz metin ve ekran adı parçalarına böler: `[[Kasa › Günü aç]]` → { label: ['Kasa', 'Günü aç'] } */
export type AnswerPart = { text: string } | { label: string[] };
export function answerParts(answer: string): AnswerPart[] {
  const out: AnswerPart[] = [];
  let at = 0;
  for (const m of answer.matchAll(/\[\[(.+?)\]\]/g)) {
    if (m.index > at) out.push({ text: answer.slice(at, m.index) });
    out.push({ label: m[1]!.split('›').map((s) => s.trim()) });
    at = m.index + m[0].length;
  }
  if (at < answer.length) out.push({ text: answer.slice(at) });
  return out;
}

/** Yanıtın düz yazısı (arama ve ekran okuyucu): etiketler `›` ile */
export const answerText = (answer: string) => answer.replace(/\[\[(.+?)\]\]/g, (_, l: string) => l);
