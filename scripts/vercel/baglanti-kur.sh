#!/usr/bin/env bash
# LafPOS bağlantısını canlıda kurar (bir kez, operatörün kendi Mac'inde çalıştırılır):
#   1. Üç ortak anahtar üretir ve Vercel'e yazar:
#      laffogato  LAFPOS_SYNC_SECRET      ↔ kafede LAFFOGATO_SYNC_SECRET
#      lafmaliyet LAFPOS_SYNC_SECRET      ↔ kafede LAFMALIYET_SYNC_SECRET
#      lafpos     LAFPOS_CLOUD_SECRET     ↔ kafede LAFPOS_CLOUD_SECRET
#   2. lafpos'a LAFPOS_UZAKTAN_PAROLA (uzaktan giriş parolası) ve Upstash Redis ekler.
#   3. Üç projenin main'den gelen son üretim dağıtımını yeniden derler (yeni değişkenler ancak böyle okunur).
#   4. Kafe bilgisayarına girecek satırları ~/Downloads/lafpos-kasa-ayarlari.env dosyasına yazar (izin 600).
#
# Anahtarlar ekrana basılmaz, depoya yazılmaz. Önceden tanımlı bir değişkene dokunmaz; değiştirmek için --yenile.
# Gerekenler: Vercel CLI girişi (npx vercel login), openssl. Belge: docs/07-UZAKTAN-ERISIM.md §5.
set -euo pipefail

SCOPE="okans-projects-fcf7250e"
OUT="${HOME}/Downloads/lafpos-kasa-ayarlari.env"
VC=(npx -y vercel@50)
RENEW=0
[[ "${1:-}" == "--yenile" ]] && RENEW=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null || die "openssl bulunamadı"
"${VC[@]}" whoami --scope "$SCOPE" >/dev/null 2>&1 || die "Vercel'e giriş yapılmamış: önce 'npx vercel login'"

link() {
  mkdir -p "$TMP/$1"
  (cd "$TMP/$1" && "${VC[@]}" link --yes --project "$1" --scope "$SCOPE" >/dev/null 2>&1) || die "$1 projesi bağlanamadı"
}
has_env() { (cd "$TMP/$1" && "${VC[@]}" env ls production --scope "$SCOPE" 2>/dev/null) | awk '{print $1}' | grep -qx "$2"; }

# put PROJE AD DEĞER: değişken yoksa ekler; varsa --yenile ile değiştirir, yoksa 1 döner (değer bilinmiyor)
put() {
  if has_env "$1" "$2"; then
    if [[ $RENEW -eq 0 ]]; then
      printf '  %s: %s zaten tanımlı, dokunulmadı\n' "$1" "$2"
      return 1
    fi
    (cd "$TMP/$1" && "${VC[@]}" env rm "$2" production --yes --scope "$SCOPE" >/dev/null 2>&1)
  fi
  printf '%s' "$3" | (cd "$TMP/$1" && "${VC[@]}" env add "$2" production --sensitive --yes --scope "$SCOPE" >/dev/null 2>&1) \
    || die "$1: $2 eklenemedi"
  printf '  %s: %s eklendi\n' "$1" "$2"
}

# Son üretim dağıtımı main'den geliyorsa yeniden derler; değilse elle yapılmasını ister
redeploy() {
  local url
  url="$(cd "$TMP/$1" && "${VC[@]}" ls "$1" --prod --scope "$SCOPE" 2>/dev/null | grep -o "https://$1-[a-z0-9]*-$SCOPE.vercel.app" | head -1)"
  [[ -n "$url" ]] || { printf '  %s: üretim dağıtımı bulunamadı; main'"'"'e bir sonraki birleştirme değişkenleri alır\n' "$1"; return; }
  # inspect çıktısını stderr'e yazar; önce değişkene alınır (grep -q erken çıkınca CLI çöküyordu)
  local info
  info="$(cd "$TMP/$1" && "${VC[@]}" inspect "$url" --scope "$SCOPE" 2>&1 || true)"
  if ! grep -q -- "-git-main-" <<<"$info"; then
    printf '  %s: son üretim dağıtımı main'"'"'den değil (%s). Vercel panelinde main'"'"'in son üretim dağıtımını Redeploy edin\n' "$1" "$url"
    return
  fi
  (cd "$TMP/$1" && "${VC[@]}" redeploy "$url" --target production --scope "$SCOPE" >/dev/null 2>&1) \
    && printf '  %s: yeniden derlendi\n' "$1" || printf '  %s: yeniden derleme başlatılamadı; panelden Redeploy\n' "$1"
}

gen() { openssl rand -hex 32; }

say "Projeler bağlanıyor"
for p in laffogato lafmaliyet lafpos; do link "$p"; done

S_SITE="$(gen)"; S_MALIYET="$(gen)"; S_CLOUD="$(gen)"
site_ok=1; maliyet_ok=1; cloud_ok=1

say "Anahtarlar"
put laffogato LAFPOS_SYNC_SECRET "$S_SITE" || site_ok=0
put lafmaliyet LAFPOS_SYNC_SECRET "$S_MALIYET" || maliyet_ok=0
put lafpos LAFPOS_CLOUD_SECRET "$S_CLOUD" || cloud_ok=0

say "Uzaktan giriş parolası (en az 10 karakter; boş bırakırsan üretilir)"
PAROLA=""
if ! has_env lafpos LAFPOS_UZAKTAN_PAROLA || [[ $RENEW -eq 1 ]]; then
  read -r -s -p "  Parola: " PAROLA; echo
  if [[ -z "$PAROLA" ]]; then
    PAROLA="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
    echo "  Parola üretildi; dosyaya yazılacak"
  else
    read -r -s -p "  Tekrar: " P2; echo
    [[ "$PAROLA" == "$P2" ]] || die "Parolalar aynı değil"
    [[ ${#PAROLA} -ge 10 ]] || die "Parola en az 10 karakter olmalı"
  fi
  put lafpos LAFPOS_UZAKTAN_PAROLA "$PAROLA" || true
else
  echo "  lafpos: LAFPOS_UZAKTAN_PAROLA zaten tanımlı, dokunulmadı"
fi

say "Upstash Redis (LafPOS Uzaktan'ın canlı özeti)"
if has_env lafpos KV_REST_API_URL || has_env lafpos UPSTASH_REDIS_REST_URL; then
  echo "  lafpos: Redis zaten bağlı"
else
  echo "  Vercel Marketplace'ten ücretsiz Upstash for Redis eklenecek. Koşulları ve planı (Free) sen onaylayacaksın."
  (cd "$TMP/lafpos" && "${VC[@]}" integration add upstash/upstash-kv --name lafpos-uzaktan -e production -e preview --no-env-pull --scope "$SCOPE") \
    || echo "  Eklenemedi: Vercel › lafpos › Storage › Create Database › Upstash for Redis (Free) ile ekleyip betiği yeniden çalıştırın"
fi

say "Yeniden derleme (değişkenler ancak yeni derlemede okunur)"
for p in laffogato lafmaliyet lafpos; do redeploy "$p"; done

say "Kafe bilgisayarının ayarları"
umask 077
{
  echo "# LafPOS kasa ayarları ($(date '+%d.%m.%Y %H:%M')). Kafe bilgisayarında Başlat › LafPOS › LafPOS ayarları'nı açıp"
  echo "# aşağıdaki satırları ekleyin, kaydedin; LafPOS kendini yeniden başlatır. Bu dosyayı kimseyle paylaşmayın, işi bitince silin."
  echo "# Sıra docs/03-ENTEGRASYON.md §8 'Açılış sırası'nda."
  echo
  echo "# 1. adım (anahtarlar): kurulum modundayken de güvenli, gün gitmez; yalnız maliyet okunur"
  echo "LAFMALIYET_URL=https://ladmin.laffogato.net"
  [[ $maliyet_ok -eq 1 ]] && echo "LAFMALIYET_SYNC_SECRET=$S_MALIYET" || echo "# LAFMALIYET_SYNC_SECRET: lafmaliyet'te zaten tanımlıydı; değeri bilinmiyor (--yenile ile yeniden üretin)"
  echo "LAFPOS_CLOUD_URL=https://lafpos.vercel.app"
  [[ $cloud_ok -eq 1 ]] && echo "LAFPOS_CLOUD_SECRET=$S_CLOUD" || echo "# LAFPOS_CLOUD_SECRET: lafpos'ta zaten tanımlıydı; değeri bilinmiyor (--yenile ile yeniden üretin)"
  echo
  # LafPOS'ta site adresinin varsayılanı yok: bu satır yazılmadıkça kafe siteye hiç bağlanmaz (docs/03-ENTEGRASYON.md §2)
  echo "# 2. adım (deneme gönderimi), eğitim bitip kurulum modu kapandıktan SONRA ekleyin: bu iki satır girilince"
  echo "# LafPOS'taki Tükendi / Satışa aç ve online sipariş aşamaları canlı siteyi ve uygulamayı değiştirir"
  echo "LAFFOGATO_URL=https://laffogato.net"
  [[ $site_ok -eq 1 ]] && echo "LAFFOGATO_SYNC_SECRET=$S_SITE" || echo "# LAFFOGATO_SYNC_SECRET: laffogato'da zaten tanımlıydı; değeri bilinmiyor (--yenile ile yeniden üretin)"
  if [[ -n "$PAROLA" ]]; then
    echo
    echo "# Yalnız senin için, kafeye girmez: https://lafpos.vercel.app giriş parolası"
    echo "# $PAROLA"
  fi
} > "$OUT"
chmod 600 "$OUT"
echo "  Yazıldı: $OUT"

say "Bitti. Denetim: https://laffogato.net/api/pos/orders/version ve https://lafpos.vercel.app/api/health"
echo "  'not_configured' yerine 401 (imza yok) görünüyorsa anahtar tanımlı demektir."
