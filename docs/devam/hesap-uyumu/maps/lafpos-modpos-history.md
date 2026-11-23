# Faz 4: ModPOS geçiş günleri ("Geçmiş ciro") and reports, read-only findings

## 1. Where HistoryDay is read and written

**Type and helpers: `/home/user/lafpos/shared/gecmis.ts`**
- `HistoryDay` (l.25-34) has these fields: `{ date, ciro, adisyon, closes:[min,kuruş,adisyon][], pay:[ad,zAlan,tutar,adet][] }`.
- `HistoryStore` (l.36-41) is `{ v:1, kaynak, at, gunler }`.
- Keys:
  - `historyKey(shop)` = `lafpos:gecmis:<shop>` (l.14)
  - `GECMIS_KEY='merkez.gecmis'` (kasa `sync_state`, l.16)
  - flag hash `lafpos:surum` / `gecmis:<shop>` (l.22-23)
- `parseHistory` (l.57-86) validates and then **rebuilds each day explicitly** as `{date,ciro,adisyon,closes,pay}` (l.83). Any new field is therefore silently dropped unless it is added here. Inputs: `kart|nakit|yemek: [tutar, adet]`. The pay sum must equal `ciro`, and the closes sum must equal ciro and adisyon.
- `readHistory` (l.89-97) returns **only `gunler`**. `kaynak` ('ModPOS') is stored but no reader can see it, so reports cannot label "ModPOS" today.
- `historyReport` (l.100-131) builds the remote day:
  - `s: { list: ciro, gross: ciro, comp:0, disc:0, odenmez:0, ... paidClosed: ciro }`, `z: []`, `kdv: []`, `prod: []`, `staff: []`, `types: []`
  - `hours` and `clock` come from `closes`.
- `fillHistory` (l.135-145): for each date the **bigger `rev` wins**. If `cur.s.rev < h.ciro` the whole day is replaced by the history day; the two sources are never merged. Dates `>= today` are skipped.
- `historyStatsDay` (l.148) and `mergeHistoryStats` (l.157-178) feed the patron comparisons with ciro and adisyon only.
- The module doc (l.1-8) says "ürün, personel ve KDV kırılımı yoktur". It needs updating.

**Cloud (Vercel) side**
- Import is `POST merkez/gecmis` in `/home/user/lafpos/api/_merkez.ts:458-471`.
  - Owner-gated (`gate`, l.436). Body is `{id, kaynak, gunler}`. An empty list deletes the record (DEL plus HDEL flag).
  - The store is written at l.468-470.
- Nabız to kasa (`api/_merkez.ts:360`, `:405-408`) sends `{ gecmis: { at, gunler } }` only when `at` differs. It does not send `kaynak` or any store-level field.
- `/home/user/lafpos/api/uzaktan.ts` uses history in four places:
  - `historyOf` cache (l.1263-1276)
  - `statsDays` (l.1278-1291)
  - `withStats` (l.1293-1306)
  - `serveReports` (l.1336-1388): history is read in the same MGET at l.1378-1381, then `fillHistory(..., historyReport)` runs at **l.1384-1385**. The task's "~1384" is this call site; the arithmetic itself is in `sumSummary`, l.895-967.

**Kasa side**
- `/home/user/lafpos/server/sync/merkez.ts:140-153` `takeHistory` stores `{at, gunler}` in `sync_state` under `merkez.gecmis`. Its validator keeps day objects whole, so new optional day fields would pass through. Store-level fields would not.
- `gecmisAt` is sent at l.345-346.
- The only reader is `/home/user/lafpos/server/services/reports.ts:879-880`, inside `patronStats` (the comparisons on the kasa's patron panel).

**Admin UI: none.** No screen uploads history. `src/pages/MerkezPage.tsx` has no gecmis code, so import is API-only (`docs/07-UZAKTAN-ERISIM.md` §"Geçmiş ciro", ~l.316-333). Unrelated name collisions:
- `shared/kontrol.ts:282`, `api/_kontrol.ts`, `src/pages/kontrol/GecmisSekmesi.tsx`: remote-management command history.
- `CashPage` "Geçmiş günler": LafPOS business days.
- `KitchenPage` "Geçmiş" tab.

## 2. Confirmed: history days never reach business_days, the Z chain or the lafmaliyet outbox

- **business_days:** nothing inserts from history. The kasa only sets `sync_state` (`merkez.ts:145,152`). `summaryReport` (`reports.ts:131`) uses `load()`, which reads `schema.businessDays` only (l.64-75).
- **Z chain:** `openDay` (`server/services/days.ts:~38-58`) uses `nextZNo(lastZNo(t), getSettings().zNoStart)` from `shared/z-no.ts:11`, so only business_days and the setting count. ModPOS Z numbers (`Z-2026-002…010`) are strings and appear nowhere. If the Z chain should continue from ModPOS's last Z (`Z-2026-010`), Marina's `zNoStart` should be 11 (Yönetim › Ayarlar, `settings.ts:128`).
- **lafmaliyet outbox:** `enqueueDay` (`server/sync/lafmaliyet.ts:358-370`) uses `buildDayPayload(dayId)` (l.240-241), which reads `businessDays`. `realDay` (l.344) drops training days. ModPOS days reach lafmaliyet only through lafmaliyet's own ModPOS pull (`/home/user/lafmaliyet/src/server/actions/modpos.ts`, `src/server/modpos/sync.ts`; `docs/KALANLAR.md:95-99`).
- **Cloud report push:** `buildDayReport` (`server/sync/cloud-reports.ts:73-127`) also reads business_days only. **But it does not filter `trainingDay`**, so LafPOS trial days are pushed to Uzaktan and compete with ModPOS days in `fillHistory` (see §3).

## 3. How the Uzaktan Ciro report computes figures today (`sumSummary`, api/uzaktan.ts:895-967)

The days come from `fillHistory(dates, lafposDays, history, today, historyReport)`. Every figure is a plain sum over the days:

| Line | Code | ModPOS day contributes |
|---|---|---|
| Liste değeri | `Σ s.list` (l.942) | ciro (it should be ciro + disc + ödenmez) |
| Ciro dışı | `Σ s.comp` | **0** |
| İndirim | `Σ s.disc` | **0** |
| Ciro | `Σ s.rev` (l.897) | ciro ✓ |
| KDV | `Σ kdv rows` (l.917-922, 926) | **0** (`kdv: []`) |
| Net (KDV hariç) | `netSales − kdvTotal` | ciro, i.e. treated as VAT-free |

The UI labels are in `src/pages/reports/ReportsPage.tsx:614-622`. "Ciro dışı (ikram, ödenmez, zayi)" is shown when `s.odenmez || s.zayi`.

**Reproduction for 13–22.11 (kuruş):**
- ModPOS Σ (13–21): ciro **2,734,875**, disc 206,625, ödenmez 150,000, fiş 135, card 1,974,425, cash 760,450.
- Per-day `splitKdv(ciro,10)` bases: 35455, 301000, 523000, 242727, 149205, 219932, 230523, 364364, 420045. Σ = **2,486,251**, KDV 248,624.
- Shown today:
  - discount 90.00, ciro dışı 1,065.00 and KDV 615.91 all come **only from LafPOS days**.
  - net 33,507.84 = Σrev − 615.91, so **Σrev shown = 34,123.75**.
- 615.91 KDV corresponds to 6,775.00 gross at 10% (6775/11 = 615.909). LafPOS days in the range therefore contribute **6,775.00**.

**Expected (task):**
- disc 2,066.25 + 90 = **2,156.25** ✓
- ödenmez 1,500 + 1,065 = **2,565.00** ✓
- ciro 27,348.75 + 6,285.00 = **33,633.75**
- Net of VAT: 24,862.51 + 5,713.64 (`round(6285/1.1)`) = **30,576.15** ✓, so KDV is **3,057.60**.
- Check: period-level `round(33,633.75/1.1)` = 30,576.14. The per-day sum is what `sumSummary` already does.

**Flag: a 490.00 gap in the task's own numbers.** Current Ciro is 34,123.75, but expected is 33,633.75. The history code does not explain this. The LafPOS revenue in the range is 6,775.00, not 6,285.00 (571.36 KDV). Likely cause is a LafPOS **trial/training day** pushed to the cloud:
- either a LafPOS trial day of 880.00 on 13.11 beat ModPOS's 390.00 under "bigger wins",
- or 490.00 of trial sales sits on 22.11, or on a pre-13.11 date if the range was "Bu ay" (1–22.11).

Why trial days get in:
- `summaryReport` and `buildDayReport` do not exclude `trainingDay`.
- `patronStats` (`reports.ts:859-863`) and lafmaliyet (`realDay`) do exclude it.

To verify, read `lafpos:rapor:<shop>:gun:2026-11-13..22` (`s.rev`, `n`, `z`) and the kasa's `business_days.trainingDay`. I did not read Redis or the DB.

## 4. What must change

**Data shape (`shared/gecmis.ts`)**
- Add optional day fields, for example:
  - `indirim?` (kuruş)
  - `odenmez?`
  - `kdv?: [oran, dahil, matrah, kdv][]`, or derive it as `splitKdv(ciro, kdvOrani ?? 10)` from `shared/money.ts:80`
  - `z?: string` (ModPOS "Z-2026-002"; a string, so do not put it in `RemoteDayReport.z: number[]`)
- `parseHistory` l.83 must copy and validate these fields with `nat`. Suggested invariants: `Σkdv.dahil === ciro`, `indirim`/`odenmez` ≥ 0.
- Add a **store-level** period product block, for example `HistoryStore.urunler?: { from, to, rows:[ad, boy, kategori, adet, tutarIndirimOncesi][] }`.
  - Sanity check: 29,415.00 = Σ(ciro + indirim) over 13–21 (27,348.75 + 2,066.25). The block is **pre-discount and excludes ödenmez**.
  - LafPOS product revenue is after discount (`lineNet`, `reports.ts:276-278`). Adding the block as-is breaks the "ürün cirosu + servis = toplam ciro" invariant (`ReportsPage.tsx` `ProductsData`) by 2,066.25. Either label it "ModPOS · indirim öncesi" as its own block, or apportion the discount.
  - The block is a period aggregate. Show it only when the range covers 13–21 entirely, or show it with a note; per-day ranges cannot be apportioned.
- Change `readHistory` (or add `readHistoryStore`) so `kaynak` and `urunler` are available.

**`historyReport` (gecmis.ts:100-131)**
- `gross = ciro + indirim`, `comp = odenmez`, `odenmez = odenmez`, `disc = indirim`, `list = gross + comp`.
- `kdv = [[10, ciro, base, ciro − base]]`.
- Add `kaynak: 'ModPOS'` and `zText` as new optional `RemoteDayReport` fields (`shared/remote-reports.ts:48-85`).

**`sumSummary` (uzaktan.ts:895-967)**
- The waterfall is then correct with no further change.
- `byDay` (l.962) must carry `kaynak` and `zText`.
- `ReportsPage.tsx:418` `byDay` type and the "Günlük ciro" chart (l.578) need a ModPOS label or legend.
- The footer (l.~690) "ciro kapanmış adisyonlardan" and the "Ciro dökümü" subtitle need a "13–21 Kas ModPOS" note.
- `itemsSold` should include the block's 240 when the period is covered.

**Other Uzaktan tabs**
- `sumProducts` (l.1028): `prod` is empty for history days. The period block needs to be added here (`serveReports` must pass the store).
- `sumHourly` (l.985): days without `closes` add nothing, but `n` counts.
- `sumStaff` (l.1064): nothing from history.
- `serveExtra` (l.1410+): the `items('indirim'|'ikram')` totals come from `extras` only. After the fix they would show 90 / 1,065 while the waterfall shows 2,156.25 / 2,565. They need a ModPOS aggregate row or a notice. ModPOS has no rows for checks or refunds.
- `platforms` `netSales` includes ModPOS ciro.

**Kasa-side reports**
- The kasa Raporlar screen (`/raporlar`, `summaryReport`/`productReport`/`hourlyReport`), the Z view (`src/pages/cash/ZView.tsx`, `/cash/days`) and CashPage "Geçmiş günler" **never show history days**. Only patron comparisons do (`reports.ts:880`).
- If local reports should include and label them:
  - Nabız must send `kaynak` and the block (`api/_merkez.ts:408`).
  - `takeHistory` must store them (`merkez.ts:152`).
  - `summaryReport` (`reports.ts:131`) needs a merge step mirroring `fillHistory`.
- The Z report should remain LafPOS-only. At most, show "ModPOS Z-2026-0xx" as a label.
- `ReportsPage.tsx` is shared by the kasa and Uzaktan (`REMOTE` flag, l.51).
- "Monthly report" is the Ciro tab with the "Bu ay" or "Geçen ay" period (`src/lib/period.ts:3-40`). There is no separate monthly endpoint.

**Docs and rules**
- `docs/07-UZAKTAN-ERISIM.md` §Geçmiş ciro.
- `gecmis.ts` header.
- UI changes require `npm run build && npm run e2e`. `e2e/uzaktan.mjs` has the Uzaktan routes.
- Consider excluding training days from `buildDayReport`/`summaryReport`, or making `fillHistory` prefer history over trial days. That is a separate decision.

## 5. How to reproduce the bug in a test today

1. **Unit test, extending `/home/user/lafpos/tests/gecmis.test.ts`.**
   - Build the 9 ModPOS days with `parseHistory` (kuruş, `kart`/`nakit` `[tutar, adet]`).
   - Add one LafPOS `RemoteDayReport` for 22.11 using the `day()` shape from `tests/denetim-raporlar.test.ts:66-87`, with `s.disc=9000`, `s.comp=106500`, `s.odenmez>0`, `rev=628500` and `kdv=[[10,628500,571364,57136]]`.
   - Then:
     ```ts
     const { sumSummary } = await import('../api/uzaktan');
     sumSummary({from:'2026-11-13',to:'2026-11-22'}, fillHistory(dates, [lafpos22], hist, '2026-11-23', historyReport), [], at, '2026-11-23')
     ```
     The same pattern is at `denetim-raporlar.test.ts:119-133`.
   - Today it yields `waterfall.discounts=9000`, `complimentary=106500`, `kdv=57136`, `netExKdv=revenue−57136`.
   - Assert the expected values: 215625 / 256500 / 305760 / 3057615 / revenue 3363375.
   - Add a variant with an 88000 trial day on 13.11 to show it displacing ModPOS's 39000 (the 490.00 effect).
2. **HTTP path:** use the in-memory Redis plus the `remote()` helper in `tests/denetim-raporlar.test.ts:18-64`. Set `store.set(historyKey(shop), JSON.stringify({v:1,kaynak:'ModPOS',at:1,gunler}))` and the `lafpos:rapor:<shop>:gun:2026-11-22` key, then GET `reports/summary?from=2026-11-13&to=2026-11-22`. Products: `reports/products` shows an empty ModPOS contribution today.
3. **Kasa round trip:** follow `tests/merkez.test.ts:433-449` (`panel('POST','merkez/gecmis',…)`, `merkezBeat()`, `/reports/patron`). Assert that the new fields and `kaynak` reach `sync_state` and that `/reports/summary` on the kasa still excludes them, or includes them if that is chosen.
4. **Isolation guard:** after upload and beat, check that `business_days` and the outbox are unchanged and `nextZNo` is unchanged (the `tests/z-baslangic.test.ts` pattern).
5. **Import validation:** follow `tests/gecmis.test.ts:15-44` for the new invariants (KDV dahil = ciro, block total vs Σ(ciro + indirim)).
