import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../src/lib/toastStore';

/**
 * Panoya kopyalama (src/lib/clipboard.ts `copyText`; Z penceresinde "WhatsApp için kopyala" ve lafmaliyet "Kopyala").
 * Pano API'si yalnız güvenli bağlamda var: kafe ağında telefondan http://192.168.x.x ile açılan kasada
 * `navigator.clipboard` yok. Eskiden WhatsApp düğmesi orada sessizce hata verip hiçbir bildirim göstermiyordu
 * (inceleme, 23 Kas 2026)
 */

type CopyText = (text: string, failMessage?: string) => Promise<boolean>;
/** Arayüz modülü (DOM türleri; tsconfig'te yok: fis.test.ts gibi çalışma anında yüklenir) */
const CLIPBOARD = '../src/lib/clipboard';
const load = async () => ((await import(/* @vite-ignore */ CLIPBOARD)) as { copyText: CopyText }).copyText;

/** Eski kopyalama yolunun belgesi: metin alanı ve `execCommand('copy')` (sonucu `result`) */
function fakeDocument(result: boolean | 'hata') {
  const calls: string[] = [];
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: (k: string) => calls.push(`attr:${k}`),
    select: () => calls.push('select'),
    setSelectionRange: (from: number, to: number) => calls.push(`range:${from}-${to}`),
    remove: () => calls.push('remove'),
  };
  const doc = {
    body: { appendChild: () => calls.push('append') },
    activeElement: { focus: () => calls.push('focus') },
    createElement: (tag: string) => {
      calls.push(`create:${tag}`);
      return area;
    },
    execCommand: (cmd: string) => {
      calls.push(`exec:${cmd}:${area.value}`);
      if (result === 'hata') throw new Error('desteklenmiyor');
      return result;
    },
  };
  return { doc, calls };
}

const lastToast = () => useToasts.getState().list.at(-1) ?? null;

beforeEach(() => useToasts.setState({ list: [] }));
afterEach(() => vi.unstubAllGlobals());

describe('panoya kopyalama', () => {
  it('pano API’si yoksa (telefonda http) gizli metin alanıyla kopyalanır; alan kaldırılır, odak geri döner', async () => {
    const copyText = await load();
    const { doc, calls } = fakeDocument(true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', doc);
    await expect(copyText('Gün sonu')).resolves.toBe(true);
    expect(calls).toEqual(['create:textarea', 'attr:readonly', 'attr:aria-hidden', 'append', 'select', `range:0-${'Gün sonu'.length}`, 'exec:copy:Gün sonu', 'remove', 'focus']);
    expect(lastToast()).toBeNull();
  });

  it('pano API’si varsa o kullanılır; izin vermezse eski yol denenir', async () => {
    const copyText = await load();
    const written: string[] = [];
    const { doc, calls } = fakeDocument(true);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void written.push(t) } });
    await expect(copyText('a')).resolves.toBe(true);
    expect(written).toEqual(['a']);
    expect(calls).toEqual([]);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      },
    });
    await expect(copyText('b')).resolves.toBe(true);
    expect(calls).toContain('exec:copy:b');
    expect(lastToast()).toBeNull();
  });

  it('ikisi de olmazsa hata bildirimi gösterilir ve false döner', async () => {
    const copyText = await load();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', fakeDocument(false).doc);
    await expect(copyText('x')).resolves.toBe(false);
    expect(lastToast()).toMatchObject({ tone: 'err', text: 'Panoya kopyalanamadı' });
    vi.stubGlobal('document', fakeDocument('hata').doc);
    await expect(copyText('x', 'Panoya kopyalanamadı; değerleri tablodan okuyun')).resolves.toBe(false);
    expect(lastToast()).toMatchObject({ tone: 'err', text: 'Panoya kopyalanamadı; değerleri tablodan okuyun' });
  });
});
