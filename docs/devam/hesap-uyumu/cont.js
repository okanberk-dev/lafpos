export const meta = {
  name: 'hesap-uyumu-devam',
  description: 'Finish the interrupted hesap-uyumu packages named in args.ids: complete, independently review, fix',
  phases: [
    { title: 'Finish', detail: 'complete the interrupted package from the branch tip' },
    { title: 'Review', detail: 'fresh skeptical reviewer, read-only + full checks' },
    { title: 'Fix', detail: 'apply verified findings, rerun checks, commit' },
  ],
}

const S = '/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad'
const CONTRACT = `${S}/CONTRACT.md`
const COMMON_CONT = `This package was interrupted at a usage limit and handed off. The branch tip may carry a commit titled "WIP (devam): …" with unfinished work. Do NOT rewrite history (no reset/rebase/amend of pushed commits, no force push): add new commits on top. Read the branch diff against the base first (git log/diff), verify the WIP critically against the contract, keep what is right, fix what is wrong, finish what is missing.`

const PKGS_ALL = [
  {
    id: 'LP-A', repo: '/home/user/lafpos', branch: 'claude/sleepy-knuth-144kr7', base: '633165e',
    maps: ['lafpos-body.md', 'lafpos-cash-chain.md'],
    scope: `LafPOS Faz 2 sender: CONTRACT §2 fields not marked LP-B/LP-C/LP-E, §4 LP-A bullet, §6 acceptance day, §0 rules 10–11. State: three commits exist (3269249 cardBasis fix, 7badde9 Faz 2 fields + hesap-sozlesmesi + kabul günü, 13085df sube lock); the implementer was stopped during its final checks/report. Verify every LP-A item is really done (revision/correction + reopenReason migration, offDevice, refunds, iptal with prepared rule, z.listValue/ikramTotal/odenmezTotal/zayiTotal/vat/openedAt/closedAt/okcZNo, lines gross/isAddon, ikram kind/personKind, bankPos.errorCode, cardBasis fix test, sube lock + SettingsAdmin UI, docs/03 §4 + hesap-sozlesmesi.md + guard test, golden regenerated with non-trivial scenario + invariants, tests/kabul-gunu.test.ts producing EXACTLY the §6 22.11 numbers + fixture tests/fixtures/kabul-gunu-2026-11-22.json). Complete anything missing, then run the FULL checks: npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e.`,
  },
  {
    id: 'LP-D', repo: '/home/user/wt/lafpos-modpos', branch: 'claude/modpos-gecmis', base: '633165e',
    maps: ['lafpos-modpos-history.md', 'uzaktan-gecmis.md'],
    scope: `LafPOS Faz 4 + the owner's Uzaktan report, spec = CONTRACT §5 (REVISED — the ONLY valid scope; ignore any older "upload UI" / "live flag" idea) + §9 addendum. Work ONLY in the worktree /home/user/wt/lafpos-modpos. Owner facts: Uzaktan › Raporlar › "Geçen hafta" misses Marina's 16–21.11 entirely; details must come automatically from ladmin; kasa Raporlar show the ModPOS days too; no Merkez upload UI; no change to fillHistory's bigger-wins rule; Marina will never use ModPOS again. State: the implementer finished most items (HistoryDay optional fields, historyReport, Uzaktan ModPOS labels + products block, ReportsPage labels, docs/07 + gecmis header, pullModposDays + Entegrasyon button + signature vector, historyDays merge + kasa Raporlar + patronStats, cloud push of ModPOS days, liveTag) and was stopped while e2e ran; everything is in the WIP commit 58a6a92. The ladmin endpoint exists (lafmaliyet branch claude/modpos-donemi; read /home/user/wt/lafmaliyet-modpos/src/lib/lafpos/modpos-gunler.ts for the exact shape): ikram always 0 (odenmez = ödenmez+ikram), empty days omitted, urunler rarely equals Σ(ciro+indirim) (no exact-sum check on pulled data), adet may be fractional, boy null for single-size, 400 {error:'invalid',field:'sube'}, 409 wrong_branch; §9: days may carry kaynak "kasa_raporu"|"foy" and indirim null on föy days ("indirim bilinmiyor", gross = ciro); signature vector 'e653d2f73b92e4fa1f6acc750f6702872e7e3a68204f9adad8f17e5bf6dd9023' for GET https://ladmin.laffogato.net/api/panel/pos/modpos-gunler?sube=marina at ts 1760000000 with the test secret. Verify all of this is implemented and tested (incl. a failing-before test reproducing "Geçen hafta misses 16–21" that passes after the kasa push; §6 month numbers for Uzaktan 13–22.11; isolation from Z/business_days/outbox; budget), make the read tolerant of indirim:null and kaynak, then run the FULL checks: npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e. The prBody must start with: "Owner revised the scope on 23.11 (CONTRACT §5 REVISED): no Merkez upload UI, no bigger-wins change, no live flag; ModPOS days come from ladmin and the kasa pushes them to Uzaktan; kasa Raporlar show them."`,
  },
  {
    id: 'LM-1', repo: '/home/user/lafmaliyet', branch: 'claude/hesap-uyumu-faz1', base: '7740898',
    maps: ['ladmin-faz1-sales.md', 'ladmin-faz1-misc.md'],
    scope: `lafmaliyet (ladmin) Faz 1, CONTRACT §7 items 1–7 + §0 rule 10 (docs/hesap-sozlesmesi.md byte copy + tests/hesap-sozlesmesi.test.ts with the SAME sha256 constant LafPOS uses — read it from /home/user/lafpos/tests/hesap-sozlesmesi.test.ts on branch claude/sleepy-knuth-144kr7 and make sure both docs are byte-identical) + owner decision 10 (branches.pos_rate NOT NULL DEFAULT 0.02, editable in Ayarlar). State: commits d6b88de (−90, %8, POS commission + branch rate, hesap sözleşmesi) and 7f8f8d9 (commission branch scope + Marka belirsiz) are done; item 6 (fixed-expense endMonth refusal in setPnlCell + read-only UI cell; duplicate-expense warning: pure detector + alerts() + warn on fixed:<id> cell) is half done in the WIP commit 3d2dbc5 (src/lib/fixed-expense-rules.ts, src/lib/calc/duplicate-expense.ts, tests/hesap-uyumu-faz1.test.ts). Finish item 6 test-first, make sure item 4 (cash-form hint) and the docs (KOMISYON.md pile-on sentences, LAFPOS.md link to hesap-sozlesmesi.md) are done, and that every fix has a failing-before test with the §6 Marina numbers. Also apply the owner fact "Marina will never use ModPOS again" where Faz 1 code/texts still assume a Marina ModPOS fallback after the switch day (only texts/notes; no data changes). FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
  {
    id: 'LM-M', repo: '/home/user/wt/lafmaliyet-modpos', branch: 'claude/modpos-donemi', base: '7740898',
    maps: ['ladmin-faz1-sales.md', 'ladmin-ingest.md'],
    scope: `lafmaliyet (ladmin) signed endpoint GET /api/panel/pos/modpos-gunler, CONTRACT §5.1 (REVISED) + §9 addendum. Work ONLY in /home/user/wt/lafmaliyet-modpos. State: implemented in 682fc28 with green checks (its own report: ${S}/LM-M-impl.json). Remaining: the §9 addendum decided after the owner answered — (a) föy-only days (no kasa report, closed ModPOS föy) are ALWAYS returned regardless of "Ay rakamına yedek"; (b) every day gets kaynak: "kasa_raporu" | "foy"; (c) on föy days indirim is null (unknown), not 0; (d) VAT per day: kasa report fiscal breakdown when it equals ciro, else the ModPOS föy/Z VAT breakdown if ladmin stores one, else one 10% row (Marina has 20% only for karaoke; never assume 20%); (e) ladmin's own month rule ("Ay rakamına yedek") stays unchanged — add a doc note in docs/LAFPOS.md; (f) Marina will never use ModPOS again: the endpoint only ever serves days before the switch day. Test-first (failing-before for a, b, c, d), update docs, FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
  {
    id: 'LF-1', repo: '/home/user/laffogato', branch: 'claude/branch-prices', base: '9f7783e',
    maps: ['branch-price.md'],
    scope: `laffogato (site) per-branch selling price, CONTRACT §8 "Site (LF-1)". English code/commits, Turkish UI text. State: implemented (fcf6969, 0338e2c), independently reviewed (3 minor findings below), the fixer was interrupted (WIP commit dabcef8 touches tests/sube/branch-price-routes.test.ts). Fix these: (1) docs/API-MOBILE.md gained a ?branch= section but the lafmobil copy (RiosenBeq/lafmobil, NOT accessible here) cannot be updated from this session — do not revert the doc; instead state it clearly in the PR body as an owner action ("copy docs/API-MOBILE.md to lafmobil and update its RECONCILED SHA-256 in a separate PR") and keep the rest; (2) update CLAUDE.md where it says "fiyatın tek kaynağı menu_items" and the "Şubeler" section (site/app show Tuzla's price, /masa shows the table branch's) so they describe branch prices (menu_items = base price; menu_item_branch_prices = branch overrides with effectiveFrom; every customer pricing path must go through priceAtBranch), and fix the route header comment in src/app/api/panel/menu/route.ts that still says prices stay one for every branch; (3) make a re-sent branchPrice write idempotent: an identical existing row (same item, branch, effectiveFrom, priceMinor, priceMinorL) answers 200 with the same body as a fresh success; a conflicting row at that instant answers 409 stale and the 409 body additively carries the item's branch price rows so the caller can see what exists. Test-first for (3). FULL checks: npm run typecheck && npm run lint && npm run test:sube && TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/laffogato_test npm run test:sube.`,
    fixOnly: true,
  },
]

PKGS_ALL.push({
  id: 'LM-M2', repo: '/home/user/wt/lafmaliyet-modpos', branch: 'claude/modpos-donemi', base: '5f619bf',
  maps: ['ladmin-faz1-sales.md'],
  scope: `lafmaliyet (ladmin), follow-up on the ModPOS-period branch (PR okanberk-dev/lafmaliyet#123, branch claude/modpos-donemi; work ONLY in /home/user/wt/lafmaliyet-modpos; diff base 5f619bf). Pre-existing bug found by the LM-M fixer: the Satışlar coverage record ("Liste hangi güne kadar?", integration_state sales.coverage) is keyed by month only and shared by branches, and lafposSalesCountFrom (src/lib/lafpos/sales.ts) plus the dataset (src/server/data/dataset.ts / lafpos-sales.ts) read that shared record to decide from which day Marina's LafPOS days count in ladmin's monthly model. A Tuzla upload in the same month therefore moves Marina's LafPOS start: probe lafposSalesCountFrom('2026-11-22', marina+tuzla lines, coverage) gives 2026-11-22 for {'2026-11':'2026-11-21'} but 2026-11-28 for Tuzla's {'2026-11':'2026-11-27'} (Marina's LafPOS 22–27 Nov dropped), and a Tuzla December upload of November deletes the key (→ 2026-12-01). This PR already writes a per-branch record (sales.coverage.sube via src/lib/sales-coverage.ts branchCoverage/parseBranchCoverage). Fix: everything that decides Marina's (LAFPOS_BRANCH_ID's) LafPOS count start and ModPOS-list overlap must read THAT branch's own coverage first (fallback to the shared record only for months that have no per-branch entry, i.e. lists uploaded before this change), and any other consumer of sales.coverage that is per-branch in meaning (list period / "Liste hangi güne kadar" notes per branch, sales forecast if branch-scoped) should do the same where it is clearly correct; the shared record keeps working for business-wide uses. Test-first: a failing-before test with Marina's list through 21.11 + Tuzla's upload through 27.11 in the same month (pure + DB where needed) showing countFrom stays 2026-11-22 and Marina's 22–27 LafPOS days stay counted; and the December-deletes-key case. Keep the "Panelin ay kuralı" doc note in docs/LAFPOS.md accurate (update it: the month rule now reads the branch's own record). FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db. Commit messages Turkish.`,
})

PKGS_ALL.push({
  id: 'LP-B', repo: '/home/user/lafpos', branch: 'claude/kasa-zinciri', base: '61aff3b',
  maps: ['lafpos-cash-chain.md', 'cash-moves.md'],
  scope: `LafPOS Faz 3 (kasa zinciri) + cash moves line by line (owner decision 3). Branch claude/kasa-zinciri is stacked on the LP-A tip 61aff3b (PR okanberk-dev/lafpos#167); diff base 61aff3b. Spec: CONTRACT §4 LP-B bullet, §2 (openingDiff/openingReason/expectedOpening, cashMoves), §3 (nextOpening, devir GET, gider-kategorileri GET), §6 (23.11 expected opening 1.279,50 from the acceptance day). State: everything so far is in ONE commit b391c67 titled "WIP (devam): LafPOS Faz 2 gönderen (LP-A)…" (the title is wrong — it is LP-B work). The previous implementer had finished: opening suggestion + reason + business_days columns (drizzle 0024) + audit; nextOpening from the day's own outbox response + lazy devir GET (server/services/devir.ts); expense categories + cash_movements category + cashMoves body. It was IN PROGRESS on: the UI (CashPage "Günü aç" suggestion/source + mandatory reason, blind message "Sayımınız beklenenden farklı; nedenini yazın" with no amounts; harcama modal category chips ≥44 px) and an e2e flow in e2e/flows.mjs (leave setup mode in the flow). NOT yet done: docs/03 §3.2/§4/§4.x/§5 budget rows (check what the WIP already wrote), signature vectors for both new GET paths in tests/signature.test.ts, golden (tests/fixtures/lafmaliyet-gun.golden.json, regen with LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts) + acceptance fixture regenerated (acceptance: one harcama 800 "Diğer fatura dışı" fişsiz; the 23.11 open suggests 1.279,50), failing-before evidence per behaviour (if the WIP added tests together with code, demonstrate failing-before by temporarily reverting the relevant code hunk in a scratch copy or with git stash on the code files only, never committing the revert), then FULL checks: npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e. Commit the remaining work as proper commits on top (Turkish messages; do not rewrite b391c67). In the PR body say that b391c67's title is mislabeled and is LP-B work, and that the PR is stacked on #167 (merge #167 first; base this PR on claude/sleepy-knuth-144kr7).`,
})
PKGS_ALL.push({
  id: 'LM-2', repo: '/home/user/lafmaliyet', branch: 'claude/lafpos-gun-alanlari', base: 'c8559b8',
  maps: ['ladmin-ingest.md', 'ladmin-faz1-sales.md'],
  scope: `lafmaliyet Faz 2 READER for the fields LafPOS LP-A sends. Branch claude/lafpos-gun-alanlari is stacked on the LM-1 tip c8559b8 (PR okanberk-dev/lafmaliyet#124); diff base c8559b8. Sender shapes: \`git -C /home/user/lafpos diff 633165e..61aff3b -- server/sync/lafmaliyet.ts docs/03-ENTEGRASYON.md tests/fixtures\` (61aff3b = LP-A tip, PR okanberk-dev/lafpos#167) and CONTRACT §2. Items (13): (1) posDaySchema/posZSchema/lineSchema/ikramSchema/bankPosSchema read every new field optional + .catch(undefined) (no field may ever 400 a day); (2) storage: pos_daily_sales gross + is_addon, pos_day_reports new jsonb columns (off_device, refunds, iptal, correction) and revision, pos_day_revisions written for EVERY accepted body — migrations via npm run db:generate (R2), document what removeLafposDay does with history; (3) prepared iptal rows count as zayi consumption through the LafPOS ikram/zayi read path (loadLafposIkram → countedWaste source lafpos; reason "İptal (hazırlanmıştı)"), not via waste_entries; unprepared voids info only; (4) ikram kind/personKind preferred over the reason prefix; (5) bankPos.errorCode in pavoView; (6) z.okcZNo into the cash report (okc_z_no separate from z_no); (7) z.listValue/ikramTotal/odenmezTotal/zayiTotal used by lafposIkramCheck; (8) z.vat[] is the day's VAT for LafPOS days wherever ladmin computes sales VAT / KDV hariç ciro (ModPOS days: ciro split at the day's rate, 10%); month = sum of days (30.576,15 not 30.576,14); (9) Satışlar: separate pre-discount (brüt) and after-discount columns (do NOT call it "net": net already means KDV hariç there), consistency check LafPOS day Σrevenue = zTotal, ModPOS day Σbrüt − indirim = Z; (10) kasa raporu/day view: yazarkasadan geçmeyen (offDevice), ödeme iptalleri, Pavo hata kodu, okc_z_no; (11) golden: tests/fixtures/lafpos-gun.golden.json must be BYTE-IDENTICAL to \`git -C /home/user/lafpos show 61aff3b:tests/fixtures/lafmaliyet-gun.golden.json\` (NOT the LP-B WIP version on the lafpos working branch) and tests/fixtures/kabul-gunu-2026-11-22.json byte-identical to \`git -C /home/user/lafpos show 61aff3b:tests/fixtures/kabul-gunu-2026-11-22.json\` — verify with cmp and fix if not; (12) ACCEPTANCE DB test with the §6 Marina November figures and the 22.11 figures; (13) docs/LAFPOS.md field table + 200 body + stale lines fixed; KVKK note. State: items 1–12 are in ONE commit f2b1b02 titled "WIP (devam): ladmin Faz 1 (LM-1)…" (title mislabeled — it is LM-2 work). The previous implementer was on item 13 + final checks. Verify every item critically (especially 3, 8, 9, 11, 12 against §6 numbers), finish item 13, provide failing-before evidence per behaviour (if tests landed together with code, demonstrate by temporarily reverting the code hunk in a scratch way, never committing the revert), then FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db. Commit remaining work as proper commits on top (Turkish). In the PR body say f2b1b02's title is mislabeled (LM-2 work) and the PR is stacked on #124 (merge order: lafpos#167 before this; #124 before this).`,
})

const PKGS = PKGS_ALL.filter(p => (args && args.ids ? args.ids : []).includes(p.id))
if (!PKGS.length) throw new Error('no packages selected')
log(`packages: ${PKGS.map(p => p.id).join(', ')}`)

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    package: { type: 'string' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    prTitle: { type: 'string' },
    prBody: { type: 'string' },
    failingBefore: { type: 'array', items: { type: 'string' } },
    checks: { type: 'string' },
    deviations: { type: 'array', items: { type: 'string' } },
    ownerActions: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['package', 'branch', 'commits', 'prTitle', 'prBody', 'checks'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          scenario: { type: 'string' },
        },
        required: ['severity', 'file', 'summary', 'scenario'],
      },
    },
    checks: { type: 'string' },
  },
  required: ['findings', 'checks'],
}

const finishPrompt = (p) => `You are the finishing agent for package ${p.id}.
Repo: ${p.repo} — branch ${p.branch} (checked out; diff base ${p.base}). Work only in this directory.
FIRST read the whole contract: ${CONTRACT} (owner decisions §1 and §9 are binding; do not ask the owner). Background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')} (older commits; re-verify lines). Then the repo's own rules (AGENTS.md / CLAUDE.md).
${COMMON_CONT}

SCOPE AND STATE:
${p.scope}

How to work: test-first for every fix (see it fail, then pass; record evidence); focused diffs; full check suite green at the end (fix pre-existing tests only when the old behaviour was the bug, and say so). Commit on ${p.branch} with clear messages (Turkish for lafpos/lafmaliyet, English for laffogato) ending with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TUBQ8Lf9KYfVePeoU8oPcc
Do NOT push, do NOT open PRs, do NOT touch live services or other repos (reading is fine).
Return: prTitle (Turkish for lafpos/lafmaliyet, English for laffogato; no trailing period), prBody (markdown, same language: summary, changes per area, tests incl. failing-before evidence, how verified, owner actions/data steps, merge order), commits (ALL commits on the branch since ${p.base}, hash + subject), failingBefore, checks (exact commands + counts), deviations, ownerActions, openIssues.`

const reviewPrompt = (p, fin) => `You are an independent, skeptical code reviewer for package ${p.id}. Do NOT edit files and do NOT commit.
Repo ${p.repo}, branch ${p.branch}, base ${p.base}: review \`git -C ${p.repo} diff ${p.base}..HEAD\` and the commit list.
Spec: ${CONTRACT} (§0, §1, §9, and the ${p.id}-relevant parts of §2–§8, §6). Maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')}.
Scope given to the implementer (authoritative for this review):
${p.scope}
Implementer summary (verify, do not trust): ${JSON.stringify({ commits: fin?.commits, deviations: fin?.deviations, openIssues: fin?.openIssues, checks: fin?.checks }).slice(0, 5000)}
Hunt for: correctness bugs with a concrete failing input; contract deviations (names, shapes, optionality, reader-side .catch(undefined), TL vs kuruş, rounding, idempotence); missing scope items; tests that would pass without the fix (spot-check by reasoning or a scratch revert in a temp copy, never in the repo); KVKK leaks; repo-rule violations (hand-written SQL / missing generated migration, patchOf, 44px, Turkish copy, e2e ROUTES, demo shims, branch scope, Next 16 APIs); regressions. Run the full check suite yourself (lafpos e2e under \`flock /tmp/lafpos-e2e.lock\`, lafmaliyet test:db under \`flock /tmp/lafmaliyet-db.lock\`) and report results in checks. Report only real problems with severity (blocker/major/minor), file, line, summary and a concrete scenario. Empty findings is valid.`

const fixPrompt = (p, fin, review) => `You are the fix agent for package ${p.id}. Repo ${p.repo}, branch ${p.branch} (base ${p.base}). Spec: ${CONTRACT}.
${COMMON_CONT}
Scope (authoritative): ${p.scope}
Reviewer findings:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer checks: ${(review?.checks ?? '').slice(0, 3000)}
Verify each finding against the code; fix the real ones (test-first for behaviour bugs); skip wrong ones with a one-line reason. Run the FULL check suite until green (same flock locks). Commit fixes as new commits with the trailer:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TUBQ8Lf9KYfVePeoU8oPcc
Do NOT push or open PRs. Return the implementer report shape for the FINAL branch state (prTitle, complete prBody, ALL commits since ${p.base}, failingBefore, final checks, deviations, ownerActions, openIssues with "fixed: …" / "skipped: … (reason)" lines first).
Previous report: ${JSON.stringify(fin ?? {}).slice(0, 8000)}`

const results = await pipeline(
  PKGS,
  (p) => p.fixOnly
    ? agent(fixPrompt(p, null, { findings: [], checks: '' }).replace('Reviewer findings:\n[]', 'Reviewer findings: see the numbered items in the scope above.'), { label: `fix:${p.id}`, phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' }).then(final => ({ done: true, final }))
    : agent(finishPrompt(p), { label: `finish:${p.id}`, phase: 'Finish', schema: IMPL_SCHEMA, agentType: 'general-purpose' }).then(fin => ({ done: false, fin })),
  (st, p) => st.done ? st : agent(reviewPrompt(p, st.fin), { label: `review:${p.id}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' }).then(review => ({ ...st, review })),
  (st, p) => {
    if (st.done) return { id: p.id, final: st.final }
    if (!(st.review?.findings ?? []).length) return { id: p.id, final: st.fin, review: st.review }
    return agent(fixPrompt(p, st.fin, st.review), { label: `fix:${p.id}`, phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
      .then(final => ({ id: p.id, final, review: st.review }))
  },
)
return results
