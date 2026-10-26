import { hostname, networkInterfaces } from 'node:os';
import type { NetAddressDTO, NetworkInfoDTO } from '@shared/types';
import { env } from '../env';

/** Tailscale'in cihazlara verdiği IPv4 aralığı: 100.64.0.0/10 */
export function isTailscaleV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** Tabletin bağlanacağı adres sanal ağ kartında değildir (WSL, Hyper-V, VirtualBox, VMware, Docker) */
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|vboxnet|bridge/i;

/** Sunucunun dinlediği adresler: kafenin ağı ve Tailscale. Bağlantısız (169.254) ve iç adresler atlanır */
export function networkInfo(interfaces = networkInterfaces()): NetworkInfoDTO {
  const lan: NetAddressDTO[] = [];
  const tailscale: NetAddressDTO[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const n of list ?? []) {
      if (n.internal || n.family !== 'IPv4' || n.address.startsWith('169.254.')) continue;
      const item = { name, address: n.address, url: `http://${n.address}:${env.port}` };
      (isTailscaleV4(n.address) ? tailscale : lan).push(item);
    }
  }
  lan.sort((x, y) => Number(VIRTUAL.test(x.name)) - Number(VIRTUAL.test(y.name)));
  return { hostname: hostname(), port: env.port, loopbackOnly: ['127.0.0.1', 'localhost', '::1'].includes(env.host), lan, tailscale };
}
