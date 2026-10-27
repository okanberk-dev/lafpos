import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { env } from '../env';
import { siteLinked } from '../sync/laffogato-link';

/**
 * Ürün kartlarındaki görselin küçük kopyası. Görseller sitede 1024 px dekupaj (~160 KB); kasa ve tabletler
 * onları sitenin görsel küçültme ucundan (Next.js `/_next/image`, 256 px WebP, ~8 KB) sunucu üzerinden alır.
 * Kopya veri klasöründe kalır: internet kesikken de görünür, siteye tablet başına istek gitmez.
 */
const DIR = join(env.dataDir, 'cache', 'urun-gorselleri');
const WIDTH = 256;
const MAX_BYTES = 2_000_000;
/** İnternet yokken her kart için yeniden denenmesin */
const RETRY_AFTER_MS = 10 * 60_000;

const inflight = new Map<string, Promise<Thumb | null>>();
const failedAt = new Map<string, number>();

export interface Thumb {
  body: Buffer;
  type: string;
}

const TYPES: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', avif: 'image/avif' };

/**
 * Yalnız sitenin kendi görselleri (https, aynı köken): menüden gelen adres başka yere istek attıramaz. Site bağlantısı
 * yokken (LAFFOGATO_URL) hiçbir görsel indirilmez; kart baş harflerle çizilir.
 */
export function thumbSource(url: string | null | undefined): URL | null {
  if (!url || !siteLinked()) return null;
  try {
    const u = new URL(url);
    const site = new URL(env.laffogatoUrl);
    return u.protocol === 'https:' && u.host === site.host ? u : null;
  } catch {
    return null;
  }
}

const keyOf = (url: string) => createHash('sha256').update(`${WIDTH}|${url}`).digest('hex').slice(0, 24);

function fromDisk(key: string): Thumb | null {
  for (const [ext, type] of Object.entries(TYPES)) {
    const file = join(DIR, `${key}.${ext}`);
    if (existsSync(file)) return { body: readFileSync(file), type };
  }
  return null;
}

async function download(src: URL): Promise<Thumb | null> {
  // Sürüm (?v=) adresle birlikte gider: site fotoğrafı değiştirince küçültme ucunun önbelleği eskisini vermesin
  // (yalnız yol giderse aynı küçük kopya ay boyu döner). Site `images.localPatterns` tanımlamadığı için sorgulu yerel
  // adres kabul edilir (next/dist/shared/lib/match-local-pattern.js); edilmezse aşağıdaki asıl görsele düşülür
  const optimized = `${src.origin}/_next/image?url=${encodeURIComponent(`${src.pathname}${src.search}`)}&w=${WIDTH}&q=75`;
  // Küçültme ucu yanıt vermezse görselin sürümlü aslı (boyut sınırıyla)
  for (const target of [optimized, src.href]) {
    try {
      const res = await fetch(target, { headers: { accept: 'image/webp,image/png,image/*;q=0.8' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      const type = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (!res.ok || !Object.values(TYPES).includes(type)) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > MAX_BYTES) continue;
      return { body, type };
    } catch {
      /* sıradaki kaynağı dene */
    }
  }
  return null;
}

/** Görselin küçük kopyası: önce diskte, yoksa siteden bir kez çekilip yazılır */
export async function thumbFor(url: string): Promise<Thumb | null> {
  const src = thumbSource(url);
  if (!src) return null;
  const key = keyOf(src.href);
  const cached = fromDisk(key);
  if (cached) return cached;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS) return null;
  let job = inflight.get(key);
  if (!job) {
    job = download(src).then((thumb) => {
      inflight.delete(key);
      if (!thumb) {
        failedAt.set(key, Date.now());
        return null;
      }
      mkdirSync(DIR, { recursive: true });
      const ext = Object.entries(TYPES).find(([, t]) => t === thumb.type)![0];
      const file = join(DIR, `${key}.${ext}`);
      writeFileSync(`${file}.part`, thumb.body);
      renameSync(`${file}.part`, file);
      return thumb;
    });
    inflight.set(key, job);
  }
  return job;
}

export function productImage(productId: string): string | null {
  return db.select({ image: schema.products.image }).from(schema.products).where(eq(schema.products.id, productId)).get()?.image ?? null;
}

/** Menü eşitlemesinden sonra eksik kopyaları sırayla çeker: ilk açılışta kartlar hazır gelsin */
export async function warmProductThumbs(): Promise<number> {
  const rows = db.select({ image: schema.products.image }).from(schema.products).all();
  let fetched = 0;
  for (const { image } of rows) {
    const src = thumbSource(image);
    if (!src || fromDisk(keyOf(src.href))) continue;
    if (await thumbFor(src.href)) fetched++;
  }
  return fetched;
}
