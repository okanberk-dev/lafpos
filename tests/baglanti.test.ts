import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkConnValue, connField, parseEnvLines } from '@shared/baglanti';
import { applyEnvEdits, readEnvText } from '../server/lib/ayar-dosyasi';
import { type Harness, startApp } from './harness';
import { ALAN_ADI, ESKI_ENV_ONEKI } from '@shared/eski-adlar';

/**
 * Yönetim › Bağlantı bilgileri: dış sistemlerin adresleri ve anahtarları panelden ayarlar dosyasına (ayarlar.env)
 * yazılır. Dosyanın düzeni korunur, gizli değer arayüze ve denetim kaydına gitmez, yalnız patron yazar
 */

describe('ayarlar dosyasının düzenlenmesi', () => {
  const sample = '﻿# AsilPOS ayarları\r\nASILPOS_PORT=4000\r\n# LAFFOGATO_URL=https://laffogato.net\r\nLAFMALIYET_URL=https://eski.example.net\r\nLAFMALIYET_URL=https://tekrar.example.net\r\n';

  it('etkin satır yerinde değişir, tekrarı düşer; BOM ve CRLF korunur', () => {
    const out = applyEnvEdits(sample, { LAFMALIYET_URL: 'https://ladmin.laffogato.net' });
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toBe('﻿# AsilPOS ayarları\r\nASILPOS_PORT=4000\r\n# LAFFOGATO_URL=https://laffogato.net\r\nLAFMALIYET_URL=https://ladmin.laffogato.net\r\n');
  });

  it('yeni anahtar örnek dosyadaki yorumlu satırın altına, yoksa başlıkla sona eklenir; null satırı kaldırır', () => {
    const out = applyEnvEdits(sample, { LAFFOGATO_URL: 'https://laffogato.net', ASILPOS_CLOUD_SECRET: 'x'.repeat(32), LAFMALIYET_URL: null });
    expect(out.split('\r\n')).toEqual([
      '﻿# AsilPOS ayarları',
      'ASILPOS_PORT=4000',
      '# LAFFOGATO_URL=https://laffogato.net',
      'LAFFOGATO_URL=https://laffogato.net',
      '',
      '# Yönetim › Bağlantı bilgileri',
      `${ESKI_ENV_ONEKI}CLOUD_SECRET=${'x'.repeat(32)}`,
      '',
    ]);
    // Dosyada hiç olmayan kasa ayarı eski adla eklenir (eski sürüme dönülürse eski sunucu da okur; shared/pos-env.ts)
    expect(readEnvText(out)).toEqual({ ASILPOS_PORT: '4000', LAFFOGATO_URL: 'https://laffogato.net', [`${ESKI_ENV_ONEKI}CLOUD_SECRET`]: 'x'.repeat(32) });
    // İkinci yazımda başlık tekrarlanmaz
    const again = applyEnvEdits(out, { TOKENX_CLIENT_ID: 'abc' });
    expect(again.match(/Yönetim › Bağlantı bilgileri/g)).toHaveLength(1);
    expect(applyEnvEdits('', { LAFMALIYET_URL: 'https://a.example' })).toBe('# Yönetim › Bağlantı bilgileri\nLAFMALIYET_URL=https://a.example\n');
  });

  it('değer denetimi: adres http(s), gizli anahtarın en kısa boyu, boşluk ve satır sonu yok, boş değer kaldırır', () => {
    expect(checkConnValue(connField('LAFMALIYET_URL')!, ' https://ladmin.laffogato.net/ ')).toEqual({ value: 'https://ladmin.laffogato.net' });
    expect(checkConnValue(connField('LAFMALIYET_URL')!, 'ladmin.laffogato.net')).toHaveProperty('error');
    // Yönetim konsolunun adresi panel adresi olarak yazılamaz (konsol kasaya uç sunmaz); başka alanda engel yok
    expect(checkConnValue(connField('LAFMALIYET_URL')!, 'https://yonetim.laffogato.net')).toEqual({
      error: 'Adres: bu yönetim konsolunun adresi; panelin adresini yazın (örnek https://ladmin.laffogato.net)',
    });
    expect(checkConnValue(connField('LAFMALIYET_URL')!, 'https://Yonetim.ornek.com/')).toHaveProperty('error');
    expect(checkConnValue(connField('LAFFOGATO_URL')!, 'https://yonetim.ornek.com')).toEqual({ value: 'https://yonetim.ornek.com' });
    expect(checkConnValue(connField('ASILPOS_CLOUD_SECRET')!, 'kisa')).toEqual({ error: 'Anahtar: en az 32 karakter' });
    expect(checkConnValue(connField('TOKENX_CLIENT_ID')!, 'a b')).toHaveProperty('error');
    expect(checkConnValue(connField('TOKENX_CLIENT_ID')!, '  ')).toEqual({ value: null });
  });

  it('yapıştırılan satırlar: bilinen anahtarlar ve Pavo alınır; "deneme bittikten sonra" notlu satır şimdi yazılmaz', () => {
    const r = parseEnvLines(
      `\uFEFFLAFMALIYET_URL=https://ladmin.laffogato.net\r\n# yorum\r\nLAFFOGATO_URL=https://laffogato.net        (deneme bittikten sonra)\r\nASILPOS_CLOUD_URL=https://${ALAN_ADI} (Uzaktan)\r\nPAVO_SERIAL=PAV1\r\nFOO=bar\r\n`,
    );
    expect(r.values).toEqual({ LAFMALIYET_URL: 'https://ladmin.laffogato.net', ASILPOS_CLOUD_URL: `https://${ALAN_ADI}`, PAVO_SERIAL: 'PAV1' });
    expect(r.later).toEqual(['LAFFOGATO_URL']);
    expect(r.unknown).toEqual(['FOO']);
  });
});

describe('yönetimden yazma', () => {
  let h: Harness;
  let dir: string;
  let file: string;
  const secret = 's'.repeat(40);
  type View = { available: boolean; restart: string | null; pending: boolean; groups: { id: string; fields: { key: string; set: boolean; value: string | null }[] }[]; changed?: string[] };
  const field = (v: View, key: string) => v.groups.flatMap((g) => g.fields).find((f) => f.key === key)!;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'asilpos-ayar-'));
    file = join(dir, 'ayarlar.env');
    writeFileSync(file, `﻿# AsilPOS ayarları\r\nLAFMALIYET_SYNC_SECRET=${secret}\r\n`);
    h = await startApp({ ASILPOS_AYAR_DOSYASI: file });
  });
  afterAll(() => {
    delete process.env.ASILPOS_AYAR_DOSYASI;
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('görünüm ayar yetkisiyle; gizli anahtarın değeri dönmez, yalnız tanımlı olduğu', async () => {
    expect((await h.call('garson', 'GET', '/admin/baglanti')).status).toBe(403);
    const v = await h.ok<View>('patron', 'GET', '/admin/baglanti');
    expect(v).toMatchObject({ available: true, restart: 'elle' });
    expect(field(v, 'LAFMALIYET_SYNC_SECRET')).toEqual({ key: 'LAFMALIYET_SYNC_SECRET', set: true, value: null });
    expect(JSON.stringify(v)).not.toContain(secret);
  });

  it('yalnız patron yazar; bilinmeyen anahtar ve geçersiz değer 400, dosya değişmez', async () => {
    const before = readFileSync(file, 'utf8');
    expect((await h.call<{ code: string }>('mudur', 'PUT', '/admin/baglanti', { values: { LAFMALIYET_URL: 'https://x.example' } })).status).toBe(403);
    expect(await h.call('patron', 'PUT', '/admin/baglanti', { values: { PAVO_URL: 'https://192.168.1.5:4567' } })).toMatchObject({ status: 400, json: { code: 'unknown_key' } });
    expect(await h.call('patron', 'PUT', '/admin/baglanti', { values: { ASILPOS_CLOUD_SECRET: 'kisa' } })).toMatchObject({ status: 400, json: { code: 'invalid_value' } });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('kaydedince dosyaya yazılır, düzen korunur; denetim kaydında gizli değer yok; yeniden başlatma bekler', async () => {
    const cloud = 'c'.repeat(32);
    const v = await h.ok<View>('patron', 'PUT', '/admin/baglanti', { values: { LAFMALIYET_URL: 'https://ladmin.laffogato.net/', ASILPOS_CLOUD_URL: `https://${ALAN_ADI}`, ASILPOS_CLOUD_SECRET: cloud } });
    expect(v.changed).toEqual(['LAFMALIYET_URL', 'ASILPOS_CLOUD_URL', 'ASILPOS_CLOUD_SECRET']);
    expect(field(v, 'LAFMALIYET_URL')).toMatchObject({ set: true, value: 'https://ladmin.laffogato.net' });
    expect(field(v, 'ASILPOS_CLOUD_SECRET')).toEqual({ key: 'ASILPOS_CLOUD_SECRET', set: true, value: null });
    // Sunucu bu değerlerle başlamadı: yeniden başlatma bekleniyor (Windows'ta bekçi kendisi yapar)
    expect(v.pending).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿# AsilPOS ayarları\r\n')).toBe(true);
    // Kasa ayarı dosyada yoksa eski adla yazılır (eski sürüme dönülürse eski sunucu da okur); ekranda yeni adla görünür
    expect(readEnvText(text)).toEqual({ LAFMALIYET_SYNC_SECRET: secret, LAFMALIYET_URL: 'https://ladmin.laffogato.net', [`${ESKI_ENV_ONEKI}CLOUD_URL`]: `https://${ALAN_ADI}`, [`${ESKI_ENV_ONEKI}CLOUD_SECRET`]: cloud });
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=10');
    const row = audit.find((a) => a.action === 'ayar.baglanti')!;
    expect(row.message).toContain('LAFMALIYET_URL=https://ladmin.laffogato.net');
    expect(row.message).toContain('ASILPOS_CLOUD_SECRET değişti');
    expect(row.message).not.toContain(cloud);
  });

  it('boş değer satırı kaldırır', async () => {
    const v = await h.ok<View>('patron', 'PUT', '/admin/baglanti', { values: { LAFMALIYET_SYNC_SECRET: '' } });
    expect(field(v, 'LAFMALIYET_SYNC_SECRET').set).toBe(false);
    expect(readFileSync(file, 'utf8')).not.toContain('LAFMALIYET_SYNC_SECRET');
  });
});
