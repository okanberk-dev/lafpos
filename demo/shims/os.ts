/** Tarayıcı demosunda `node:os`: ağ kartı yok (Cihaz ekranı adres göstermez) */
export function hostname(): string {
  return 'asilpos-demo';
}

export function networkInterfaces(): Record<string, never[]> {
  return {};
}

export default { hostname, networkInterfaces };
