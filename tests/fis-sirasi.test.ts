import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Yazdırma sırası (src/lib/print.tsx `printQueue`): bütün fiş işleri tek sıradan geçer. Yazdırma alanı tek ve
 * `afterprint` bütün pencereye gelir; sırasız iki zincir üst üste binince biri ötekinin `afterprint`iyle bitmiş sayılıyor,
 * ikinci kâğıdını ilki basılırken gönderiyordu (inceleme, 23 Kas 2026)
 */

type Job<T> = () => Promise<{ value: T; finished: Promise<void> }>;
interface PrintModule {
  printQueue: (opts?: { gapMs?: number; stallMs?: number }) => <T>(job: Job<T>) => Promise<T>;
  printNow: (content: ReactNode, opts?: { sheet?: boolean }) => Promise<'direct' | 'browser'>;
  printEach: (parts: ReactNode[]) => Promise<void>;
}
/** Arayüz modülü (tsconfig'te DOM ve JSX yok: fis.test.ts gibi çalışma anında yüklenir) */
const PRINT = '../src/lib/print';
const print = () => import(/* @vite-ignore */ PRINT) as Promise<PrintModule>;

/** Elle yürütülen iş: başladığı kaydedilir; `send` yazdırma komutunu verir, `finish` işi bitirir (afterprint) */
function manual(log: string[], name: string) {
  let send = () => {};
  let finish = () => {};
  const sent = new Promise<void>((r) => (send = r));
  const finished = new Promise<void>((r) => (finish = r));
  const job: Job<string> = async () => {
    log.push(name);
    await sent;
    return { value: name, finished };
  };
  return { job, send: () => send(), finish: () => finish() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('yazdırma sırası', () => {
  it('iş öncekinin bitişini ve kısa arayı bekler; arayana yazdırma komutu verilince döner', async () => {
    const { printQueue } = await print();
    vi.useFakeTimers();
    const add = printQueue({ gapMs: 300, stallMs: 30_000 });
    const started: string[] = [];
    const got: string[] = [];
    const a = manual(started, 'a');
    const b = manual(started, 'b');
    void add(a.job).then((v) => got.push(v));
    void add(b.job).then((v) => got.push(v));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['a']);
    a.send();
    await vi.advanceTimersByTimeAsync(0);
    // Ödeme ekranı ya da deneme fişi beklemez: komut verilince söz biter
    expect(got).toEqual(['a']);
    // Ama ikinci iş ilki basılırken başlamaz
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toEqual(['a']);
    a.finish();
    await vi.advanceTimersByTimeAsync(299);
    expect(started).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['a', 'b']);
    b.send();
    b.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['a', 'b']);
  });

  it('basılamayan iş sırayı durdurmaz; arayan hatayı alır', async () => {
    const { printQueue } = await print();
    vi.useFakeTimers();
    const add = printQueue({ gapMs: 300 });
    const started: string[] = [];
    const failed = add<string>(async () => {
      started.push('bozuk');
      throw new Error('yazdırılamadı');
    });
    const next = manual(started, 'sonraki');
    const done = add(next.job);
    await expect(failed).rejects.toThrow('yazdırılamadı');
    await vi.advanceTimersByTimeAsync(300);
    expect(started).toEqual(['bozuk', 'sonraki']);
    next.send();
    await expect(done).resolves.toBe('sonraki');
  });

  it('bitmeyen iş (yanıtı gelmeyen istek) sırayı en çok stallMs tutar', async () => {
    const { printQueue } = await print();
    vi.useFakeTimers();
    const add = printQueue({ gapMs: 300, stallMs: 30_000 });
    const started: string[] = [];
    const stuck = manual(started, 'takılan');
    const next = manual(started, 'sonraki');
    void add(stuck.job);
    void add(next.job);
    stuck.send();
    await vi.advanceTimersByTimeAsync(30_000 + 299);
    expect(started).toEqual(['takılan']);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['takılan', 'sonraki']);
  });
});

describe('tarayıcıdan basma (window.print, afterprint)', () => {
  it('iki zincir üst üste binmez: ikinci ödemenin kâğıtları ve Z, öncekiler bitince sırayla basılır', async () => {
    const { printEach, printNow } = await print();
    const win = Object.assign(new EventTarget(), { print: vi.fn() });
    vi.stubGlobal('window', win);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16));
    vi.useFakeTimers();
    const done: string[] = [];
    const afterprint = async () => {
      win.dispatchEvent(new Event('afterprint'));
      // Ara (300 ms) ve sıradakinin çizimi (bir kare ve 30 ms)
      await vi.advanceTimersByTimeAsync(400);
    };

    void printEach(['A müşteri', 'A işyeri']).then(() => done.push('A'));
    await vi.advanceTimersByTimeAsync(100);
    expect(win.print).toHaveBeenCalledTimes(1);
    // Bir saniye sonra ikinci payın iki kâğıdı ve Z: A'nın ilk kâğıdı bitmeden hiçbiri yazdırılmaz (eskiden B'nin
    // kâğıdı ve Z hemen basılıyor, B A'nın afterprint'iyle bitmiş sayılıyordu)
    await vi.advanceTimersByTimeAsync(1000);
    void printEach(['B müşteri', 'B işyeri']).then(() => done.push('B'));
    void printNow('Z').then(() => done.push('Z'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.print).toHaveBeenCalledTimes(1);
    expect(done).toEqual([]);

    await afterprint();
    expect(win.print).toHaveBeenCalledTimes(2);
    await afterprint();
    // A'nın iki kâğıdı bitti; B'nin ilki basılıyor
    expect(done).toEqual(['A']);
    expect(win.print).toHaveBeenCalledTimes(3);
    await afterprint();
    expect(win.print).toHaveBeenCalledTimes(4);
    expect(done).toEqual(['A']);
    await afterprint();
    // B kendi kâğıtlarının afterprint'iyle biter; Z ondan sonra basılır, söz komut verilince döner
    expect(done).toEqual(['A', 'B', 'Z']);
    expect(win.print).toHaveBeenCalledTimes(5);
    await afterprint();
    expect(win.print).toHaveBeenCalledTimes(5);
  });
});
