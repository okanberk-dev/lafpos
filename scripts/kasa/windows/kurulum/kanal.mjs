// Güncelleme kanalı: kafedeki kasanın kendiliğinden güncellenmesi için dist/web/guncelleme/ altına surum.json ve
// lafpos-app-<build>.zip yazar (eski güncelleyiciler bu adı ister). Vercel'deki proje (adı eski adla kaldı) bunu her main derlemesinde çalıştırır (vercel.json
// buildCommand): kanal https://lafpos.laffogato.net/guncelleme/surum.json'da yayımlanır, gizli anahtar gerekmez.
// Zip kurulumun app\ yüküdür (paket.mjs; node.exe ve better-sqlite3'ün Windows ikilisi hariç), kasa arayüzü Uzaktan
// derlemesinden ayrı derlenir. `build` HEAD commit'inin unix zamanı: aynı commit'in kurulum dosyası (GitHub Release)
// ve kanalı aynı numarayı taşır. Manifestte zip'in SHA-256'sı ve boyu, Node ve better-sqlite3'ün sürümü ve özeti
// (surumler.mjs) bulunur; güncelleyici (guncelle.mjs) bunlarla doğrular. Aynı sunucu kodu zaten açık demoda (/demo).
// Yanına siteden kurulumun web kurucusu AsilPOS-Kur.cmd yazılır (web-kurucu.mjs); aynı baytlarla eski adıyla da
// (LafPOS-Kur.cmd): ladmin'in şube kurucusu ve eski bağlantılar o adresi okur (shared/eski-adlar.ts ESKI_WEB_KURUCU).
// Kullanım: node scripts/kasa/windows/kurulum/kanal.mjs   (dist/web'in kendisi önce derlenmiş olmalı)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesOf, zipFiles } from './arsiv.mjs';
import { buildInfo, ROOT, sqliteVersion, stageApp } from './paket.mjs';
import { NODE_ABI, NODE_SHA256, NODE_VERSION, sqliteSha256 } from './surumler.mjs';
import { OLD_WEB_INSTALLER_NAME, WEB_INSTALLER_NAME, webInstaller } from './web-kurucu.mjs';

const OUT = join(ROOT, 'dist/web/guncelleme');

/** Kanalın manifesti (saf; guncelle.mjs parseManifest okur) */
export function manifestFor({ build, commit, version, zip, sqlite, not = null }) {
  return {
    v: 1,
    build,
    version,
    commit,
    // Merkez'deki "Yeni sürüm hazır" satırının kısa notu (main'e giren PR'ın başlığı)
    ...(not ? { not } : {}),
    date: new Date(build * 1000).toISOString(),
    app: { file: `lafpos-app-${build}.zip`, sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length },
    node: { version: NODE_VERSION, abi: NODE_ABI, sha256: NODE_SHA256 },
    sqlite: { version: sqlite, sha256: sqliteSha256(sqlite) },
  };
}

/**
 * Sürümün kısa notu: son commit'in başlığı (squash birleştirmede PR başlığı, sondaki "(#61)" düşer). Vercel'de git
 * geçmişi yoksa VERCEL_GIT_COMMIT_MESSAGE'ın ilk satırı
 */
export function changeNote(env = process.env) {
  let subject = '';
  try {
    subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    subject = String(env.VERCEL_GIT_COMMIT_MESSAGE ?? '').split('\n')[0].trim();
  }
  return subject.replace(/\s*\(#\d+\)$/, '').slice(0, 200) || null;
}

async function main() {
  const info = buildInfo();
  const sqlite = sqliteVersion();
  sqliteSha256(sqlite);
  const tmp = mkdtempSync(join(tmpdir(), 'asilpos-kanal-'));
  try {
    console.log(`▸ Güncelleme kanalı: kasa arayüzü derleniyor (derleme ${info.build})`);
    const web = join(tmp, 'web');
    // Kasanın arayüzü: Uzaktan bayrağı olmadan (Vercel'in kendi derlemesi VITE_ASILPOS_UZAKTAN=1 ile; eski adı da
    // silinir, src/lib/remote.ts ikisini de okur)
    const env = { ...process.env };
    delete env.VITE_ASILPOS_UZAKTAN;
    delete env.VITE_LAFPOS_UZAKTAN;
    execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', web, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, env, stdio: 'inherit' });
    const appDir = join(tmp, 'app');
    const meta = await stageApp({ appDir, webDir: web, ...info });
    const zip = zipFiles(filesOf(appDir));
    const manifest = manifestFor({ ...info, version: meta.version, zip, sqlite, not: changeNote() });
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, manifest.app.file), zip);
    writeFileSync(join(OUT, 'surum.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Siteden kurulum (AsilPOS Uzaktan › İndir): aynı derlemenin özetleriyle anahtarsız web kurucusu (web-kurucu.mjs)
    const kurucu = webInstaller({ manifest });
    writeFileSync(join(OUT, WEB_INSTALLER_NAME), kurucu);
    writeFileSync(join(OUT, OLD_WEB_INSTALLER_NAME), kurucu);
    console.log(`✓ dist/web/guncelleme/${manifest.app.file} · ${(zip.length / 2 ** 20).toFixed(1)} MB · SHA-256 ${manifest.app.sha256}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('kanal.mjs')) await main();
