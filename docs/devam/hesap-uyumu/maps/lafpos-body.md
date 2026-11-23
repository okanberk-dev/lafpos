# LafPOS: the Faz 2 sender of the end-of-day body (read-only report)

## Things in the task that don't match the code
1. **Amounts on the wire are TL with 2 decimals, not kuruş.** The builder converts with `toTL(k)=Math.round(k)/100` (`server/sync/lafmaliyet.ts:237`). Docs §4 say "Tutarlar TL". On the lafmaliyet side, `tl = z.number().min(0)` (`/home/user/lafmaliyet/src/lib/lafpos/day.ts:26`), so negative values are rejected; only `signedTl` accepts them (`cashDiff`). Any new negative field, such as a diff, needs `signedTl` there. New money fields should be TL, or carry an explicit `*Kurus` name.
2. **`sube` is written in two places.** At build time, `lafmaliyet.ts:291`. At send time it is overwritten, `lafmaliyet.ts:521` (`{...row.payload, sube: getSettings().branchId}`).
3. **`offDevice`** is computed at `server/services/days.ts:289` and returned at :307 (the task said ~282).
4. **`voidAfterSend` is not "sent to bar".** It is `!fresh && it.status !== 'yeni'` (`server/services/orders.ts:636`). A stationless item (bar off, or a product with no station) is inserted with `status:'servis'` (orders.ts:469), so cancelling it sets `voidAfterSend = true` even though nothing was prepared. This confirms the task: use `startedAt`/`readyAt`.
5. **`CompPersonKind` is only `'user' | 'customer'`** (`shared/types.ts:620`). There is no stored "patron" kind; it must come from `users.role === 'patron'` (`server/db/schema.ts:31`).
6. **Comment drift:** `ZSummary.complimentary` says "ikram ve ödenmez birlikte" (`shared/types.ts:653`), but it also contains zayi.
7. **`version` must stay 1.** lafmaliyet has `version: z.literal(1)` (day.ts:156) and would answer 400 to anything else. lafmaliyet's `posDaySchema` is a plain `z.object` (not `.strict`), so unknown optional fields are stripped and additive fields are safe to send first. lafmaliyet should read the new ones with `.optional().catch(undefined)`, like `bankPos` (day.ts:169), so a bad field never rejects the whole day.
8. **lafmaliyet already parses the reason prefixes.** It reads the "Zayi: " prefix (`/home/user/lafmaliyet/src/lib/lafpos/ikram.ts:16-41`). A new `kind` field must be additive; the `compReasonText` prefix has to stay in `reason`.

## Current pipeline

**Builder.** `buildDayPayload(dayId)` at `lafmaliyet.ts:240-331`.
- `summary = day.summary ?? computeSummary` is the Z frozen at close.
- `z` comes from `lafmaliyetZ` (`days.ts:479-501`).
- `lines` come from `salesOf` (:191), which is `itemParts` (:121) followed by `mergeParts` (:149).
- `ikram` (:317-328) takes comped, non-voided items of closed POS orders only (:249-252) and splits them with `itemParts(i, qty*unitPrice)`. `reason` is `compReasonText` (`shared/comp.ts`, "Ödenmez: "/"Zayi: ").
- `payments` = `summary.payments` (:329).
- `cardTips`/`cardCollections` are live card payments with `refundedAt` null (:254-258, :313-314).
- `bankPos` reads `sync_state pavo.eod.<dayId>` (:261-283) and is omitted when the status is `skipped` or `running`.
- Lines, ikram and card values are recomputed live; `z` and `payments` come from the frozen summary.

**Type.** There is no named TS type or Zod schema on the LafPOS side; the return type is inferred. The test declares its own `Payload` type (`tests/lafmaliyet-gun.test.ts:32-40`). The real schema is lafmaliyet `posDaySchema` (day.ts:155-170).

**Contract.** `docs/03-ENTEGRASYON.md` §4 is lines 597-712 (body example 616-643, optional-field bullets 645-710). §4.2 replies are 748-781, §4.3 training days 783, §4.4 backfill 816. AGENTS rule 2: every new field goes into §4 first.

**Golden fixture.**
- Scenario: `tests/lafmaliyet-gun.test.ts:85-158` (golden date 2026-10-26). It asserts byte equality at :143-144 and checks invariants: Σlines.revenue = zTotal, Σikram.menuValue = offRevenue.
- Regenerate with `LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts` (writes at :139-141). Then copy to `/home/user/lafmaliyet/tests/fixtures/lafpos-gun.golden.json`, which is read by lafmaliyet `tests/lafpos.test.ts:677-680`. The two files are byte-identical today (checked with `cmp`).
- Gaps in the current golden: `discounts: 0`, and no voids, refunds, ödenmez/zayi, offDevice or bankPos. The scenario must be extended for the new fields to mean anything, which changes existing numbers too.

**Signing.** `server/lib/signature.ts`: `canonicalString` = timestamp, METHOD, `url.pathname`, sorted query, sha256(body) (:28-36). `signedFetch` signs `JSON.stringify(body)` (:60) and does not follow redirects. Path and body are covered, the host is not, so additive fields do not break the signature. Vector for `/api/pos/gun` is at `tests/signature.test.ts:23`.

**Outbox and retry.**
- `enqueueDay` (:358-371): only when configured, not in training mode, and `realDay`. It builds the payload at enqueue time, deletes the pending row with the same `dedupeKey gun:<date>` and inserts a new one.
- `flushOutbox` (:377) has a single-flight `running` lock and runs every 60 s (`server/jobs.ts:282`).
- `sendDue` (:506-571): 20 rows per run, ordered by id. 400/409/413/422 are permanent (`PERMANENT` :441, parked 365 days). Any other non-200, or a 200 without `ok:true` and the same `date`, triggers backoff `min(6h, 60s·2^min(n,8))` (:554). On success it sets `sentAt` and `response`, and sets `exportedAt` only if `closedAt <= row.createdAt`.
- Enqueue callers: day close (`routes/cash.ts:152` → `afterDayClosed` :759), recount (`cash.ts:184`), auto day-end (`jobs.ts:221`), Pavo EOD result (`okc/service.ts:1176`), backfill (:651), push-now (:587). Preview route: `GET /api/sync/lafmaliyet/gun/:dayId` (`routes/sync.ts:245`).

## How the numbers are computed today
- **Discount allocation** (`shared/order-calc.ts:107-185`, `calcOrder`): a line discount is capped at line gross. The order discount (percent via `percentOf`, or an amount) is spread over chargeable lines in proportion to after-line-discount value, using `allocate` (largest remainder, `shared/money.ts` ~:103). Result is `lineNet[id]`. Service is computed on the after-discount amount and added to the KDV map at `SERVICE_KDV_RATE=10`.
- **Item to parts:** `itemParts` splits value between the main product and addons with weights `[unitPrice − Σaddon.price·qty, …addon.price·qty]`, again via `allocate`.
- **Happy hour:** `unitPrice` already includes the happy-hour cut (orders.ts:426-430, flag `happyHour`, `basePrice` = size price). The happy-hour reduction is not in `discounts`.
- **VAT rounding is per adisyon (order), per rate:** `splitKdv` (roundHalfUp) inside `calcOrder`, then summed per rate in `computeSummary` (days.ts:224-230, :308). It is not per fiscal receipt. The ÖKC basket aligns gross per rate per order (`server/okc/basket.ts` header), but the device splits base/VAT per receipt, so ±1 kuruş per receipt and rate is possible.
- **`receipts`** = closed POS adisyons with `total > 0` (days.ts:293). Zero-total closes (fully ikram/ödenmez/zayi, 100% discount) are excluded. This is an adisyon count, not a fiscal-receipt count.
- **`offRevenue`** = `toTL(s.complimentary)` (days.ts:490). `complimentary` = Σ `calcOrder.complimentary` (every comp line, any `compKind`) over closed POS orders, so it includes ödenmez and zayi. `s.odenmez` and `s.zayi` are computed separately over the same scope (days.ts:234-238) and are missing from old stored Zs.

## Planned additive fields

**`lines[].gross`**
- **Now:** only `revenue` (lineNet share).
- **Change:** add `gross` to `Part`/`SaleLine` and compute it in `salesOf` with `itemParts(i, i.qty*i.unitPrice)`, which uses the same weights. Sum it in `mergeParts`. The service line has gross = `t.service`.
- **Invariant:** Σ(gross−revenue) over product lines = `z.discounts`. The gross is after happy hour; flag that in the docs or add a pre-happy-hour figure.

**`lines[].isAddon`**
- **Now:** addons are not modifiers on the line. `addonsOf(i.options)` (by code: milk≠`normal`, syrup≠`none`, extraShot by qty) turns them into separate parts named `EXTRA SHOT`/`SYRUP`/`ALTERNATIF SÜT` (`ADDON_NAMES` :41, site ids `mnu-0081/0080/0082` :45).
- **Change:** set `isAddon` on the `k>0` parts in `itemParts`.
- **Caveat:** the `extras` site items exist as sellable products (menu-snapshot). A standalone "Ekstra Shot" may merge under the same `partKey` (posName|siteMenuId|slot, :142), so either add `isAddon` to the key or send an `addonQty`.

**`z.listValue`**
- = `toTL(s.gross)` (chargeable product gross, no comp/void, before discounts). Alternatively derive it from Σ`lines.gross`.

**`z.ikramTotal` / `odenmezTotal` / `zayiTotal`**
- Easiest and self-consistent: group the already loaded `comps` (:250) by `compKind ?? 'ikram'` and sum `qty*unitPrice`. That works for old days too.
- `s.odenmez` and `s.zayi` exist only in newer Zs. ikram = complimentary − odenmez − zayi.

**`z.vat[]`**
- `summary.kdv` already holds `{rate, gross, base, kdv}` in kuruş (closed POS orders, service included). Send it as `{rate, base: toTL, vat: toTL}`.

**`z.openedAt` / `z.closedAt`**
- `business_days.openedAt` and `closedAt` (ms) as ISO, like `bankPos.at`. `closedAt` is the last close. Consider also sending `reopenedAt`.

**`z.okcZNo`**
- Comes from `fiscal_receipts.zNo` (schema.ts:776+; set at okc/service.ts:473/500).
- Query receipts with `status='tamamlandi'` whose `orderId` is among the day's orders, or whose `paymentIds` intersect the day's payments (`deviceReceipts` pattern, days.ts:182).
- One day can span several device Zs, so send a sorted distinct array or the max. e-Arşiv documents have no zNo. LafPOS's own `zNo` is a separate counter (`nextZNo`/`zNoStart`).

**`offDevice {card, cash}`**
- `summary.offDevice` (`offDeviceTotals`, order-calc.ts:441): card and cash sales payments, excluding tips, whose ids are not in any `fiscal_receipts.paymentIds`.
- Missing in old Zs: recompute with `offDeviceTotals(pays, deviceReceipts(db,[day.id]))` or omit.

**`refunds[]`**
- **Data:** `payments` with `dayId=day` and `refundedAt` not null. Fields: `amount`, `zField`/`methodName`, `paymentMethods.channel`, `refundReason`.
- **Net out the rewrite:** a payment re-written after a partial item refund has `note` = `REFUND_REWRITE` (`'İade sonrası: '`) + the original payment's id (`orders.ts:1854`, :1942). Its amount must be subtracted from that original refund, exactly as `refundReport` does (`server/services/reports.ts:619-641`).
- **Reason prefixes:** `'İade: '` (REFUND_VOID :1856) and `'Yazarkasada fiş iptal edildi'` (refundExternalPayments via okc/service.ts:560).
- Do not send `refundedBy`.
- `refundPayment` only works on the open day (orders.ts:1714), so refunds always fall on the payment's day.

**`iptal[]`**
- **Data:** voided items of all POS orders of the day (scope as computeSummary :244-251).
- **`prepared`:** `startedAt != null || readyAt != null`. The voided row keeps both, because `splitItem` copies `...it` (orders.ts:241-257). `setItemsStatus` sets `startedAt` on hazirlaniyor/hazir/servis (:2038-2042).
- **Fields:** key via `itemParts(i, qty*unitPrice)` plus the `names` map (as ikram does), `qty`, `listValue = qty*unitPrice`, `reason = voidReason` (`'Adisyon iptali'` by default from cancelOrder :1804).
- **Refunds:** flag item refunds (`voidReason` starting with `'İade: '`) with something like a `refund` flag, or they double-count with `refunds[]`.

**`ikram[].kind` / `personKind`**
- `kind` = `compKind ?? 'ikram'`.
- `personKind` exists only on ödenmez, from `compPersonKind/compPersonId/compPersonName` (schema.ts:~563-566; set by `resolveCompPerson`, orders.ts:~700-720). Mapping: `customer` → musteri; `user` → join `users.role`, `'patron'` → patron, otherwise personel; null → null.
- No id or name may go out: `tests/odenmez-kisi.test.ts:238-245` asserts this.
- Docs §4 currently say the person "pakete girmez", so the docs need updating.

**`bankPos.errorCode`**
- `PavoEodRecord.errorCode` exists (okc/service.ts:989, set at :1246/:1284) but is missing from the `getSyncState` type and the object at lafmaliyet.ts:261-283. Add `errorCode: eod.errorCode ?? null`.
- **Comparison basis** is `cardBasis` (okc/service.ts:1055-1083): Z card + card tips + card collections, or since the previous batch.
- **Card taken outside Pavo:** off-device card (`summary.offDevice.card`) never reaches Pavo and must be subtracted. For later batches, filter `rows` by `deviceReceipts`. Card tips on off-device payments are also off-Pavo.
- **Card voided on the ÖKC:**
  - Same-day voids are already refunded (excluded).
  - A void after the day closed sets `fiscal_receipts.status='fis_iptal'` and leaves the LafPOS payment live (okc/service.ts:540-555, audit `okc.void_closed_day`). Subtract the card payments in those `paymentIds`.
  - `deviceReceipts` does not filter by status.
- Unknown: whether card collections actually go through Pavo.

**`revision` / `correction`**
- **Reopen:** `reopenDay` (days.ts:332-359) clears `closedAt`, `summary`, `exportedAt` and `trainingDay`, sets `reopenedAt`, and deletes pending `gun:<date>` rows. The zNo stays the same, and closeDay never clears `reopenedAt`.
- **Reason is not stored structurally.** The `day.reopen` audit entry has the reason only inside `message` (no entity/entityId/data; :348-354), and the audit log is wiped by deneme bitir. Store it, either as a `reopenReason` column (migration via `npm run db:generate`) or as `data: {dayId, reason}` on the audit entry.
- **Recount** (`recordCount` :606-643, `day.recount`) is also a correction. A Pavo EOD re-enqueue is a new revision but not a correction.
- **Revision must be deterministic** so the golden stays stable; do not use `Date.now()`. Two options:
  - Compute it in `buildDayPayload` as (count of sent outbox rows for `gun:<date>`, target lafmaliyet) + 1. Sent rows are never deleted except by deneme bitir.
  - Add a `business_days.revision` column.

**`sube` lock**
- **Now:** `branchId` (default `marina`, `server/lib/settings.ts:137/173`) is patron-only and audited as `settings.branchId`. Validated at `routes/admin.ts:1009`; PUT handler `admin.ts:1049-1132` (`PATRON_SETTINGS` :1047). UI: `src/pages/admin/SettingsAdmin.tsx:241,485-489` (Yönetim › Ayarlar ve yedek › Şube kimliği). No lock exists.
- **Change:** in the PUT handler, if `getSyncState('lafmaliyet.push')?.lastSuccessAt` is set (or any sent lafmaliyet outbox row exists) and branchId changes, return 409 `branch_locked` unless a separate confirm flag is sent.
- branchId also drives site reads (`laffogato-link.ts:23`) and platform keys (admin.ts:1131).

## How to reproduce or test today
- **Body shape:** follow `tests/lafmaliyet-gun.test.ts` helpers `freshDay`, `sell`, `pay`, `comp`, `payloadOf`. Today `lines[0]` has no `gross`, there is no `kind` on ikram, and so on.
- **Prepared vs voidAfterSend:** set `PUT /admin/settings {barEnabled:false}`, sell, void with `POST /orders/:id/items/:itemId/void` plus `approverPin`. Then `voidAfterSend=true` while `startedAt` is null. Bar transitions use `POST /api/kitchen/status` (`routes/pos.ts:510`).
- **Ödenmez person:** `POST /orders/:id/comp {kind:'odenmez', person:{kind:'user', id}}`, following `tests/odenmez-kisi.test.ts`.
- **Refund netting:** `POST /orders/:id/refund-items` (pos.ts:371).
- **Sending, revision and lock:** use the fake-lafmaliyet servers in `tests/ladmin-baglanti.test.ts` (`posts[]`, `insertDay`, `sendOnce` :60-82) or `tests/lafmaliyet-gecis.test.ts` (`calls[]`, `drain`).
  - Lock bug: send a day with a 200 reply, then `h.call('patron','PUT','/admin/settings',{branchId:'tuzla'})` returns 200 today.
  - The existing test at ladmin-baglanti.test.ts:177 calls `updateSettings` directly, so a route-level lock will not break it.
- **bankPos:** follow ladmin-baglanti.test.ts:199-236 (`setSyncState('pavo.eod.<id>')`, `cardBasis`) and `tests/pavo.test.ts:704-707`.
- **offDevice and ÖKC voids:** follow `tests/iade-yazarkasa.test.ts` (simulator provider, `/okc/orders/:id/send`).
