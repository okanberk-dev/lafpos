// LafPOS'un otomatik güncellemesi (Windows kurulumu). Bekçi (bekci.mjs) bunu SYSTEM olarak çalıştırır: GitHub'daki
// son sürümü (okanberk-dev/lafpos › Releases › latest) açılıştan 10 dakika sonra, sonra 6 saatte bir denetler; yenisi
// varsa kurulum dosyasını veri klasörünün guncelleme\ alt klasörüne indirir, SHA-256 özetini doğrular ve gün kapalıyken
// (gün sonundan sonra; sunucuya yalnız bu bilgisayardan sorulur) tek seferlik bir Görev Zamanlayıcı göreviyle sessiz
// kurar (/S). Kurulumu bekçi kendi alt süreci olarak açmaz: kurulum "LafPOS Sunucu" görevini durdurur, görevin iş
// nesnesindeki her süreç onunla kapanırdı. Kurulum önce veritabanının kopyasını alır, olmazsa güncellemeyi bırakıp eski
// sürümü yeniden açar; sonunda sunucuyu yeni sürümle başlatır. Yeni sürümün bekçisi tek seferlik görevi ve indirilen
// dosyayı siler.
// Ayarlar ayarlar.env'de: LAFPOS_GUNCELLEME (otomatik | kapali; varsayılan otomatik) ve LAFPOS_GUNCELLEME_TOKEN
// (GitHub'ın salt okunur anahtarı; boşsa hiç denetlenmez). Anahtar günlüğe ve durum dosyasına yazılmaz, sunucuya
// verilmez. Durum guncelleme\durum.json'da; sunucu onu Yönetim › Ayarlar ve yedek'te gösterir.
// Bağımlılıksız; bekci.mjs ile pakete girer (derle.mjs). Saf yardımcıların testi tests/guncelleme.test.ts.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'okanberk-dev/lafpos';
export const API_HOST = 'api.github.com';
export const LATEST_URL = `https://${API_HOST}/repos/${REPO}/releases/latest`;
/** Sürümdeki iki dosya: adları sabit (iş akışı .github/workflows/windows.yml yükler) */
export const EXE_ASSET = 'LafPOS-Kurulum.exe';
export const SHA_ASSET = 'LafPOS-Kurulum.exe.sha256';
/** Kurulumu SYSTEM olarak çalıştıran tek seferlik görev */
export const TASK = 'LafPOS Güncelleme';
export const FIRST_CHECK_MS = 10 * 60_000;
export const CHECK_EVERY_MS = 6 * 3600_000;
/** Gün açıkken (ya da sunucuya sorulamadıkça) kurulum bu aralıkla yeniden denenir */
export const DAY_POLL_MS = 10 * 60_000;
/** Kurulamayan sürüm en erken bu kadar sonra yeniden denenir (her deneme sunucuyu durdurur, veritabanını kopyalar) */
export const RETRY_SAME_MS = 24 * 3600_000;
/** Kurulum bekçiyi bu süre içinde durdurmazsa (başlamadı ya da en başta düştü) sunucu yeniden açılır */
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Ayar değişince (anahtar eklendi, güncelleme açıldı) ilk denetim */
export const AFTER_SETTINGS_MS = 60_000;
/** Kurulum dosyasının üst sınırı: bundan büyük yanıt indirilmez */
export const MAX_EXE_BYTES = 300 * 1024 * 1024;
export const STATES = ['guncel', 'indiriliyor', 'gun-kapaninca', 'kuruluyor', 'hata', 'kapali', 'anahtar-yok'];
const UA = 'LafPOS';
const API_VERSION = '2022-11-28';

// ─── Ayar ve sürüm ───────────────────────────────────────────────────────────

/**
 * ayarlar.env'den güncelleme ayarı. LAFPOS_GUNCELLEME "kapali" (kapalı, off, hayir, 0, false) değilse otomatik;
 * anahtar boşsa denetim yapılmaz
 * @param {Record<string, string | undefined>} vars
 */
export function updateSettings(vars) {
  const raw = String(vars.LAFPOS_GUNCELLEME ?? '')
    .trim()
    .toLocaleLowerCase('tr');
  const off = ['kapali', 'kapalı', 'kapat', 'off', 'hayir', 'hayır', 'no', 'false', '0'].includes(raw);
  return { mode: off ? 'kapali' : 'otomatik', token: String(vars.LAFPOS_GUNCELLEME_TOKEN ?? '').trim() };
}

/** "1.2.3" ya da "v1.2.3" → [1, 2, 3]; değilse null */
export function parseVersion(v) {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a, b'den yeniyse 1, aynıysa 0, eskiyse -1. Anlaşılmayan sürüm hata */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Sürüm anlaşılamadı: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Aday, kurulu sürümden yeni mi (biri anlaşılmazsa hayır: anlaşılmayan sürüm kurulmaz) */
export function isNewer(candidate, installed) {
  if (!parseVersion(candidate) || !parseVersion(installed)) return false;
  return compareVersions(candidate, installed) > 0;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/**
 * İsteğin başlıkları. Anahtar yalnız api.github.com'a gider: dosya indirmesi imzalı bir başka adrese yönlenir
 * (objects.githubusercontent.com gibi), anahtar oraya taşınmaz
 */
export function requestHeaders(url, token, accept) {
  const headers = { 'User-Agent': UA, Accept: accept };
  if (new URL(url).host === API_HOST) {
    headers['X-GitHub-Api-Version'] = API_VERSION;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** GitHub'ın hata yanıtı → sahibine anlaşılır neden */
export function githubError(status, headers) {
  const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers?.[k]) ?? null;
  if (status === 401) return 'GitHub anahtarı geçersiz ya da süresi dolmuş (401): ayarlar.env\'deki LAFPOS_GUNCELLEME_TOKEN\'ı yenileyin';
  if ((status === 403 || status === 429) && get('x-ratelimit-remaining') === '0') return `GitHub'ın istek sınırı doldu (${status}); sonraki denetimde yeniden denenecek`;
  if (status === 403) return 'GitHub isteği reddetti (403): anahtarın okanberk-dev/lafpos için "Contents: Read-only" izni olmalı';
  if (status === 404) return 'Sürüm bulunamadı (404): anahtar okanberk-dev/lafpos\'u göremiyor ya da henüz yayınlanmış sürüm yok';
  return `GitHub yanıt vermedi (${status}); sonraki denetimde yeniden denenecek`;
}

/** Sürümdeki iki dosya (kurulum ve özeti). İndirme adresi api.github.com'un dosya ucu olmalı */
export function pickAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const find = (name) => {
    const a = list.find((x) => x && x.name === name);
    if (!a) throw new Error(`Sürümde ${name} yok`);
    if (a.state && a.state !== 'uploaded') throw new Error(`${name} henüz yüklenmemiş`);
    let url;
    try {
      url = new URL(String(a.url));
    } catch {
      throw new Error(`${name} adresi anlaşılamadı`);
    }
    if (url.protocol !== 'https:' || url.host !== API_HOST || !url.pathname.startsWith(`/repos/${REPO}/releases/assets/`)) throw new Error(`${name} adresi beklenmedik: ${url.host}`);
    const size = Number(a.size);
    return { name, url: url.href, size: Number.isFinite(size) && size >= 0 ? size : null };
  };
  return { exe: find(EXE_ASSET), sha: find(SHA_ASSET) };
}

/** releases/latest yanıtı → { version, tag, exe, sha } */
export function parseRelease(json) {
  if (!json || typeof json !== 'object') throw new Error('GitHub yanıtı anlaşılamadı');
  if (json.draft || json.prerelease) throw new Error('Son sürüm taslak ya da ön sürüm; kurulmaz');
  const tag = String(json.tag_name ?? '');
  const v = parseVersion(tag);
  if (!v) throw new Error(`Sürüm etiketi anlaşılamadı: ${tag || '(boş)'}`);
  return { version: v.join('.'), tag, ...pickAssets(json.assets) };
}

/** .sha256 dosyası ("<64 hex>  LafPOS-Kurulum.exe" ya da yalnız özet) → küçük harf özet; yoksa null */
export function parseShaFile(text) {
  const m = /(?:^|\s)([0-9a-fA-F]{64})(?=\s|$)/.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Dosyanın SHA-256 özeti beklenenle aynı mı (dosya yoksa hayır) */
export async function verifyFile(file, expected) {
  if (!expected || !existsSync(file)) return false;
  return (await sha256File(file)) === String(expected).toLowerCase();
}

/** Metindeki anahtarı gizler (günlük ve durum dosyası) */
export function redact(text, token) {
  const s = String(text ?? '');
  return token && token.length >= 4 ? s.split(token).join('***') : s;
}

// ─── Durum ve karar ──────────────────────────────────────────────────────────

/** Güncelleme kapalı ya da anahtar yoksa durum; açıksa null */
export function offState(ayar) {
  if (ayar.mode === 'kapali') return { durum: 'kapali', mesaj: 'Otomatik güncelleme kapalı (ayarlar.env: LAFPOS_GUNCELLEME=kapali)' };
  if (!ayar.token) return { durum: 'anahtar-yok', mesaj: 'GitHub anahtarı yok (ayarlar.env: LAFPOS_GUNCELLEME_TOKEN boş); güncelleme denetlenmiyor' };
  return null;
}

const BASE = { kurulu: null, sonKontrol: null, yeniSurum: null, durum: 'guncel', mesaj: '' };
const iso = (ms) => new Date(ms).toISOString();

/**
 * Durum dosyasının bir sonraki hâli (saf). Olaylar:
 * - acilis {kurulu, ayar, now}: bekçi başladı; yarım kalan kurulum (kuruluyor) burada sonuçlanır
 * - ayar {ayar}: ayarlar.env değişti
 * - kontrol {son, now}: GitHub'daki son sürüm
 * - indiriliyor / indirildi {surum}
 * - bekle {neden: 'gun-acik' | 'bilinmiyor'}: kurulum için uygun an değil
 * - kuruluyor {surum, now}
 * - hata {mesaj, now}
 */
export function nextStatus(prev, ev) {
  const p = { ...BASE, ...(prev && typeof prev === 'object' ? prev : {}) };
  switch (ev.type) {
    case 'acilis': {
      const kurulu = ev.kurulu;
      const base = { ...p, kurulu };
      const off = offState(ev.ayar);
      if (p.durum === 'kuruluyor' && p.yeniSurum) {
        if (parseVersion(kurulu) && parseVersion(p.yeniSurum) && compareVersions(kurulu, p.yeniSurum) >= 0) {
          return { ...base, ...(off ?? { durum: 'guncel' }), yeniSurum: null, mesaj: `${kurulu} sürümüne güncellendi (${off ? off.mesaj : 'otomatik güncelleme'})`, guncellendi: iso(ev.now) };
        }
        return {
          ...base,
          durum: 'hata',
          mesaj: `${p.yeniSurum} kurulamadı, ${kurulu} çalışmaya devam ediyor (veritabanının kopyası alınamamış olabilir). Gün kapalıyken yeniden denenecek, en erken 24 saat sonra; acele ederseniz kurulum dosyasını elle çalıştırın`,
        };
      }
      if (off) return { ...base, ...off };
      // Kurulu sürüm durum dosyasındakinden farklı: elle kuruldu
      if (p.kurulu && p.kurulu !== kurulu) {
        const still = p.yeniSurum && isNewer(p.yeniSurum, kurulu) ? p.yeniSurum : null;
        return { ...base, durum: 'guncel', yeniSurum: still, mesaj: `${kurulu} kurulu; yeni sürüm açılıştan 10 dakika sonra denetlenecek` };
      }
      if (!prev || p.durum === 'kapali' || p.durum === 'anahtar-yok') return { ...base, durum: 'guncel', mesaj: 'Yeni sürüm açılıştan 10 dakika sonra denetlenecek' };
      if (p.durum === 'indiriliyor') return { ...base, mesaj: `${p.yeniSurum ?? 'Yeni sürüm'} indirmesi yarıda kaldı; birkaç dakika içinde yeniden başlayacak` };
      return base;
    }
    case 'ayar': {
      const off = offState(ev.ayar);
      if (off) return { ...p, ...off };
      if (p.durum === 'kapali' || p.durum === 'anahtar-yok') return { ...p, durum: 'guncel', mesaj: 'Ayar kaydedildi; yeni sürüm bir dakika içinde denetlenecek' };
      return p;
    }
    case 'kontrol': {
      const base = { ...p, sonKontrol: iso(ev.now) };
      if (isNewer(ev.son, p.kurulu)) return { ...base, yeniSurum: ev.son };
      return { ...base, durum: 'guncel', yeniSurum: null, mesaj: `En son sürüm kurulu (${p.kurulu})` };
    }
    case 'indiriliyor':
      return { ...p, durum: 'indiriliyor', yeniSurum: ev.surum, mesaj: `${ev.surum} indiriliyor` };
    case 'indirildi':
      return { ...p, durum: 'gun-kapaninca', yeniSurum: ev.surum, mesaj: `${ev.surum} indirildi ve doğrulandı; gün kapalıyken kurulacak` };
    case 'bekle':
      return {
        ...p,
        durum: 'gun-kapaninca',
        mesaj:
          ev.neden === 'gun-acik'
            ? `${p.yeniSurum} hazır; gün açık, gün sonundan sonra kurulacak`
            : `${p.yeniSurum} hazır; sunucuya gün açık mı diye sorulamadı, 10 dakika sonra yeniden sorulacak`,
      };
    case 'kuruluyor':
      return { ...p, durum: 'kuruluyor', yeniSurum: ev.surum, sonDeneme: { surum: ev.surum, at: iso(ev.now) }, mesaj: `${ev.surum} kuruluyor; sunucu bir iki dakika kapalı kalır` };
    case 'hata':
      return { ...p, durum: 'hata', mesaj: String(ev.mesaj ?? 'Bilinmeyen hata').slice(0, 400) };
    default:
      return p;
  }
}

/**
 * Kurulum için uygun an mı (saf): yalnız gün kapalıyken (sunucu öyle diyorsa). Kurulamayan sürüm 24 saat beklenir:
 * her deneme sunucuyu durdurur ve veritabanının kopyasını alır
 * @returns {'kur' | 'gun-acik' | 'bilinmiyor' | 'deneme-bekliyor'}
 */
export function installDecision({ dayOpen, status, surum, now }) {
  if (dayOpen === true) return 'gun-acik';
  if (dayOpen !== false) return 'bilinmiyor';
  const last = status?.sonDeneme;
  if (last && last.surum === surum && now - Date.parse(last.at) < RETRY_SAME_MS) return 'deneme-bekliyor';
  return 'kur';
}

/** Tek seferlik görev (Görev Zamanlayıcı XML'i, NSIS'teki sunucu göreviyle aynı düzen): tetiği yok, elle çalıştırılır */
export function taskXml(exe, workDir) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>LafPOS güncellemesi: bekçinin indirip doğruladığı kurulumu sessiz çalıştırır (tek seferlik; yeni sürüm bu görevi siler)</Description></RegistrationInfo>',
    '  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '  </Settings>',
    '  <Actions Context="Author"><Exec>',
    `    <Command>"${esc(exe)}"</Command>`,
    '    <Arguments>/S</Arguments>',
    `    <WorkingDirectory>${esc(workDir)}</WorkingDirectory>`,
    '  </Exec></Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** İndirilen kurulumun adı: LafPOS-Kurulum-<sürüm>.exe */
export const installerName = (version) => `LafPOS-Kurulum-${version}.exe`;
const INSTALLER_RE = /^LafPOS-Kurulum-(\d+\.\d+\.\d+)\.exe$/;

/** Klasörde kalmaması gerekenler: yarım indirmeler, görev dosyası ve `keep` dışındaki kurulumlar (saf) */
export function staleFiles(names, keep) {
  return names.filter((n) => n.endsWith('.part') || n === 'gorev.xml' || (INSTALLER_RE.test(n) && n !== keep));
}

// ─── Çalıştırıcı ─────────────────────────────────────────────────────────────

function schtasks(args) {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
  return new Promise((ok, fail) => {
    execFile(exe, args, { windowsHide: true, timeout: 60_000 }, (err, _out, stderr) => {
      if (err) fail(new Error(`schtasks ${args[0]}: ${String(stderr || err.message).trim()}`));
      else ok();
    });
  });
}

/**
 * Bekçinin güncelleyicisi.
 * @param {{
 *   home: string,
 *   appDir: string,
 *   settings: () => { mode: string, token: string },
 *   port: () => number,
 *   log: (line: string) => void,
 *   pauseServer?: () => Promise<void>,
 *   resumeServer?: () => void,
 *   fetch?: typeof fetch,
 *   runTask?: (args: string[]) => Promise<void>,
 *   platform?: string,
 *   now?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} deps
 */
export function createUpdater(deps) {
  const dir = join(deps.home, 'guncelleme');
  const statusFile = join(dir, 'durum.json');
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const runTask = deps.runTask ?? schtasks;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const pauseServer = deps.pauseServer ?? (async () => {});
  const resumeServer = deps.resumeServer ?? (() => {});

  let token = '';
  let status = null;
  let pending = null;
  let busy = false;
  const handles = { check: null, install: null, timeout: null, cleanup: null };

  const say = (line) => deps.log(redact(`[güncelleme] ${line}`, token));
  const readSettings = () => {
    const s = deps.settings();
    token = s.token;
    return s;
  };

  function installed() {
    try {
      return String(JSON.parse(readFileSync(join(deps.appDir, 'package.json'), 'utf8')).version ?? '');
    } catch {
      return '';
    }
  }

  function readStatus() {
    try {
      const s = JSON.parse(readFileSync(statusFile, 'utf8'));
      return s && typeof s === 'object' && STATES.includes(s.durum) ? s : null;
    } catch {
      return null;
    }
  }

  function set(ev) {
    const before = status;
    status = nextStatus(status, ev);
    if (before && before.durum === status.durum && before.mesaj === status.mesaj && before.sonKontrol === status.sonKontrol && before.yeniSurum === status.yeniSurum) return;
    try {
      mkdirSync(dir, { recursive: true });
      // Önce geçici dosya: yarım yazılmış durum okunmasın
      writeFileSync(`${statusFile}.tmp`, `${redact(JSON.stringify(status, null, 2), token)}\n`);
      renameSync(`${statusFile}.tmp`, statusFile);
    } catch (e) {
      say(`durum dosyası yazılamadı: ${e instanceof Error ? e.message : e}`);
    }
    if (!before || before.durum !== status.durum || before.mesaj !== status.mesaj) say(status.mesaj);
  }

  function schedule(key, ms, fn) {
    if (handles[key]) timers.clearTimeout(handles[key]);
    handles[key] = timers.setTimeout(() => {
      handles[key] = null;
      void fn();
    }, ms);
  }

  async function request(url, accept, signal) {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(target);
      if (u.protocol !== 'https:') throw new Error(`Güvensiz adres: ${u.protocol}//${u.host}`);
      const res = await fetchImpl(target, { headers: requestHeaders(target, token, accept), redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new Error(`Yönlendirme adresi yok (${res.status})`);
        target = new URL(loc, target).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(githubError(res.status, res.headers));
      }
      return res;
    }
    throw new Error('Çok fazla yönlendirme');
  }

  async function latestRelease() {
    const res = await request(LATEST_URL, 'application/vnd.github+json', AbortSignal.timeout(30_000));
    return parseRelease(await res.json());
  }

  /** Kurulum dosyasını indirir, özeti ve boyu tutmazsa siler; doğrulanmış dosyanın yolu */
  async function download(release) {
    const shaRes = await request(release.sha.url, 'application/octet-stream', AbortSignal.timeout(60_000));
    const expected = parseShaFile(await shaRes.text());
    if (!expected) throw new Error(`${SHA_ASSET} okunamadı`);
    const name = installerName(release.version);
    const file = join(dir, name);
    mkdirSync(dir, { recursive: true });
    if (await verifyFile(file, expected)) return { file, sha: expected };
    set({ type: 'indiriliyor', surum: release.version });
    const part = `${file}.part`;
    const res = await request(release.exe.url, 'application/octet-stream', AbortSignal.timeout(20 * 60_000));
    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(part);
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_EXE_BYTES) throw new Error('Kurulum dosyası beklenenden büyük; indirme bırakıldı');
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw e;
    }
    const got = hash.digest('hex');
    if (got !== expected || (release.exe.size != null && size !== release.exe.size)) {
      rmSync(part, { force: true });
      throw new Error(`İndirilen kurulumun SHA-256 özeti tutmadı (beklenen ${expected.slice(0, 12)}…, gelen ${got.slice(0, 12)}…); dosya silindi, sonraki denetimde yeniden indirilecek`);
    }
    rmSync(file, { force: true });
    renameSync(part, file);
    return { file, sha: expected };
  }

  function clean(keep) {
    try {
      for (const n of staleFiles(readdirSync(dir), keep)) rmSync(join(dir, n), { force: true });
    } catch {
      /* klasör yok */
    }
  }

  /** Sunucuya (yalnız bu bilgisayardan) gün açık mı diye sorar: true / false; sorulamazsa null */
  async function askDayOpen() {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${deps.port()}/api/kasa/guncelleme-durumu`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body?.dayOpen === 'boolean' ? body.dayOpen : null;
    } catch {
      return null;
    }
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const s = readSettings();
      if (offState(s)) {
        set({ type: 'ayar', ayar: s });
        return;
      }
      const release = await latestRelease();
      set({ type: 'kontrol', son: release.version, now: now() });
      if (!isNewer(release.version, status.kurulu)) {
        pending = null;
        clean(null);
        return;
      }
      const got = await download(release);
      clean(installerName(release.version));
      pending = { version: release.version, ...got };
      set({ type: 'indirildi', surum: release.version });
    } catch (e) {
      set({ type: 'hata', mesaj: e instanceof Error ? e.message : String(e), now: now() });
    } finally {
      busy = false;
      schedule('check', CHECK_EVERY_MS, check);
    }
    if (pending) await tryInstall();
  }

  async function tryInstall() {
    if (!pending || busy) return;
    const s = readSettings();
    if (offState(s)) {
      set({ type: 'ayar', ayar: s });
      return;
    }
    const decision = installDecision({ dayOpen: await askDayOpen(), status, surum: pending.version, now: now() });
    if (decision !== 'kur') {
      if (decision !== 'deneme-bekliyor') set({ type: 'bekle', neden: decision });
      schedule('install', DAY_POLL_MS, tryInstall);
      return;
    }
    if (platform !== 'win32') {
      set({ type: 'hata', mesaj: 'Otomatik kurulum yalnız Windows kurulumunda yapılır', now: now() });
      return;
    }
    const job = pending;
    busy = true;
    try {
      // Dosya indirildikten sonra değişmediyse (SYSTEM'in klasörü; yine de son anda bakılır)
      if (!(await verifyFile(job.file, job.sha))) {
        pending = null;
        rmSync(job.file, { force: true });
        throw new Error('Kurulum dosyası indirildikten sonra değişmiş; silindi, sonraki denetimde yeniden indirilecek');
      }
      set({ type: 'kuruluyor', surum: job.version, now: now() });
      // Sunucu düzgün kapanır: veritabanı ana dosyaya yazılır, kurulumun aldığı kopya tek dosya olur
      await pauseServer();
      const xml = join(dir, 'gorev.xml');
      writeFileSync(xml, Buffer.from(`\uFEFF${taskXml(job.file, dir)}`, 'utf16le'));
      try {
        await runTask(['/Create', '/TN', TASK, '/XML', xml, '/RU', 'SYSTEM', '/F']);
        await runTask(['/Run', '/TN', TASK]);
      } catch (e) {
        resumeServer();
        throw e;
      }
      say(`${job.version} kurulumu başladı; kurulum sunucuyu yeni sürümle yeniden başlatacak`);
      // Kurulum bu bekçiyi durdurur; durdurmadıysa başlamamış ya da en başta düşmüştür
      schedule('timeout', INSTALL_TIMEOUT_MS, () => {
        resumeServer();
        set({ type: 'hata', mesaj: `${job.version} kurulumu 5 dakikada başlamadı; sunucu eski sürümle yeniden açıldı. En erken 24 saat sonra yeniden denenecek`, now: now() });
      });
    } catch (e) {
      set({ type: 'hata', mesaj: `${job.version} kurulamadı: ${e instanceof Error ? e.message : String(e)}`, now: now() });
    } finally {
      busy = false;
    }
  }

  /** Yeni sürümün ilk açılışında: tek seferlik görev ve indirilen dosya silinir (kurulum çoktan bitmiştir) */
  async function cleanupAfterInstall() {
    if (platform === 'win32') await runTask(['/Delete', '/TN', TASK, '/F']).catch(() => {});
    clean(status?.yeniSurum && isNewer(status.yeniSurum, status.kurulu) ? installerName(status.yeniSurum) : null);
  }

  return {
    /** Bekçi açılınca: durum dosyası hemen yazılır, ilk denetim 10 dakika sonra (yarım indirmede 1 dakika) */
    start() {
      const prev = readStatus();
      const s = readSettings();
      set({ type: 'acilis', kurulu: installed(), ayar: s, now: now() });
      if (prev?.durum === 'kuruluyor') schedule('cleanup', 2 * 60_000, cleanupAfterInstall);
      if (!offState(s)) schedule('check', prev?.durum === 'indiriliyor' ? AFTER_SETTINGS_MS : FIRST_CHECK_MS, check);
    },
    /** ayarlar.env değişti: kapatma hemen yazılır; açılınca (anahtar eklendi) bir dakika içinde denetlenir */
    poke() {
      const s = readSettings();
      const wasOff = !status || status.durum === 'kapali' || status.durum === 'anahtar-yok';
      set({ type: 'ayar', ayar: s });
      if (offState(s)) {
        for (const key of ['check', 'install']) if (handles[key]) timers.clearTimeout(handles[key]);
        handles.check = handles.install = null;
      } else if (wasOff) schedule('check', AFTER_SETTINGS_MS, check);
    },
    stop() {
      for (const key of Object.keys(handles)) if (handles[key]) timers.clearTimeout(handles[key]);
    },
    check,
    tryInstall,
    status: () => status,
  };
}
