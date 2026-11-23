# Staff identity link: LafPOS users and ladmin staff. Read-only map and design

## 1. ladmin (`/home/user/lafmaliyet`): what exists

**ladmin has three separate identity spaces, and nothing links them.**
- `users` (`src/server/db/schema.ts:44-73`) is the login account: `id serial`, `email`, `name`, `role 'admin'|'staff'`, and `branchId` (nullable; null means all branches; not used for admins), plus `active`.
  - **There is no staff FK.**
  - People can rename themselves under Hesabım (`src/lib/activity-person.ts`: `sameName`, `nameTakenBy`), so a name is not a stable key.
- `staff` (`schema.ts:641-653`) is the payroll row: `id serial`, `branchId` **NOT NULL default 'tuzla'** (`branchId()` helper, `:36`), `name`, `netSalary`, `extras` (TL double), `active`, `startMonth`, `endMonth`, `sortOrder`.
  - **There is no userId.**
  - Salary history is in `staffVersions` (`:655-668`, `fromMonth`, `netSalary`, `extras`).
- `shifts` (Vardiya, `schema.ts:2415-2441`, migration `0067_karaoke_hatirlatma_vardiya.sql`) has `branchId`, `date`, `personRef` and `userId`.
  - `personRef` is `"u:<users.id>"` for an account, or `"n:<folded name>"` for a worker with no account (e.g. part-time).
  - Other columns: `personName` (snapshot), `kind 'work'|'off'`, `startMin`, `endMin`, `note`.
  - Helpers in `src/lib/vardiya.ts:235-243`: `userRef`, `nameRef`, `refUserId`.
  - Store: `src/server/vardiya/store.ts` (`loadShiftEntries` :52, `loadShiftWeek` :71).
  - `docs/VARDIYA.md:58` says the screen shows no amounts.

**So "ladmin already has their accounts" is ambiguous.** An account (`users.id`) is not a payroll row (`staff.id`):
- The meal card and pay live on `staff`.
- Vardiya keys on `users.id` or a bare name.

**Worked days today: nothing counts them.**
- No code counts shifts per person per month.
- `shifts` is read only by Bugün ("Vardiyada: …"), karaoke staff emails (`src/server/karaoke/staff-mail.ts`) and checklist alerts.

**Meal card: no per-day logic anywhere.**
- `extras` is a single monthly figure labelled "Yemek / yol / prim" (`src/app/panel/personel/staff-editor.tsx:476-477, 1078`).
- It is added unchanged in `staffCost` (`src/lib/calc/engine.ts:345-358`; `personnelSummary` :367).
- The Maaşlar screen is `src/app/panel/personel/page.tsx` (admin only, `requireAdmin`), with the save action `saveStaff` (`src/server/actions/costs.ts:142`).
- `staff.id` is stable: rows are updated in place (:242). A row can be deleted only if it never entered a past month's payroll (`staffUsedMonths`, :166-174; `staffDeleteBlockers` :277).
- A new person gets the selected physical branch, or Tuzla when "Tümü" is selected (:157-161). Marina staff may therefore wrongly sit on Tuzla.

**Existing LafPOS mapping: none** (grep for `staffRef|workedStaff|staff_id` in both repos finds nothing).

**Signed endpoints LafPOS calls**
- **Signature code**
  - `src/lib/karaoke/signature.ts`: `canonicalString` = ts\nMETHOD\npath\nsorted query\nsha256(body); headers `x-laf-timestamp` and `x-laf-signature: v1=<hex>`; `verifySignature` ±300 s, constant time, no nonce.
  - `src/lib/lafpos/request.ts`: `lafposSecretFrom` (`LAFPOS_SYNC_SECRET` ≥32 chars and different from `KARAOKE_SYNC_SECRET`); `checkLafposRequest` returns 503/413/401.
- **`POST /api/pos/gun`** (`src/app/api/pos/gun/route.ts`) goes through `handlePosDay` (`src/server/lafpos/status.ts:141`) to `receivePosDay` (`src/server/lafpos/ingest.ts:123`).
  - `sube` ≠ `LAFPOS_BRANCH_ID` returns 409 `wrong_branch` (:133; `LAFPOS_BRANCH_ID = "marina"`, `src/lib/lafpos/switch.ts:47`).
  - `storePosDay` (:46) runs in one tx under an advisory lock. It upserts `posDayReports` (`schema.ts:2238`, PK `(date, branchId)`, jsonb `z`/`payments`/`ikram`/`bankPos`) and replaces `posDailySales`.
  - `bankPos` is written only when present (`ingest.ts:85`). This is the pattern to copy.
- **Body schema**: `posDaySchema` (`src/lib/lafpos/day.ts:155-170`) is a plain `z.object`, so unknown keys are stripped. A new field is ignored by today's ladmin, so it is additive-safe.
  - `bankPos` uses `.nullable().optional().catch(undefined)` (:169): a bad optional field never rejects the day.
- **`GET /api/panel/pos/urunler`** (`src/app/api/panel/pos/urunler/route.ts`, core `servePosProducts` in `src/server/lafpos/products.ts`) is the template for a signed GET.
  - `src/proxy.ts:53` matches only `/panel/*`, `/giris` and `/api/export/*`, so a new `/api/panel/pos/*` route is outside session auth.
- **Status card**: `integration_state` key lafpos (`status.ts:43-104`, with `rejections[date]`), shown in Ayarlar › LafPOS (`src/app/panel/ayarlar/lafpos-card.tsx`, `lafpos-client.tsx`).

**Tests**: `npm test` = `tsx --test tests/*.test.ts` (node:test).
- Database tests need a real Postgres: `LAFPOS_TEST_DATABASE_URL=… npx tsx --test tests/lafpos-db.test.ts`, otherwise they are skipped.
- Relevant tests: `tests/lafpos.test.ts` (signature vectors, body), `lafpos-durum-db.test.ts`, `vardiya.test.ts`, `personel-*.test.ts`.
- Golden body: `tests/fixtures/lafpos-gun.golden.json` is a byte-for-byte copy of LafPOS's `tests/fixtures/lafmaliyet-gun.golden.json`.

## 2. LafPOS (`/home/user/lafpos`): what exists

**Users** (`server/db/schema.ts:28-42`): `id` (ULID text), `name` (≤40, often a first name only), `role` (`ROLES` = patron, mudur, kasiyer, garson, mutfak, kurye; `shared/permissions.ts:10`), `pinHash` (unique HMAC), `color`, `active`, `permGrant`/`permRevoke`, `maxDiscountPct`, `lastLoginAt`.

**Admin routes** (`server/routes/admin.ts`), all `personel.yonet` (by default patron only; mudur has every permission except this, `permissions.ts:61`):
- `GET /users` :686; `userShape` :700; `POST /users` :845; `PATCH /users/:id` :859 (`patchOf(userShape)`, sessions dropped on permission change).
- `changed()` :48 writes the audit entry and emits the event.
- UI: `src/pages/admin/UsersAdmin.tsx` (`UserDrawer` :263); route `/yonetim/personel` (`e2e/run.mjs:256`).

**Who worked a day: no attendance record exists.**
- Mesai (clock-in) was removed on 4 Nov 2026 (owner decision; `docs/02-PLAN.md:302-309`). `time_entries` (`schema.ts:60-89`) is dead.
- Logins are not audited (`server/routes/auth.ts:33` → `createSession`, `server/lib/auth.ts:246`).
- Sessions are deleted on logout (:263), and `lastLoginAt` holds only the latest login.

**Per-day activity signals that do exist** (all keyed to `users.id`):
| Source | Columns |
|---|---|
| `businessDays` | `openedBy`/`closedBy` (:318/:321) |
| `orders` (`dayId`) | `waiterId`/`openedBy`/`closedBy` (:464/:477/:479) |
| `orderItems` | `createdBy` (:611) |
| `payments` (`dayId`) | `userId` (:645) |
| `cashMovements` | `userId` (:352) |
| `shiftCounts` (vardiya devri: shift hand-over count) | `userId`/`toUserId` (:370/:374) |
| `auditLog` | `userId` (:722) |

These signals miss anyone who works under someone else's login (shared till) or never logs in (bar or kitchen staff).

**Day close**
- `closeDay` (`server/services/days.ts:379`) runs as a kasiyer action or as the automatic day end (`server/jobs.ts:192` `autoDayEndTick`). The automatic path has no person to confirm anything.
- Payload: `buildDayPayload` (`server/sync/lafmaliyet.ts:240`, `sube` :291) → `enqueueDay` (:358, outbox) → `sendDue` re-stamps `sube` from current settings at send time (:521).
- Costs pull pattern: `pullCosts` (:712), `signedFetch(env.lafmaliyetToken,'GET',…)` (:716), zod `costsBody` (:683).
- Signature: `server/lib/signature.ts` (same vectors, `tests/signature.test.ts`).
- Branch: `settings.branchId` (`server/lib/settings.ts:137`, default `'marina'` at :173).

**Existing KVKK note**: staff meals are "ödenmez" (unpaid) items with `compPersonKind='user'` (`schema.ts:492-494`). Only `compReasonText` reaches ladmin (`shared/comp.ts:48`, e.g. "Ödenmez: Personel yemeği"), with no person ID. The free-text reason could still contain a name.

**Tests**: `npm test` (vitest; server tests also run on sql.js, harness `tests/harness`).
- `tests/lafmaliyet-gun.test.ts:84` (golden), `tests/ladmin-baglanti.test.ts` (fake ladmin HTTP server), `tests/review-fixes.test.ts` (`patchOf`), `tests/ui-rules.test.ts` (ROUTES).
- Then `npm run build && npm run e2e`.

## 3. Design proposal (minimal, safe)

**Decision for the owner first: what does `staffRef` point at?**
- **Recommended: the payroll row**, `staffRef = "s:<staff.id>"`. The meal card, pay and the NOT NULL branch all live on `staff`.
- `users.id` would fit Vardiya, but it has a nullable branch and is not where pay lives.
- The `s:` prefix leaves room for `u:`/`n:` later.

**ladmin: list endpoint**
- **`GET /api/panel/pos/personel?sube=marina`**, built like `servePosProducts`. The query is signed, and a `sube` ≠ `LAFPOS_BRANCH_ID` gets 409 `wrong_branch`.
- Response: `{version:1, now, sube, items:[{ref:"s:12", name, active}]}`.
- Contents: only staff rows with `branchId = LAFPOS_BRANCH_ID` that are in range for this month or the previous one. No salary, email or months. `Cache-Control: no-store`.

**LafPOS: linking**
1. Schema: `users.staff_ref text` nullable plus a unique partial index (`WHERE staff_ref IS NOT NULL`), generated with `npm run db:generate`.
2. New `GET /api/admin/ladmin-personel` (`personel.yonet`):
   - Fetches the ladmin list on demand, cached ≤5 min in memory only and never persisted.
   - Returns the items plus `linkedUserId`.
   - Returns 503 when ladmin is not configured or unreachable.
3. `PATCH /users/:id` accepts `staffRef: z.string().regex(/^s:[1-9]\d{0,8}$/).nullable()` inside `patchOf`.
   - Server checks: the ref must be in a fresh list (refetch if the cache is older than 5 min), the item must be active, and the ref must not be linked to another user (409 `staff_ref_taken`).
   - Linking is refused while ladmin is unreachable; unlinking is allowed offline.
   - Audit `user.staff_link` (severity `uyari` when replacing a link). The message carries the LafPOS name and `s:12` but not the ladmin name.
4. UI in `UserDrawer`: a "ladmin personeli" picker.
   - Candidates are sorted by a name-similarity hint: tr-TR fold (ı/i ş/s ç/c ğ/g ö/o ü/u), first-token match, token overlap.
   - **Never auto-link.** Nothing is preselected when two candidates are equally close.
   - The confirmation shows both sides ("LafPOS: Ayşe · Kasiyer ↔ ladmin: Ayşe Yılmaz · Marina"). A low score requires an extra "Eminim" checkbox.
   - Linked rows show a "ladmin'de bulunamadı" badge when the ref is missing from the list.

**LafPOS: day body**
- `buildDayPayload` adds `workedStaffRefs: string[]`: the sorted, de-duplicated `staffRef`s of active-or-not users with any activity in the day (the union of the signals above, null/system excluded).
- **The field is sent only if at least one user has a `staffRef`.** Absent means unknown and keeps the current golden byte-identical; `[]` means linked staff exist but none worked.
- Optional v1.1: a "Bugün çalışanlar" correction in Kasa › Geçmiş günler. It would be stored as `business_days.worked_user_ids` json, overrides the derived list, and is sent with Gönder. This covers shared-login and bar staff.

**ladmin: ingest**
- `posDaySchema` gets `workedStaffRefs: z.array(z.string().regex(/^s:[1-9]\d{0,8}$/)).max(100).nullable().optional().catch(undefined)`. **It never rejects a day**, so the Z always lands.
- `pos_day_reports.worked_staff jsonb` nullable, written only when the field is present (same as `bankPos`).
- `storePosDay` classifies each ref:
  - `ok`: exists, branch = marina, `startMonth`/`endMonth` cover the date
  - `unknown`
  - `otherBranch`
  - `outOfRange`
- The raw refs are stored. Only `ok` refs count.
- Issues go to `integration_state.lafpos.staffIssues[date]` and show on the Ayarlar › LafPOS card and Maaşlar.
- The 200 reply adds optional `staff:{counted, unknown[], otherBranch[]}`, which LafPOS's `readDayAnswer` can show in Entegrasyon.
- Extend `staffDeleteBlockers` so a staff row referenced in `worked_staff` cannot be deleted.

**ladmin: meal card (phase 2 calculation)**
- Settings `mealCardDaily` (330) and `mealCardDays` (26), plus a per-staff flag.
- If every counted LafPOS day of the month carries the field: worked days = number of days containing the ref. Otherwise use the default of 26, giving 330 × 26 = 8,580 with a "varsayılan" note.
- Tuzla (ModPOS) always uses the default.
- **Owner decision needed:** whether the meal card replaces or sits beside `extras`, which today already includes "yemek". Otherwise it is counted twice.
- Part-time pay from Vardiya needs a further link: either `staff.user_id` or Vardiya picking staff rows (`s:` personRef). Today `n:` refs are free names, so don't build it on them.

## 4. KVKK
- **Names flow only ladmin → LafPOS**, to the café machine, which already stores staff first names in `users.name`. Show them only in the picker; don't persist the list; keep them out of audit `data`.
- **The day body carries IDs only.** These are still pseudonymous personal data, because ladmin can re-identify them.
  - Purpose: payroll and meal card (lawful basis: contract performance or legal obligation).
  - Requirements: an employee information notice (aydınlatma) and admin-only visibility in ladmin (`requireAdmin`; staff must not see others' days).
  - Note that backups include them (`docs/YEDEK.md`).
- **Two doc sentences must change** to "no names; only ladmin staff IDs": `docs/LAFPOS.md:620` and LafPOS `docs/03-ENTEGRASYON.md:698` ("Kişisel veri yok").
- Send no timestamps or hours, only presence per day.

## 5. Files to touch
- **ladmin**
  - `src/server/db/schema.ts` (posDayReports `worked_staff`) plus a generated migration `0069_*`
  - `src/lib/lafpos/day.ts`
  - `src/server/lafpos/ingest.ts`
  - new `src/server/lafpos/staff.ts` and `src/app/api/panel/pos/personel/route.ts`
  - `src/server/lafpos/status.ts` and `src/lib/lafpos/status.ts` (staffIssues)
  - `src/app/panel/ayarlar/lafpos-card.tsx`
  - `src/server/actions/costs.ts` (delete blocker)
  - `docs/LAFPOS.md`
  - tests: `tests/lafpos.test.ts`, `tests/lafpos-db.test.ts`, `tests/lafpos-durum-db.test.ts`, golden fixture
- **LafPOS**
  - `server/db/schema.ts` plus a generated `drizzle/0022_*`
  - `server/routes/admin.ts`
  - `server/sync/lafmaliyet.ts` (list fetch, `buildDayPayload`, `readDayAnswer`)
  - `shared/types.ts` (UserDTO)
  - `src/pages/admin/UsersAdmin.tsx`
  - `docs/03-ENTEGRASYON.md` §4
  - `demo/runtime.ts` (no ladmin in the demo)
  - new `tests/personel-baglanti.test.ts`, `tests/ladmin-baglanti.test.ts` (fake `/api/panel/pos/personel`), `tests/lafmaliyet-gun.test.ts` (second golden case with links)
  - e2e `/yonetim/personel` state for the picker
- **laffogato**: nothing.

## 6. Risks
- Marina staff rows may currently sit on `tuzla` (the default and the "Tümü" fallback). They would not appear in the list. Fix branches in Maaşlar before linking.
- Activity-derived days under-count people on shared logins and over-count a manager who only closed the day. This argues for the v1.1 correction and the owner's decision on the meal-card source.
- Someone who works in both branches has a single `staff.branchId` and will be flagged `otherBranch`. That needs a rule.
- Re-creating a staff row gives a new `id`, so the old link shows as `unknown`. It is visible but needs a manual re-link.
- Outbox payloads are built at close. A link made later only takes effect after Gönder (re-enqueue). Alternatively, resolve refs at send time like `sube` (`lafmaliyet.ts:521`).
- The signature has no nonce, so the GET can be replayed within 5 minutes. Acceptable over HTTPS; the list carries no salaries.

## 7. How to test
- **ladmin**
  - Pure tests: the schema accepts, ignores or catches the field; ref classification; the signed GET returns 401/409/503.
  - Postgres tests: `worked_staff` stored only when present; issues recorded; delete blocked.
- **LafPOS (vitest + sql.js)**
  - PATCH: unique link, list validation, link refused offline, unlink allowed offline, audit written.
  - Payload: field absent without links, sorted and de-duplicated refs from the activity signals, unlinked users excluded.
  - Fake-server reply parsing.
  - The golden stays byte-identical for unlinked seed data.
- **Before commit**: `npm run typecheck && npm test`, then `npm run build && npm run e2e` (the UI changes).
