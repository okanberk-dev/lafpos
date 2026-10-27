# LafPOS çalışma notları

Claude'un uzun soluklu işi (27 Ekim 2026) için plan ve ara sonuçlar. Kod değil; `main`'e birleştirilmez.

| Dosya | Ne |
|---|---|
| `PLAN.md` | Kaldığı yer, sıra, kullanıcının istekleri, dersler (limit, Vercel dağıtım sınırı) |
| `denetim/claims.json` | Tam sistem denetiminin 74 bulgusu (doğrulayıcı oylarıyla) |
| `denetim/group-*.json` | Bulguların düzeltme alanlarına bölünmüşü |
| `fix-args.json` | Düzeltme iş akışının girdileri |
| `is-akislari/*.js` | Çalıştırılan iş akışı betikleri |
| `arastirma/` | LafPOS envanteri, rakip POS araştırmaları, laffogato/lafmaliyet/Vercel sözleşme denetimi |
| `periodic-push.sh` | Dalları 10 dakikada bir GitHub'a gönderen döngü |

Dallar: düzeltmeler `claude/fix-<alan>`, servis modu `claude/servis-modu`, entegrasyon `claude/inceleme-duzeltmeleri`.
