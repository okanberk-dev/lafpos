#!/bin/zsh
# LafPOS dallarını 10 dakikada bir GitHub'a gönderir; $SP/push-stop dosyası oluşunca ya da 6 saat sonra durur.
cd /Users/okanberkmanavoglu/Downloads/lafpos || exit 1
SP=/private/tmp/claude-501/-Users-okanberkmanavoglu-Downloads/36639f88-6c66-4e9d-babe-a70914f282d6/scratchpad
end=$(( $(date +%s) + 6*3600 ))
while [ ! -f $SP/push-stop ] && [ $(date +%s) -lt $end ]; do
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads/claude/); do
    l=$(git rev-parse $b); r=$(git rev-parse -q --verify refs/remotes/origin/$b 2>/dev/null)
    if [ "$l" != "$r" ]; then
      if git push -q origin $b 2>/dev/null; then echo "$(date +%H:%M) gönderildi $b ${l:0:7}"; else echo "$(date +%H:%M) GÖNDERİLEMEDİ $b"; fi
    fi
  done
  sleep 600
done
echo "$(date +%H:%M) döngü bitti"
