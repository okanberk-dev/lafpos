/**
 * Yemek kartının yazarkasada karşılığı (saf, testli; sunucu ve yönetim ekranı ortak).
 *
 * Token (Beko): yemek kartı ödemesi `type: 7` ve operatör no'suyla gider, cihaz o yemek kartı uygulamasını açar ve
 * bilgi fişi keser; sonuçta aynı operatör no'su gelir. Operatör no'ları Token geliştirici belgesinden
 * ("Banka / Yemek Uygulamaları"). Pavo'nun ödeme aracı no'ları belgesiz: cihazın kendi listesinden (`/PaymentMediators`)
 * adıyla eşlenir.
 */

/** Ödeme türünün kanalı (lafmaliyet komisyon anahtarı, `PAYMENT_CHANNELS`) → Token yemek kartı operatörü */
export const TOKEN_MEAL_OPERATORS: Record<string, number> = {
  edenred: 1001,
  multinet: 1002,
  setcard: 1003,
  pluxee: 1004,
  metropol: 1006,
};

/** Token'ın ödeme uygulamaları (banka ve yemek kartı) */
export const TOKEN_PAYMENT_APPS: Record<number, string> = {
  0: 'Test uygulaması',
  10: 'Ziraat Bankası',
  12: 'Halkbank',
  15: 'VakıfBank',
  32: 'TEB',
  46: 'Akbank',
  59: 'Şekerbank',
  62: 'Garanti BBVA',
  64: 'İş Bankası',
  67: 'Yapı Kredi',
  103: 'Fibabanka',
  111: 'QNB',
  133: 'ING',
  135: 'Anadolu Bank',
  205: 'Kuveyt Türk',
  206: 'Türkiye Finans',
  210: 'Vakıf Katılım',
  1000: 'Yemek kartı test uygulaması',
  1001: 'Edenred (Ticket)',
  1002: 'Multinet',
  1003: 'Setcard',
  1004: 'Pluxee (Sodexo)',
  1005: 'TokenFlex',
  1006: 'Metropol',
};

export const isMealOperator = (id: number) => id >= 1000 && id < 2000;

interface MethodLike {
  id: string;
  name: string;
  kind: string;
  channel?: string | null;
  active?: boolean;
}

/**
 * Token: yemek kartı ödeme türlerini cihazdaki uygulamalara eşler (operatör no → ödeme türü). Elle yapılmış eşleme
 * korunur; kanalı bilinen (Pluxee, Multinet...) ve cihazda uygulaması olan tür eklenir. Cihaz uygulama listesi
 * vermediyse (eski yazılım) kanalı bilinen her tür eklenir
 */
export function tokenMealMap(current: Record<string, string>, methods: MethodLike[], deviceApps: number[]): Record<string, string> {
  const out = { ...current };
  const mapped = new Set(Object.values(out));
  for (const m of methods) {
    if (m.kind !== 'yemek' || m.active === false || mapped.has(m.id)) continue;
    const op = m.channel ? TOKEN_MEAL_OPERATORS[m.channel] : undefined;
    if (op == null || String(op) in out) continue;
    if (deviceApps.length && !deviceApps.includes(op)) continue;
    out[String(op)] = m.id;
    mapped.add(m.id);
  }
  return out;
}

/** Ödeme türünün Token operatörü: elle eşleme, yoksa kanalından */
export function tokenOperatorFor(methodId: string, channel: string | null | undefined, map: Record<string, string>): number | null {
  const hit = Object.entries(map).find(([, id]) => id === methodId);
  if (hit && /^\d+$/.test(hit[0])) return Number(hit[0]);
  return channel && TOKEN_MEAL_OPERATORS[channel] != null ? TOKEN_MEAL_OPERATORS[channel]! : null;
}

/** Adındaki iz → kanal: Pavo'nun ödeme aracı adından (ör. "MULTINET", "Sodexo Yemek") */
const NAME_HINTS: [RegExp, string][] = [
  [/multinet/i, 'multinet'],
  [/pluxee|sodexo/i, 'pluxee'],
  [/edenred|ticket/i, 'edenred'],
  [/set\s*card/i, 'setcard'],
  [/metropol/i, 'metropol'],
];

export function channelOfName(name: string | null | undefined): string | null {
  if (!name) return null;
  return NAME_HINTS.find(([re]) => re.test(name))?.[1] ?? null;
}

/**
 * Pavo: cihazın ödeme araçlarını (no, ad) yemek kartı türlerine adıyla eşler (araç no → ödeme türü). 1 (nakit) ve 2 (kart)
 * hiç eşlenmez; elle eşleme korunur
 */
export function pavoMealMap(current: Record<string, string>, methods: MethodLike[], mediators: { id: number | null; name: string | null }[]): Record<string, string> {
  const out = { ...current };
  const mapped = new Set(Object.values(out));
  for (const md of mediators) {
    if (md.id == null || md.id === 1 || md.id === 2 || String(md.id) in out) continue;
    const channel = channelOfName(md.name);
    if (!channel) continue;
    const m = methods.find((x) => x.kind === 'yemek' && x.active !== false && !mapped.has(x.id) && (x.channel === channel || channelOfName(x.name) === channel));
    if (!m) continue;
    out[String(md.id)] = m.id;
    mapped.add(m.id);
  }
  return out;
}

/** Pavo: ödeme türünün cihazdaki aracı (eşlemeden) */
export function pavoMediatorFor(methodId: string, map: Record<string, string>): number | null {
  const hit = Object.entries(map).find(([, id]) => id === methodId);
  return hit && /^\d+$/.test(hit[0]) ? Number(hit[0]) : null;
}
