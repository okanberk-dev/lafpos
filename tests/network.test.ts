import type { NetworkInterfaceInfo } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkInfoDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** Yönetim › Ağ ve uzaktan erişim: tabletin yerel adresi ve Tailscale ile dışarıdan erişim */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
  ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`, ...extra }) as NetworkInterfaceInfo;

describe('ağ adresleri', () => {
  it('Tailscale aralığı 100.64.0.0/10', async () => {
    const { isTailscaleV4 } = await import('../server/lib/network');
    expect(['100.64.0.0', '100.101.7.9', '100.127.255.255'].map(isTailscaleV4)).toEqual([true, true, true]);
    expect(['100.63.255.255', '100.128.0.1', '192.168.1.20', '10.100.64.1'].map(isTailscaleV4)).toEqual([false, false, false, false]);
  });

  it('kafenin ağı önce, sanal kartlar sonda; bağlantısız ve iç adresler yok', async () => {
    const { networkInfo } = await import('../server/lib/network');
    const info = networkInfo({
      'vEthernet (WSL)': [nic('172.20.48.1')],
      'Wi-Fi': [nic('192.168.1.20'), { ...nic('fe80::1'), family: 'IPv6' } as NetworkInterfaceInfo],
      Tailscale: [nic('100.101.7.9')],
      'Ethernet 2': [nic('169.254.10.4')],
      'Loopback Pseudo-Interface 1': [nic('127.0.0.1', { internal: true })],
    });
    expect(info.lan.map((a) => a.name)).toEqual(['Wi-Fi', 'vEthernet (WSL)']);
    expect(info.lan[0].url).toBe(`http://192.168.1.20:${info.port}`);
    expect(info.tailscale).toEqual([{ name: 'Tailscale', address: '100.101.7.9', url: `http://100.101.7.9:${info.port}` }]);
  });

  it('patron ve müdür görür, garson göremez', async () => {
    const res = await h.ok<NetworkInfoDTO>('patron', 'GET', '/admin/network');
    expect(res).toMatchObject({ port: expect.any(Number), hostname: expect.any(String), loopbackOnly: false });
    expect(Array.isArray(res.lan) && Array.isArray(res.tailscale)).toBe(true);
    await h.ok('mudur', 'GET', '/admin/network');
    expect((await h.call('garson', 'GET', '/admin/network')).status).toBe(403);
  });
});
