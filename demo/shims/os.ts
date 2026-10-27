/** Tarayıcı demosunda `node:os`: ağ kartı yok (Cihaz ekranı adres göstermez) */
export function hostname(): string {
  return 'lafpos-demo';
}

export function networkInterfaces(): Record<string, never[]> {
  return {};
}

export default { hostname, networkInterfaces };
