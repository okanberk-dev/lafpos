export const meta = {
  name: 'hesap-uyumu-wave',
  description: 'Implement, independently review and fix the hesap-uyumu packages named in args.ids',
  phases: [
    { title: 'Implement', detail: 'one agent per package, in its own repo/worktree' },
    { title: 'Review', detail: 'fresh skeptical reviewer per package, read-only + full checks' },
    { title: 'Fix', detail: 'apply verified findings, rerun checks, commit' },
  ],
}

const S = '/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad'
const CONTRACT = `${S}/CONTRACT.md`

const PKGS_ALL = [
  {
    id: 'LP-B', repo: '/home/user/lafpos', branch: 'claude/kasa-zinciri', base: 'claude/sleepy-knuth-144kr7',
    maps: ['lafpos-cash-chain.md', 'cash-moves.md'],
    scope: `LafPOS Faz 3 (kasa zinciri) + cash moves line by line (owner decision 3). FIRST: \`git -C /home/user/lafpos checkout claude/sleepy-knuth-144kr7 && git -C /home/user/lafpos checkout -b claude/kasa-zinciri\` (branch from the LP-A tip; the diff base for review is claude/sleepy-knuth-144kr7). Spec: CONTRACT §4 LP-B bullet, §2 (openingDiff/openingReason/expectedOpening, cashMoves), §3 (nextOpening, devir GET, gider-kategorileri GET), §6 (23.11 expected opening 1.279,50 from the acceptance day). Read what LP-A built first (\`git log -p 633165e..claude/sleepy-knuth-144kr7 -- server/sync/lafmaliyet.ts docs/03-ENTEGRASYON.md\`).
Items: suggestion + mandatory reason (blind cashier only sees "Sayımınız beklenenden farklı; nedenini yazın"; consider attempt auditing so a blind cashier cannot probe amounts silently), business_days columns via npm run db:generate, audit, body fields, nextOpening from the day's own sent outbox row, lazy signed GET /api/panel/pos/devir (≥5 min, configured only, no open day), expense categories lazy signed GET /api/panel/pos/gider-kategorileri (≥5 min, cache in sync_state, offline keeps list), cash_movements categoryId + categoryName snapshot, harcama modal category chips ≥44px, cashMoves[] always sent, signature vectors for both new paths in tests/signature.test.ts, docs/03 §3.2/§4/§4.x/§5 budget rows, golden + acceptance fixture regenerated (acceptance: one harcama 800 "Diğer fatura dışı" fişsiz; the 23.11 open suggests 1.279,50). e2e: add a flow for "Günü aç" with suggestion + reason (leave setup mode in the flow), run build + e2e under flock /tmp/lafpos-e2e.lock.`,
  },
  {
    id: 'LM-2', repo: '/home/user/lafmaliyet', branch: 'claude/lafpos-gun-alanlari', base: 'claude/hesap-uyumu-faz1',
    maps: ['ladmin-ingest.md', 'ladmin-faz1-sales.md'],
    scope: `lafmaliyet Faz 2 READER for the fields LafPOS LP-A now sends. FIRST: \`git -C /home/user/lafmaliyet checkout claude/hesap-uyumu-faz1 && git -C /home/user/lafmaliyet checkout -b claude/lafpos-gun-alanlari\` (diff base for review: claude/hesap-uyumu-faz1). Learn the exact sender shapes from LafPOS: \`git -C /home/user/lafpos diff 633165e..claude/sleepy-knuth-144kr7 -- server/sync/lafmaliyet.ts docs/03-ENTEGRASYON.md tests/fixtures\` and CONTRACT §2.
Items: (1) posDaySchema/posZSchema/lineSchema/ikramSchema/bankPosSchema read every new field optional + .catch(undefined) (no field may ever 400 a day); (2) storage: pos_daily_sales gross + is_addon columns, pos_day_reports new jsonb columns (off_device, refunds, iptal, correction) and revision, a pos_day_revisions table written for EVERY accepted body (copy cash_report_revisions pattern) — migrations via npm run db:generate (R2), decide/document what removeLafposDay does with history; (3) prepared iptal rows count as zayi consumption through the existing LafPOS ikram/zayi read path (loadLafposIkram → countedWaste source lafpos; reason "İptal (hazırlanmıştı)"), not via waste_entries; unprepared voids shown as info only; (4) ikram kind/personKind preferred over the reason prefix; (5) bankPos.errorCode in pavoView; (6) z.okcZNo as an auto field into the cash report (okc_z_no separate from z_no); (7) z.listValue/ikramTotal/odenmezTotal/zayiTotal used by lafposIkramCheck; (8) z.vat[] is the day's VAT for LafPOS days wherever ladmin computes sales VAT / KDV hariç ciro (ModPOS days: ciro split at the day's rate, 10%); month = sum of days (30.576,15 not 30.576,14); (9) Satışlar: separate pre-discount (brüt) and after-discount columns (do NOT call it "net": net already means KDV hariç there), consistency check LafPOS day Σrevenue = zTotal, ModPOS day Σbrüt − indirim = Z; (10) kasa raporu/day view: yazarkasadan geçmeyen (offDevice), ödeme iptalleri, Pavo hata kodu, okc_z_no; (11) golden: copy LafPOS tests/fixtures/lafmaliyet-gun.golden.json byte-for-byte to tests/fixtures/lafpos-gun.golden.json, and copy tests/fixtures/kabul-gunu-2026-11-22.json from the LafPOS LP-A branch (git -C /home/user/lafpos show claude/sleepy-knuth-144kr7:tests/fixtures/kabul-gunu-2026-11-22.json); (12) ACCEPTANCE DB test: ingest the kabul günü + the 9 ModPOS days (as Marina kasa reports / ModPOS rows, §6 table) and assert the Marina November figures from §6 on the real loaders/engine (ciro 33.633,75, kart 24.774,25, nakit 8.859,50, yemek 0, indirim 2.156,25, ödenmez+ikram 2.565,00, fiş 161, KDV hariç 30.576,15, commission 495,49 on Satışlar AND Gelir-gider), plus the 22.11 figures (offDevice, refunds, iptal 12 parts 2.395,00, kasa açılış/beklenen/sayılan/fark); (13) docs/LAFPOS.md field table + 200 body + stale lines fixed; KVKK note.`,
  },
]

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

const implPrompt = (p) => `You are the implementation agent for package ${p.id}.
Repo: ${p.repo} — branch ${p.branch} (already checked out; base commit ${p.base}). Work only in this directory.
FIRST read the whole contract: ${CONTRACT}. Then read the background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')} (written against slightly older commits; re-verify line numbers).
Then read the repo's own rules (AGENTS.md / CLAUDE.md) — they are binding.

SCOPE:
${p.scope}

How to work:
- Test-first for every fix/feature: write the test, run it, confirm it fails for the right reason, implement, confirm it passes. Record failing-before evidence.
- Keep diffs focused on the scope; no drive-by refactors. Follow existing patterns and naming.
- Run the FULL check suite for this repo (CONTRACT §0 rule 9) at the end; everything must be green. If a pre-existing test must change because the old behaviour was the bug, change it and say so.
- Commit on ${p.branch} (one or a few logical commits, Turkish messages for lafpos/lafmaliyet, English for laffogato) with the exact trailer from CONTRACT §0 rule 9. Do NOT push, do NOT open PRs, do NOT touch other repos (except reading), do NOT touch live services.
- If something in the contract is impossible or wrong against the code, choose the safest reasonable option, implement it, and list it under deviations.
Return: prTitle (Turkish for lafpos/lafmaliyet, English for laffogato; no trailing period), prBody (markdown in the same language: Özet/Summary, what changed per area, tests incl. failing-before evidence, how verified, owner actions/data steps, merge order notes), commits (hashes + subjects), failingBefore, checks (exact commands + pass counts), deviations, ownerActions, openIssues.`

const reviewPrompt = (p, impl) => `You are an independent, skeptical code reviewer for package ${p.id}. Do NOT edit any file and do NOT commit.
Repo: ${p.repo}, branch ${p.branch}, base ${p.base}. Review \`git -C ${p.repo} diff ${p.base}..HEAD\` (and the commit list).
Spec: ${CONTRACT} (read §0, §1, §2/§3 as relevant, the ${p.id} entries in §4/§5/§7/§8, and §6). Background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')}.
Package scope given to the implementer:
${p.scope}

Implementer's own summary (do not trust it, verify): ${JSON.stringify({ commits: impl?.commits, deviations: impl?.deviations, openIssues: impl?.openIssues, checks: impl?.checks }).slice(0, 4000)}

Hunt for: correctness bugs with a concrete failing input; contract deviations (field names, shapes, optionality, .catch(undefined) on the reader side, TL vs kuruş, rounding); missing scope items; tests that would pass even without the fix (re-run a sample: stash the fix or check the assertion really exercises it); idempotence/re-send issues; KVKK leaks (names/user ids in the body, audit data); repo rule violations (hand-written SQL, missing db:generate migration/journal/snapshot, patchOf, 44px targets, Turkish copy, e2e ROUTES, demo shims, branch scope); regressions in existing behaviour. Run the full check suite yourself (CONTRACT §0 rule 9; use \`flock /tmp/lafpos-e2e.lock\` for lafpos e2e and \`flock /tmp/lafmaliyet-db.lock\` for lafmaliyet test:db) and report the results in checks.
Report only real problems, each with severity (blocker = wrong numbers/data loss/contract break/failing checks; major = real bug or missing scope; minor = small), file, line, summary, and a concrete failure scenario. Empty findings is a valid answer.`

const fixPrompt = (p, impl, review) => `You are the fix agent for package ${p.id}. Repo ${p.repo}, branch ${p.branch} (base ${p.base}). Spec: ${CONTRACT}.
An independent reviewer reported these findings:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer's check results: ${(review?.checks ?? '').slice(0, 3000)}

For each finding: verify it against the code first. Fix the real ones (test-first where it is a behaviour bug); skip wrong ones with a one-line reason. Then run the FULL check suite (CONTRACT §0 rule 9; flock locks as in the review) until green. Commit the fixes as new commit(s) on ${p.branch} with the CONTRACT trailer. Do NOT push or open PRs.
Return the same report shape as the implementer, describing the FINAL state of the branch: prTitle, prBody (complete, updated, includes the reviewer-driven fixes), commits (all commits on the branch since ${p.base}), failingBefore, checks (final), deviations, ownerActions, openIssues — and put "fixed: …" / "skipped: … (reason)" lines at the top of openIssues.
Previous implementer report for reference: ${JSON.stringify(impl ?? {}).slice(0, 8000)}`

const results = await pipeline(
  PKGS,
  (p) => agent(implPrompt(p), { label: `impl:${p.id}`, phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'general-purpose' }),
  (impl, p) => agent(reviewPrompt(p, impl), { label: `review:${p.id}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' }).then(review => ({ impl, review })),
  ({ impl, review }, p) => {
    const real = (review?.findings ?? []).length
    if (!real) return { id: p.id, impl, review, final: impl }
    return agent(fixPrompt(p, impl, review), { label: `fix:${p.id}`, phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
      .then(final => ({ id: p.id, impl, review, final }))
  },
)
return results
