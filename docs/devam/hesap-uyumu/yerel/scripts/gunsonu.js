export const meta = {
  name: 'gun-sonu-tam',
  description: 'Day-end fully automatic in ladmin from LafPOS (staff only adds a photo): audit both repos, then implement, review and fix per repo',
  phases: [
    { title: 'Audit', detail: 'read-only audit: what LafPOS records that never reaches ladmin; which ladmin day-end fields are still manual' },
    { title: 'Implement', detail: 'one agent per repo' },
    { title: 'Review', detail: 'fresh reviewer, targeted tests only' },
    { title: 'Fix', detail: 'apply verified findings, full checks once' },
    { title: 'Verify', detail: 'fixtures in sync, field names match, end-to-end rerun with screenshots of the staff page' },
  ],
}

const S = '/Users/okanberkmanavoglu/laf/wt/lafpos-notlar/docs/devam/hesap-uyumu'
const LAF = '/Users/okanberkmanavoglu/laf'
const LOCAL = `LOCAL ENVIRONMENT (overrides any /home/user or cloud-container instruction in the contract, maps or scripts):
- macOS (Apple Silicon), 8 CPU, only 8 GB RAM. Paths: /home/user/X in any document means ${LAF}/X. Repos: ${LAF}/lafpos, ${LAF}/lafmaliyet, ${LAF}/laffogato (main clones; never change their checked-out branch). Worktrees under ${LAF}/wt/.
- Node: ALWAYS prefix shell commands with \`export PATH=$HOME/.local/node/node-v24.22.2-darwin-arm64/bin:$PATH;\` (Node 24, matches CI). sed on macOS: \`sed -i ''\`.
- Postgres 16 runs at localhost:5433 (NOT 5432; port 5432 is the owner's own Postgres 14 — never touch it). Superuser ci/ci, databases test and laffogato_test. Every postgres://ci:ci@localhost:5432/... in the docs means postgres://ci:ci@localhost:5433/... If it is down: \`LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D ${LAF}/pgdata -o "-p 5433 -k /tmp" -l ${LAF}/pgdata.log start\`. psql: /opt/homebrew/opt/postgresql@16/bin/psql.
- RAM is tight: wrap EVERY heavy command (tsc, full or large vitest/node:test runs, next build, npm run build, e2e, test:db, playwright) in \`flock /tmp/laf-heavy.lock <cmd>\` (in addition to the per-repo locks /tmp/lafpos-e2e.lock and /tmp/lafmaliyet-db.lock). Run at most one dev server per repo, and ALWAYS stop every server/browser you started before you finish (kill by PID; check with lsof -i). Use free ports in 4100-4199.
- Known timing-only failures on this slow Mac when the machine is loaded: lafpos tests/audit-raporlar.test.ts (10 s perf budget) and tests/lafmaliyet-gecis.test.ts (10 s hook timeout). Both pass when run alone (verified at baseline). If ONLY these fail in a full run, re-run them alone; green alone counts as green (say so in checks).
- Commit trailer: ONLY the line \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\` (this replaces the two-line trailer in CONTRACT §0 rule 9; no Claude-Session line).
- No live services: never call laffogato.net, ladmin.laffogato.net or any live DB; local .env files get only local test values.
- lafmaliyet test:db in THIS workflow uses its own database: TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test_gunsonu (another lane uses test_faz5; never use another lane's DB). Throwaway e2e databases: create/drop your own (name them gunsonu_e2e_*).
- LafPOS main now also contains LP-C (#170, staff link, workedStaffRefs) at 70562a4.`

const CONTRACT = `${S}/CONTRACT.md`

const OWNER = `Owner request (24.11.2026, Turkish, verbatim): "Ayrıca lafposa girilenler de eksiksiz lafmaliyete girsin; lafpos günü kapatırken POS'tan da gün sonunu oraya giriyor, şuna bak; sadece gün sonu ladmine personel foto atsın." Meaning: (1) everything entered in LafPOS must reach lafmaliyet (ladmin) completely; (2) when LafPOS closes the day, the day-end (kasa raporu) in ladmin must be complete from LafPOS and the POS device (Pavo) data LafPOS already has; (3) the ONLY thing staff do in ladmin at day end is upload a photo. Orchestrator decisions (binding): the ladmin auto report for a LafPOS day fills "Banka POS" from LafPOS's bankPos (Pavo's own end-of-day batch result, i.e. device data, not invented) and the yazarkasa (okc) fields from LafPOS's fiscal-device data (device receipts; Z − offDevice) when LafPOS has them; this replaces the old "Uydurma değer yok: Banka POS ve yazarkasa alanları boş kalır" rule for LafPOS days only (Tuzla/ModPOS unchanged). If LafPOS does not have a device figure (Pavo batch failed/unknown, no device), the field stays empty and the report says exactly what is missing — never invent. Staff upload the photo(s) (Pavo gün sonu fişi; yazarkasa Z if separate) on the LafPOS day's report without editing numbers; photo reading compares the photo with the LafPOS values and a mismatch is a warning for the ADMIN (manager), not a staff task. The report is complete when the photo(s) are attached; staff are not asked to press "Gönder" again for a LafPOS day. A person-edited field still wins over later automatic updates (existing mergeAuto rule). Money: LafPOS integer kuruş, ladmin TL; body v1 additive only; ladmin reads new fields .optional().catch(undefined). KVKK: no person names in the body.`

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    lafposGaps: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, where: { type: 'string' }, today: { type: 'string' }, proposal: { type: 'string' }, priority: { type: 'string', enum: ['must', 'should', 'skip'] } }, required: ['item', 'today', 'proposal', 'priority'] } },
    ladminGaps: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, where: { type: 'string' }, today: { type: 'string' }, proposal: { type: 'string' }, priority: { type: 'string', enum: ['must', 'should', 'skip'] } }, required: ['item', 'today', 'proposal', 'priority'] } },
    notes: { type: 'string' },
    harness: { type: 'string' },
    observed: { type: 'string' },
  },
  required: ['lafposGaps', 'ladminGaps', 'notes', 'harness', 'observed'],
}

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

const implPrompt = (p) => `${LOCAL}

You are the implementation agent for package ${p.id}.
Repo: ${p.repo} — branch ${p.branch} (already checked out; base commit ${p.base}). Work only in this directory.
FIRST read the whole contract: ${CONTRACT}. Then read the background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')} (written against slightly older commits; re-verify line numbers).
Then read the repo's own rules (AGENTS.md / CLAUDE.md) — they are binding.

SCOPE:
${p.scope}

How to work:
- Test-first for every fix/feature: write the test, run it, confirm it fails for the right reason, implement, confirm it passes. Record failing-before evidence.
- Keep diffs focused on the scope; no drive-by refactors. Follow existing patterns and naming.
- Run the FULL check suite for this repo (CONTRACT §0 rule 9) ONCE at the end; everything must be green. Work fast: no redundant re-runs, no browser screenshots beyond the e2e suite, no re-verifying things you already proved. If a pre-existing test must change because the old behaviour was the bug, change it and say so.
- Commit on ${p.branch} (one or a few logical commits, Turkish messages for lafpos/lafmaliyet, English for laffogato) with the exact trailer from CONTRACT §0 rule 9. Do NOT push, do NOT open PRs, do NOT touch other repos (except reading), do NOT touch live services.
- If something in the contract is impossible or wrong against the code, choose the safest reasonable option, implement it, and list it under deviations.
Return: prTitle (Turkish for lafpos/lafmaliyet, English for laffogato; no trailing period), prBody (markdown in the same language: Özet/Summary, what changed per area, tests incl. failing-before evidence, how verified, owner actions/data steps, merge order notes), commits (hashes + subjects), failingBefore, checks (exact commands + pass counts), deviations, ownerActions, openIssues.`

const reviewPrompt = (p, impl) => `${LOCAL}

You are an independent, skeptical code reviewer for package ${p.id}. Do NOT edit any file and do NOT commit.
Repo: ${p.repo}, branch ${p.branch}, base ${p.base}. Review \`git -C ${p.repo} diff ${p.base}..HEAD\` (and the commit list).
Spec: ${CONTRACT} (read §0, §1, §2/§3 as relevant, the ${p.id} entries in §4/§5/§7/§8, and §6). Background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')}.
Package scope given to the implementer:
${p.scope}

Implementer's own summary (do not trust it, verify): ${JSON.stringify({ commits: impl?.commits, deviations: impl?.deviations, openIssues: impl?.openIssues, checks: impl?.checks }).slice(0, 4000)}

Hunt for: correctness bugs with a concrete failing input; contract deviations (field names, shapes, optionality, .catch(undefined) on the reader side, TL vs kuruş, rounding); missing scope items; tests that would pass even without the fix (re-run a sample: stash the fix or check the assertion really exercises it); idempotence/re-send issues; KVKK leaks (names/user ids in the body, audit data); repo rule violations (hand-written SQL, missing db:generate migration/journal/snapshot, patchOf, 44px targets, Turkish copy, e2e ROUTES, demo shims, branch scope); regressions in existing behaviour. Do NOT rerun the full check suite (the implementer already ran it; the fixer runs it again): run only the tests touching the diff (and a scratch revert to prove a suspicious test, if needed). No browser screenshots. Be fast: report only findings you are sure about.
Report only real problems, each with severity (blocker = wrong numbers/data loss/contract break/failing checks; major = real bug or missing scope; minor = small), file, line, summary, and a concrete failure scenario. Empty findings is a valid answer.`

const fixPrompt = (p, impl, review) => `${LOCAL}

You are the fix agent for package ${p.id}. Repo ${p.repo}, branch ${p.branch} (base ${p.base}). Spec: ${CONTRACT}.
An independent reviewer reported these findings:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer's check results: ${(review?.checks ?? '').slice(0, 3000)}

For each finding: verify it against the code first. Fix the real ones (test-first where it is a behaviour bug); skip wrong ones with a one-line reason. Then run the FULL check suite ONCE at the end (CONTRACT §0 rule 9; flock /tmp/lafpos-e2e.lock for lafpos e2e, flock /tmp/lafmaliyet-db.lock for lafmaliyet test:db) until green. No extra browser screenshots beyond the e2e suite; work fast, no redundant re-verification. Commit the fixes as new commit(s) on ${p.branch} with the CONTRACT trailer. Do NOT push or open PRs.
Return the same report shape as the implementer, describing the FINAL state of the branch: prTitle, prBody (complete, updated, includes the reviewer-driven fixes), commits (all commits on the branch since ${p.base}), failingBefore, checks (final), deviations, ownerActions, openIssues — and put "fixed: …" / "skipped: … (reason)" lines at the top of openIssues.
Previous implementer report for reference: ${JSON.stringify(impl ?? {}).slice(0, 8000)}`


phase('Audit')
const audit = await agent(`${LOCAL}

Read-only audit for this owner request (the repos are read-only for you; the harness files you write go under ${LAF}/scripts/e2e-gunsonu/). Do NOT edit or commit anything.
${OWNER}
Repos (read main; fetch first: git -C <repo> fetch -q origin main, then read origin/main via git show / a scratch worktree, never change branches of the checked-out repos): LafPOS /Users/okanberkmanavoglu/laf/lafpos, ladmin /Users/okanberkmanavoglu/laf/lafmaliyet. Contract and history: ${CONTRACT}; ladmin docs/LAFPOS.md ("Gün sonu otomasyonu", "Kasa raporu"), src/lib/lafpos/prefill.ts, src/server/lafpos/gun-sonu.ts, src/lib/photo-read/kasa.ts, src/lib/cash-report.ts; LafPOS docs/03-ENTEGRASYON.md §4, server/sync/lafmaliyet.ts (buildDayPayload), server/okc/*, Pavo integration, server/db/schema.ts.
Produce two gap lists:
(A) lafposGaps: every kind of data a person enters or the devices produce in LafPOS during a business day (orders, payments incl. tips and split/other channels, discounts, ikram/ödenmez/zayi, voids/refunds, cash moves, cari (customer account) sales and collections, cash counts/föy and drawer handovers, Pavo/ÖKC results incl. Z and batch totals, karaoke/service, staff/shift signals, anything else in its schema) and whether it reaches ladmin today (field in the day body → stored → shown/used). For each that does not and that ladmin's books or the day-end need, propose the additive body field (name, shape, unit) — mark must/should/skip with a reason (skip = not ladmin's business or KVKK).
(B) ladminGaps: every field and step of ladmin's day-end for a LafPOS day (kasa raporu form fields incl. bankPos and okc fields, photos, submit/status, late-report requests, notes, e-mail, Onaylar) and whether it is filled automatically from LafPOS today; for each manual one, propose how it becomes automatic under the orchestrator decisions above, and what exactly staff still see/do (photo only). Include what the photo-read check should compare and where the admin sees mismatches.
VERIFY BY RUNNING, not only by reading (owner: "sorularını da sen test edip gör"): build a local end-to-end harness and observe. Local only, never live services. Steps: (1) Postgres 16 is local at localhost:5433 (see LOCAL ENVIRONMENT; user ci/ci superuser); create a throwaway database (e.g. lafmaliyet_gunsonu_e2e), migrate it with lafmaliyet's own migration command, seed the minimum (branches marina/tuzla, LAFPOS_BRANCH_ID marina, switch day before the test day, an admin and a staff user if the pages need them). (2) Start ladmin from a scratch copy of origin/main (git worktree add in your scratchpad, node_modules symlinked to /Users/okanberkmanavoglu/laf/lafmaliyet/node_modules) with that DATABASE_URL, LAFPOS_SYNC_SECRET set to a test secret, on a free port (next dev or build+start). (3) Start LafPOS from a scratch copy of origin/main (node_modules symlinked to /Users/okanberkmanavoglu/laf/lafpos/node_modules) with its own throwaway data dir, LAFMALIYET_URL=http://127.0.0.1:<port> and LAFMALIYET_SYNC_SECRET = the same test secret, Marina branch; use LafPOS's own fake/sim device (Pavo/ÖKC simulator) if it has one. (4) Drive one realistic business day through LafPOS's real HTTP API (or its e2e helpers): open the day, orders with cash/card/meal card/split payment and a tip, a discount, an ikram, an ödenmez, a zayi, a prepared void and a refund, a cari (account) sale and collection if supported, harcama with a category, teslim, giriş, the Pavo/ÖKC end-of-day result, count the drawer, close the day; let the outbox push to ladmin. (5) Inspect ladmin: the stored rows (pos_day_reports, pos_daily_sales, cash_reports incl. which fields are empty, cash_outs, expense entries, revisions) and the staff and admin kasa pages (playwright, headless Chromium is preinstalled) — what is filled, what staff are still asked to do. (6) For every LafPOS entry made in step 4, record whether and where it appears in ladmin. Keep the harness as a re-runnable script under ${LAF}/scripts/e2e-gunsonu/ (one command, e.g. node run.mjs --lafpos <dir> --ladmin <dir> [--shots <dir>]; it should accept repo paths so the implementers can point it at their worktrees) and report its path and how to run it in the harness field; put what you actually observed (with row/field values) in the observed field. Stop all servers and drop the throwaway DB when done. If a step is impossible locally, say exactly why in notes and fall back to the closest real test (e.g. LafPOS buildDayPayload + ladmin handlePosDay/writeAutoReport in-process on the throwaway DB).
BINDING FIELD SPEC: for every must/should lafposGap, the proposal must give the exact additive day-body field path, JSON shape and unit (TL 2 decimals on the wire), and when it is absent vs null; the LafPOS and ladmin implementers run in parallel and both are bound to exactly these names. Prefer existing fields (e.g. bankPos, z.okcZNo, offDevice) over new ones.
Cite files and lines. Be concrete and short. notes: risks and anything that needs the owner.`, { label: 'audit:gun-sonu', phase: 'Audit', schema: AUDIT_SCHEMA, agentType: 'general-purpose' })

const gapsText = (list) => JSON.stringify((list ?? []).filter(g => g.priority !== 'skip'), null, 1).slice(0, 12000)
const PKGS = [
  {
    id: 'LP-F', repo: '/Users/okanberkmanavoglu/laf/wt/lafpos-gunsonu', branch: 'claude/gun-sonu-tam', base: 'origin/main',
    maps: ['lafpos-body.md', 'lafpos-cash-chain.md'],
    scope: `LafPOS side of the owner request. Work ONLY in the git worktree /Users/okanberkmanavoglu/laf/wt/lafpos-gunsonu (branch claude/gun-sonu-tam from origin/main; node_modules symlinked). ${OWNER}
Audit findings for LafPOS (implement the must items, and should items that are small; skip the rest with a reason):
${gapsText(audit?.lafposGaps)}
Audit notes: ${(audit?.notes ?? '').slice(0, 3000)}
Audit observed end to end: ${(audit?.observed ?? '').slice(0, 4000)}
End-to-end harness from the audit: ${(audit?.harness ?? '').slice(0, 1500)} — after implementing, re-run it against YOUR worktree (and the other repo's main or its branch claude/gun-sonu-tam if it exists) and report what changed.
Rules: body v1 additive only; regenerate the golden (LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts) and the acceptance fixture if the body changes; docs/03 §4 field list; budget rules (AGENTS.md rule 6); 44 px; Turkish copy. FULL checks once at the end (each under flock /tmp/laf-heavy.lock): npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e. Body field names are bound to the audit's lafposGaps proposals (the parallel ladmin package reads exactly those).`,
  },
  {
    id: 'LM-6', repo: '/Users/okanberkmanavoglu/laf/wt/lafmaliyet-gunsonu', branch: 'claude/gun-sonu-tam', base: 'origin/main',
    maps: ['ladmin-ingest.md', 'ladmin-faz1-sales.md'],
    scope: `ladmin side of the owner request. Work ONLY in the git worktree /Users/okanberkmanavoglu/laf/wt/lafmaliyet-gunsonu (branch claude/gun-sonu-tam from origin/main; node_modules symlinked). ${OWNER}
Audit findings for ladmin (implement the must items, and should items that are small; skip the rest with a reason):
${gapsText(audit?.ladminGaps)}
LafPOS fields the parallel LafPOS package may add (read them .optional().catch(undefined); if absent, behave as today): ${gapsText(audit?.lafposGaps).slice(0, 4000)}
Audit notes: ${(audit?.notes ?? '').slice(0, 3000)}
Audit observed end to end: ${(audit?.observed ?? '').slice(0, 4000)}
Body field names are bound to the audit's lafposGaps proposals; the golden/kabul fixtures are copied byte-identical from the LafPOS worktree ${LAF}/wt/lafpos-gunsonu at the end (a later verify step re-syncs them if LafPOS changes later). End-to-end harness from the audit: ${(audit?.harness ?? '').slice(0, 1500)} — after implementing, re-run it against YOUR worktree with the LafPOS worktree /Users/okanberkmanavoglu/laf/wt/lafpos-gunsonu (branch claude/gun-sonu-tam, the parallel LafPOS package; if it is not ready, LafPOS main) and show the staff page asks only for the photo; report what you observed.
Rules: migrations via npm run db:generate; staff never see cost/profit; the staff view of a LafPOS day shows the numbers read-only and asks only for the photo(s); admin sees photo-vs-LafPOS mismatches (Onaylar / kasa view / e-mail as fits); Tuzla (ModPOS) flow unchanged; docs/LAFPOS.md "Gün sonu otomasyonu" and docs/KASA-RAPORU.md updated (replace the "Uydurma değer yok … boş kalır" rule for LafPOS days). DB tests for the auto report (22.11 acceptance day: Banka POS and yazarkasa fields filled from the body; staff photo only; a person-edited field still wins). FULL checks once at the end: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test_gunsonu TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
]

const results = await pipeline(
  PKGS,
  (p) => agent(implPrompt(p), { label: `impl:${p.id}`, phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'general-purpose' }),
  (impl, p) => agent(reviewPrompt(p, impl), { label: `review:${p.id}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' }).then(review => ({ impl, review })),
  ({ impl, review }, p) => {
    if (!(review?.findings ?? []).length) return { id: p.id, impl, review, final: impl }
    return agent(fixPrompt(p, impl, review), { label: `fix:${p.id}`, phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
      .then(final => ({ id: p.id, impl, review, final }))
  },
)

phase('Verify')
const finals = Object.fromEntries((results ?? []).filter(Boolean).map(r => [r.id, r.final]))
const verify = await agent(`${LOCAL}

You are the end-to-end verifier for the day-end automation (owner: "sorularını da sen test edip gör"; "Bitince uçtan uca denemeyi yeniden koş ve personelin yalnız foto eklediğini göster").
${OWNER}
Branches: LafPOS ${LAF}/wt/lafpos-gunsonu (claude/gun-sonu-tam), ladmin ${LAF}/wt/lafmaliyet-gunsonu (claude/gun-sonu-tam). Contract: ${CONTRACT}.
Package reports: ${JSON.stringify(finals).slice(0, 12000)}
Audit harness: ${(audit?.harness ?? '').slice(0, 1500)}
Steps:
1. Fixtures: cmp LafPOS tests/fixtures/lafmaliyet-gun.golden.json with ladmin tests/fixtures/lafpos-gun.golden.json, and tests/fixtures/kabul-gunu-2026-11-22.json in both. If they differ, copy LafPOS's bytes into the ladmin worktree, run the ladmin tests that read them (npm test for the golden test file(s), and the acceptance DB test under flock /tmp/lafmaliyet-db.lock with TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test_gunsonu), fix only what the copy breaks, commit on the ladmin branch.
2. Check that every new body field LafPOS sends is read by ladmin under the same name/shape (grep both diffs vs origin/main). If a name mismatch exists, fix the ladmin reader (reader adapts to sender), test-first, commit.
3. Re-run the end-to-end harness against BOTH branches (fresh throwaway DB, fresh LafPOS data dir): a realistic day incl. Pavo end-of-day and count, close the day, let the outbox push. Then in ladmin: (a) DB: the cash report row for that day has Banka POS and yazarkasa fields filled from LafPOS device data; (b) a second run (or a second day) where the Pavo end-of-day failed/unknown → field empty and the report names exactly what is missing; (c) the STAFF kasa page for the LafPOS day shows numbers read-only and asks only for the photo(s) — save full-page PNG screenshots (headless Chromium, 1280 wide and 390 wide) to ${LAF}/scripts/e2e-gunsonu/shots/ (staff-before-photo.png, staff-after-photo.png, admin-mismatch.png when a photo/LafPOS mismatch warning exists — upload a test image as the photo; if the photo reader needs a live AI key, skip the reading and say so); (d) the admin view shows the mismatch warning path (if testable locally).
4. Stop every server and browser you started; drop the throwaway DB.
Return a short report: fixtures (same/synced), field-name check, observed values per check, screenshot paths, anything still missing, and commits you made (hash + subject). Do NOT push.`, { label: 'verify:e2e', phase: 'Verify', agentType: 'general-purpose' })
return { audit, results, verify }

