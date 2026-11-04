/** Ekrandaki adlar: sunucunun raporları ve arayüz aynı adı yazsın */
export const ORDER_TYPE_LABEL = { masa: 'Masa', tezgah: 'Tezgâh', gelal: 'Gel-al', paket: 'Paket', online: 'Online' } as const satisfies Record<
  'masa' | 'tezgah' | 'gelal' | 'paket' | 'online',
  string
>;

/** Ödeme türünün komisyon kanalı: lafmaliyet'in komisyon anahtarları (lafmaliyet src/lib/commission/channels.ts) */
export const PAYMENT_CHANNELS = ['pluxee', 'multinet', 'edenred', 'setcard', 'metropol', 'yemeksepeti', 'trendyol', 'getir', 'migros'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

