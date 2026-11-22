/**
 * Ayarların Türkçe adları (Yönetim › Ayarlar'daki alanların adı): sunucu "ayarları değiştirdi" denetim kaydını bu
 * adlarla yazar, Denetim kaydı ekranı kod adıyla yazılmış eski kayıtları da bununla okur. Yeni ayar eklenince adı
 * buraya da yazılır; adı olmayan ayar kod adıyla görünür.
 */
export const SETTING_LABEL: Record<string, string> = {
  businessName: 'İşletme adı',
  businessAddress: 'Adres',
  businessPhone: 'Telefon',
  receiptHeader: 'Fiş üstü',
  receiptFooter: 'Fiş altı',
  receiptCustomerName: 'Fişte müşteri adı',
  receiptStoreCopy: 'Ödeme sonrası işyeri nüshası',
  receiptInfoSlip: 'Müşteriye bilgi fişi',
  serviceRate: 'Servis ücreti',
  autoLockMinutes: 'Otomatik kilit',
  keepAwake: 'Ekran kararmasın',
  productImages: 'Ürün görselleri',
  askOptions: 'Seçenekleri sor',
  voidReasons: 'İptal nedenleri',
  compReasons: 'İkram nedenleri',
  odenmezReasons: 'Ödenmez nedenleri',
  zayiReasons: 'Zayi nedenleri',
  discountReasons: 'İndirim nedenleri',
  discountPresetPct: 'Hazır indirim yüzdesi',
  quickCash: 'Hızlı nakit',
  sizeLabels: 'Boy adları',
  requireDayOpen: 'Gün açık olmalı',
  kitchenWarnMinutes: 'Bar fişi uyarısı',
  kitchenAlarmMinutes: 'Bar fişi alarmı',
  roomBillingStepMinutes: 'Oda ücret adımı',
  roomMinimumMinutes: 'Oda en az süre',
  stampGoal: 'Damga hedefi',
  stampCategoryKeys: 'Damga kategorileri',
  demoMode: 'Kurulum modu',
  menuAutoSync: 'Otomatik menü eşitleme',
  onlineOrdersSync: 'Online sipariş çekme',
  posSizeSuffix: 'lafmaliyet boy ekleri',
  alertDiscountPct: 'İndirim uyarısı',
  alertCashDiffKurus: 'Kasa farkı alarmı',
  backupKeep: 'Yedek süresi',
  autoDayEnd: 'Otomatik gün sonu',
  branchId: 'Şube kimliği',
  autoDayEndHour: 'Gün sonu saati',
  serviceMode: 'Servis modu',
  tipsEnabled: 'Bahşiş',
  barEnabled: 'Bar ekranı ve Bara gönder',
  zNoStart: 'İlk Z numarası',
  customerDisplay: 'Müşteri ekranı',
  remoteControl: 'Uzaktan yönetim',
};

/** Ayarın Türkçe adı; adı yazılmamış ayar kod adıyla (yalnız haritanın kendi anahtarları: "toString" ad sayılmaz) */
export const settingLabel = (k: string): string => (Object.hasOwn(SETTING_LABEL, k) ? SETTING_LABEL[k] : k);
