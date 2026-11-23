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
    id: 'LP-A', repo: '/home/user/lafpos', branch: 'claude/sleepy-knuth-144kr7', base: '633165e',
    maps: ['lafpos-body.md', 'lafpos-cash-chain.md'],
    scope: `CONTINUATION: a previous LP-A agent was interrupted (orchestrator had to stop its workflow for an unrelated reason). Its UNCOMMITTED in-progress work is in the working tree of /home/user/lafpos (git status): drizzle/0022_gun_duzeltme.sql + meta snapshot/journal (reopenReason migration), server/db/schema.ts, server/okc/service.ts (cardBasis fix, reported done with a failing-before test), server/routes/admin.ts (sube lock started), server/services/days.ts, server/sync/lafmaliyet.ts (new body fields, in progress), tests/ladmin-baglanti.test.ts, tests/lafmaliyet-faz2.test.ts. Do NOT discard it: read the diff (git diff; git status), verify it critically against the contract, keep what is right, fix what is wrong, and finish the remaining scope (body fields, sube lock + UI, docs, golden, acceptance day). If you change server/db/schema.ts further, regenerate the 0022 migration (delete drizzle/0022_* and its snapshot, restore the journal entry, rerun npm run db:generate) so there is a single clean migration.
LafPOS Faz 2 sender (CONTRACT §2 fields not marked LP-B/LP-C/LP-E, §4 LP-A bullet, §6 acceptance day, rule 10 shared doc + guard test, rule 11 golden).
Key work items:
1. buildDayPayload (server/sync/lafmaliyet.ts): revision, correction (+ business_days.reopenReason via npm run db:generate; reopen route stores reason; recount marks correction kind recount), offDevice, refunds[], iptal[] (prepared = startedAt||readyAt; addon parts via itemParts; refund flag), z.listValue/ikramTotal/odenmezTotal/zayiTotal/vat[]/openedAt/closedAt/okcZNo, lines[].gross/isAddon, ikram[].kind/personKind (patron via users.role), bankPos.errorCode.
2. cardBasis fix in server/okc/service.ts: subtract off-device card and card of receipts voided on the ÖKC after close (fis_iptal) — with a failing-before test reproducing the 22.11 case (870 TL off-device card must not be expected in Pavo's batch).
3. sube lock (PUT /admin/settings branchId → 409 branch_locked after any lafmaliyet push got 200, unless confirmBranchChange:true from patron; audit severity uyari; SettingsAdmin UI: lock note + confirm step, Turkish, 44px).
4. docs/hesap-sozlesmesi.md (byte copy) + tests/hesap-sozlesmesi.test.ts (sha256 constant), docs/03-ENTEGRASYON.md §4 (every new field, KVKK sentence: ödenmez only personKind, link to hesap-sozlesmesi.md, "Deneme" ödenmez = ürün denemesi note).
5. Golden: extend scenario in tests/lafmaliyet-gun.test.ts so new fields are non-trivial; regenerate with LAFPOS_GOLDEN=1; invariants asserted (Σrevenue=zTotal, Σ(gross−revenue)=discounts, ikram+odenmez+zayi=offRevenue, zTotal=listValue−discounts−ikramTotal−odenmezTotal, Σvat base+vat=zTotal).
6. Acceptance day: new test tests/kabul-gunu.test.ts seeds orders on 2026-11-22 (leave setup mode so the day is real: updateSettings({demoMode:false}); updateSettings({okcProvider:'kapali'}) or what the harness needs; Pavo simulator may be needed for offDevice — design it) that produce EXACTLY CONTRACT §6 numbers, writes/compares tests/fixtures/kabul-gunu-2026-11-22.json byte-for-byte (regenerate flag like golden, e.g. LAFPOS_KABUL=1), and asserts every §6 figure explicitly. The 23.11 expected opening is LP-B, skip it here.
Everything optional/additive; old stored Zs (no odenmez/zayi/offDevice) must still build a valid body.`,
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
