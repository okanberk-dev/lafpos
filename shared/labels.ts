/** Ekrandaki adlar: sunucunun raporları ve arayüz aynı adı yazsın */
export const ORDER_TYPE_LABEL = { masa: 'Masa', tezgah: 'Tezgâh', gelal: 'Gel-al', paket: 'Paket', online: 'Online' } as const satisfies Record<
  'masa' | 'tezgah' | 'gelal' | 'paket' | 'online',
  string
>;
