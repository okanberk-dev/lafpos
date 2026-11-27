// Siteden kurulum: AsilPOS-Kur.cmd. Anahtarsız küçük bir web kurucusudur; kanal derlemesi (kanal.mjs) her main
// derlemesinde dist/web/guncelleme/AsilPOS-Kur.cmd'ye yazar, AsilPOS Uzaktan'ın İndir sayfası (girişten sonra) ona
// bağlanır. Depo özel ve Vercel NSIS kurulumunu derleyemediği için tam kurulum dosyası (AsilPOS-Kurulum.exe) GitHub
// Releases'ta kalır; bu dosya aynı düzeni (asilpos.nsi) PowerShell ile kurar.
//
// Dosya iki dilli tek dosyadır: başındaki birkaç satır cmd.exe için (PowerShell'de yorum bloğu), gerisi PowerShell
// gövdesidir (web-kurucu.ps1). Çift tıklayınca cmd 64 bit Windows PowerShell'i açar, o da dosyanın kendisini UTF-8
// okuyup çalıştırır. cmd satırları ASCII ve CRLF kalır; BOM yok (cmd ilk satırı okuyamazdı).
//
// İçine yalnız derlemenin herkese açık bilgisi girer: surum.json'daki sürüm ve SHA-256 özetleri (kanal okunamazsa
// bunlar kullanılır) ve kurulumun küçük dosyaları (başlatıcı, kasa kısayolu, yönetim betiği, simge, notlar, boş ayar
// örneği). Anahtar, parola, ortam değişkeni girmez (tests/web-kurucu.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSample } from './ayarlar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');

/** Kurucunun yayın adı ve adresi (güncelleme kanalının yanında) */
export const WEB_INSTALLER_NAME = 'AsilPOS-Kur.cmd';
/**
 * Ad değişikliğinden (26 Kasım 2026) önceki adı: kanal aynı dosyayı bu adla da yayımlar. ladmin şube kurucusunu bu
 * adresten alıp iki boş satırını doldurur; eski bağlantılar da buna gider (shared/eski-adlar.ts ESKI_WEB_KURUCU)
 */
export const OLD_WEB_INSTALLER_NAME = 'LafPOS-Kur.cmd';
export const WEB_INSTALLER_URL = `https://lafpos.laffogato.net/guncelleme/${WEB_INSTALLER_NAME}`;

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const SHA_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

/** cmd.exe başlığı: PowerShell için `<#` ile başlayan yorum bloğu, cmd için etiket satırı (`:` ile) */
const CMD_HEADER = [
  '<# : AsilPOS siteden kurulum. Cift tiklayin; Windows izin sorunca Evet deyin.',
  '@echo off',
  'setlocal',
  'set "ASILPOS_KUR=%~f0"',
  'rem 32 bit cmd.exe acildiysa 64 bit PowerShell Sysnative uzerinden bulunur',
  'set "ASILPOS_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'if exist "%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" set "ASILPOS_PS=%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '"%ASILPOS_PS%" -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:ASILPOS_KUR,[Text.Encoding]::UTF8); & ([ScriptBlock]::Create($t))"',
  'set "KOD=%ERRORLEVEL%"',
  'endlocal & exit /b %KOD%',
  '#>',
];

/**
 * Kurulumun app\ ve node\ dışındaki dosyaları: derle.mjs'in kurulum klasörüne koyduklarının aynısı. Kaldırma betiği
 * yalnız siteden kurulumda (kurulum dosyasının Kaldir.exe'si yoksa) Uygulamalar listesine bağlanır
 * @returns {Record<string, Buffer>}
 */
export function shellFiles(root = ROOT) {
  const text = (p) => readFileSync(join(root, p), 'utf8');
  const bom = (s) => Buffer.from(`﻿${crlf(s)}`, 'utf8');
  return {
    'baslat.cmd': Buffer.from(crlf(text('scripts/kasa/windows/kurulum/baslat.cmd'))),
    'AsilPOS-Kasa.bat': Buffer.from(crlf(text('scripts/kasa/windows/AsilPOS-Kasa.bat'))),
    // Ad değişikliğinden (26 Kasım 2026) önceki kısayollar eski adı çağırır: yenisine yönlendirir
    'LafPOS-Kasa.bat': Buffer.from(crlf(text('scripts/kasa/windows/LafPOS-Kasa.bat'))),
    'yonet.ps1': Buffer.from(crlf(text('scripts/kasa/windows/kurulum/yonet.ps1'))),
    'asilpos.ico': readFileSync(join(root, 'scripts/kasa/windows/kurulum/asilpos.ico')),
    // Eski kurulumun Uygulamalar kaydı (DisplayIcon) ve kısayolları eski adlı simgeyi gösterir
    'lafpos.ico': readFileSync(join(root, 'scripts/kasa/windows/kurulum/asilpos.ico')),
    // Eski Not Defteri ve Windows PowerShell 5.1 UTF-8'i BOM'la tanır
    'BENIOKU.txt': bom(text('scripts/kasa/windows/kurulum/BENIOKU.txt')),
    'ayarlar.env.ornek': bom(envSample(text('.env.example'))),
    'LafPOS-Kaldir.ps1': bom(text('scripts/kasa/windows/kurulum/web-kaldir.ps1')),
  };
}

/** PowerShell tek tırnaklı dize (yalnız doğrulanmış değerler girer; yine de tırnak kaçırılır) */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * surum.json'dan (kanal.mjs manifestFor) AsilPOS-Kur.cmd'nin metni. Saf: aynı girdi aynı dosyayı verir
 * @param {{ manifest: any, files?: Record<string, Buffer>, template?: string }} opts
 */
export function webInstaller({ manifest: m, files = shellFiles(), template = readFileSync(join(HERE, 'web-kurucu.ps1'), 'utf8') }) {
  if (!m || m.v !== 1 || !Number.isInteger(m.build) || m.build < 1e9 || m.build > 1e11) throw new Error('surum.json anlaşılamadı (derleme)');
  if (!SEMVER_RE.test(m.version) || m.app?.file !== `lafpos-app-${m.build}.zip` || !SHA_RE.test(m.app.sha256) || !Number.isInteger(m.app.size)) {
    throw new Error('surum.json anlaşılamadı (uygulama yükü)');
  }
  if (!SEMVER_RE.test(m.node?.version) || !/^\d{2,4}$/.test(String(m.node.abi)) || !SHA_RE.test(m.node.sha256)) throw new Error('surum.json anlaşılamadı (Node)');
  if (!SEMVER_RE.test(m.sqlite?.version) || !SHA_RE.test(m.sqlite.sha256)) throw new Error('surum.json anlaşılamadı (better-sqlite3)');
  const gomulu = [
    '@{',
    `  build = ${psq(String(m.build))}; version = ${psq(m.version)}`,
    `  appFile = ${psq(m.app.file)}; appSha = ${psq(m.app.sha256)}; appSize = [long]${m.app.size}`,
    `  nodeVersion = ${psq(m.node.version)}; nodeAbi = ${psq(String(m.node.abi))}; nodeSha = ${psq(m.node.sha256)}`,
    `  sqliteVersion = ${psq(m.sqlite.version)}; sqliteSha = ${psq(m.sqlite.sha256)}`,
    '}',
  ].join('\n');
  const names = Object.keys(files).sort();
  for (const n of names) if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`Kurulum dosyasının adı beklenmedik: ${n}`);
  const dosyalar = ['@{', ...names.map((n) => `  ${psq(n)} = ${psq(files[n].toString('base64'))}`), '}'].join('\n');
  const once = (t) => template.split(t).length === 2;
  if (!once('__GOMULU__') || !once('__DOSYALAR__')) throw new Error('web-kurucu.ps1: yer tutucular birer kez geçmeli');
  const body = template.replace('__GOMULU__', () => gomulu).replace('__DOSYALAR__', () => dosyalar);
  return crlf(`${CMD_HEADER.join('\n')}\n${body}`);
}
