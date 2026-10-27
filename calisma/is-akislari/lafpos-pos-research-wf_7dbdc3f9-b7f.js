export const meta = {
  name: 'lafpos-pos-research',
  description: 'Deep feature research on Turkish and global POS systems vs LafPOS, a cross-repo contract audit with laffogato and lafmaliyet, and a prioritized gap list',
  phases: [
    { title: 'Inventory', detail: 'what LafPOS does today, area by area' },
    { title: 'Research', detail: 'six agents, each a cluster of POS systems, feature by feature with sources' },
    { title: 'Contract', detail: 'LafPOS ↔ laffogato ↔ lafmaliyet contract and Vercel readiness audit (read-only)' },
    { title: 'Synthesis', detail: 'gap analysis, build-now specs, completeness critic' },
  ],
}

const LAFPOS = '/Users/okanberkmanavoglu/Downloads/lafpos-fix'
const AREAS = `1 Sipariş alma ve menü (modifier groups, forced/optional choices, combos, notes, courses, seats, quick keys, search, open-price items, price override, barcode)
2 Masa ve salon (floor plan, table states and timers, merge/split/transfer, reservations, waitlist, QR table ordering)
3 Mutfak ve bar (KDS, printer routing, ticket timers and colors, bump/recall, all-day counts, prep time, expo, hold and fire)
4 Ödeme (split by seat/item/even, partial, tips, service charge, rounding, foreign currency, meal cards, pre-auth tabs, refunds, pay at table, payment devices)
5 Kasa yönetimi (opening float, paid in/out, X and Z, blind close, cash drops, drawer per staff, shift close)
6 Raporlar ve analitik (sales, product mix, menu engineering, labor %, dayparts, comparisons, forecasts, exports, owner app, anomaly alerts, scheduled email reports)
7 Stok ve maliyet (recipes, depletion, purchasing, counts, waste)
8 Personel (roles and permissions, time clock, scheduling, tip pooling, performance, card/fingerprint login)
9 Müşteri ve sadakat (CRM, loyalty, gift cards, open accounts, campaigns, discounts, happy hour)
10 Online ve teslimat (own online ordering, Yemeksepeti/Getir/Trendyol Yemek, courier management, caller ID)
11 Türkiye mali uyumu (ÖKC/GMP-3, e-Arşiv/e-Fatura, bilgi fişi, VUK 507)
12 Donanım ve çalışma (offline mode, multi-device sync, printers, customer display, kiosk/self order, handhelds)
13 Yönetim (menu management, multi-branch, price levels, scheduled menus, audit log, backups, remote access, integrations market)
14 UX ayrıntıları (taps per common flow, shortcuts, search, training mode, error recovery, onboarding, accessibility, speed)`

const FEATURE_SCHEMA = {
  type: 'object',
  properties: {
    systems: { type: 'array', items: { type: 'string' } },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          features: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                system: { type: 'string' },
                name: { type: 'string' },
                detail: { type: 'string', description: 'exactly how it works for the user, the fine details (screens, taps, rules, edge cases)' },
                source: { type: 'string', description: 'URL or "ModPOS panel: <page>"' },
              },
              required: ['system', 'name', 'detail', 'source'],
            },
          },
        },
        required: ['area', 'features'],
      },
    },
    standouts: { type: 'array', items: { type: 'string' }, description: 'the 5-10 details that make these systems feel fast or trustworthy to café staff and owners' },
  },
  required: ['systems', 'areas', 'standouts'],
}

const CLUSTERS = [
  { key: 'simpra-robotpos', systems: 'Simpra (simpra.com.tr: Simpra POS, Simpra Inventory, Simpra Smart Office, Simpra Online) and robotPOS (robotpos.com, RobotPOS Air, Simpra ve robotPOS yardım merkezleri, ürün sayfaları, sürüm notları, YouTube açıklamaları)' },
  { key: 'tr-cafe-pos', systems: 'Turkish café/restaurant POS products used by small cafés: Adisyo (adisyo.com, yardım merkezi), SambaPOS (sambapos.com, forum and docs), NarPOS if it exists, Menulux, and the other two most-used Turkish café POS you can find (state which and why)' },
  { key: 'toast-square', systems: 'Toast (pos.toasttab.com, central.toasttab.com / doc.toasttab.com help articles, release notes) and Square for Restaurants (squareup.com/help, Square KDS, Square Team)' },
  { key: 'lightspeed-touchbistro', systems: 'Lightspeed Restaurant K-Series (k-series-support.lightspeedhq.com / resto-support) and TouchBistro (help.touchbistro.com)' },
  { key: 'loyverse-odoo', systems: 'Loyverse POS (help.loyverse.com, Loyverse KDS, Loyverse Back Office) and Odoo Point of Sale restaurant mode (odoo.com/documentation/*/applications/sales/point_of_sale), plus SumUp POS (ex Tiller/Goodtill) where it adds something' },
]

function researchPrompt(c) {
  return `Research, in the finest detail, what these POS systems do: ${c.systems}.

Goal: LafPOS (a café POS for one café, L'Affogato, Istanbul; local server on the cash PC, tablets and phones over LAN, Innex-style back office, TokenX yazarkasa integration, linked to the café site laffogato.net and the cost system lafmaliyet) wants to match and beat them. The owner asked to look "en ince ayrıntıya kadar" (down to the finest detail). Generic marketing bullets are worthless: find help-center articles, docs, release notes and screenshots descriptions that say exactly how a feature works (taps, screens, rules, edge cases, defaults, permissions).

Cover these areas (skip what the systems do not have, note what they do that fits none):
${AREAS}

Use WebSearch and WebFetch. Prefer official help centers and docs; cite a URL for every feature. Do not log in anywhere, do not submit forms, do not download files. Aim for depth: 60-150 features in total across the systems, each with a concrete detail sentence or two. Write the detail text in English or Turkish, whichever the source used.`
}

const modposPrompt = `Inspect ModPOS Integra (the café's current/previous POS) in the user's own Chrome, read-only, to list in the finest detail what it offers.

The user is logged in at https://panel.gafdigi.com (back office, dealer "Tuzla / L'Affogato") and https://patron.gafdigi.com (owner app). The user allows browsing these at any time, read-only. Load the Claude in Chrome tools with ToolSearch (query "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__find,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp"), open ONE new tab of your own, and close it when done.

Strict rules: never click save, submit, delete, approve, send or any button that changes data; never change settings, filters that persist, or permissions; never type into forms except a search box when needed to reveal a list; do not export or download files; if a page asks to confirm anything, cancel. If you are not logged in, stop and report that.

Walk every menu section of the panel (products, variants, POS parameters, devices, tables and QR, staff positions and permissions, cash, reports, stock, invoices, open accounts, courier, P&L, integrations market) and the patron app. For each feature write exactly what it does and its options (field names, toggles, report columns, permission names). Also list ModPOS's report types and their columns, and the full list of permission names under each permission group.

Cover these areas:
${AREAS}

Return features with source "ModPOS panel: <menu path>" or "ModPOS patron: <screen>".`

const inventoryPrompt = `Inventory what LafPOS does today, in fine detail, read-only. Repo: ${LAFPOS} (branch claude/inceleme-duzeltmeleri; another process is editing other worktrees, do not modify anything here either).

Read README.md, PRODUCT.md, DESIGN.md, docs/*.md, AGENTS.md, and skim src/pages/**, src/components/**, server/routes/**, server/services/**, server/okc/**, server/sync/**, shared/** to confirm what really exists (docs can be ahead of or behind the code). For each feature give the concrete detail (screen, rule, permission) and where it lives (file or route).

Use these areas:
${AREAS}

Return system "LafPOS" for every feature and the file/route as source. Also list in standouts the 5-10 weakest spots you noticed (missing, half-done, or clumsy).`

const contractPrompt = `Audit the live connection between LafPOS and its two sibling systems, read-only, and say exactly what is missing for it to work end to end in production.

Repos (do NOT checkout, edit, commit or push in any of them; other sessions are working in them):
- LafPOS: ${LAFPOS} (branch claude/inceleme-duzeltmeleri). Contract: docs/03-ENTEGRASYON.md. Clients: server/sync/laffogato-orders.ts, laffogato-menu.ts, menu-sync.ts, lafmaliyet.ts, cloud.ts; signature: server/lib/signature.ts; env: .env.example; LafPOS Uzaktan (Vercel): api/uzaktan.ts, vercel.json, docs/07-UZAKTAN-ERISIM.md.
- laffogato (café site, Next.js on Vercel, production https://laffogato.net): /Users/okanberkmanavoglu/Downloads/laffogato. Run \`git -C <repo> fetch -q origin\` then read files with \`git -C <repo> show origin/main:<path>\` and list with \`git -C <repo> ls-tree -r --name-only origin/main | grep -i pos\`. Look at every /api/pos/* route, its signature check, env names (LAFPOS_SYNC_SECRET), menu/orders/sold-out payloads.
- lafmaliyet (cost system, Next.js on Vercel): /Users/okanberkmanavoglu/Downloads/lafmaliyet, same read method. Look at /api/pos/gun, /api/panel/pos/*, migrations about POS (lafpos, cash_in, okc), and anything merged today (PRs #38-#41) that could change the POS contract.

Compare field by field and rule by rule: endpoint paths and methods, HMAC signing input and headers (x-laf-timestamp, x-laf-signature v1=), allowed clock skew, body shapes and types (kuruş vs TL, sizes M/L/TEK, posName, isActive, sold-out), status codes and error codes (409 z_conflict, 503 not_configured), idempotency and retries, date/business-day rules, what LafPOS sends vs what the other side stores. Probe production without credentials (curl status codes only, e.g. GET https://laffogato.net/api/pos/orders/version and GET/OPTIONS https://lafmaliyet.vercel.app/api/pos/gun; never send signed or credentialed requests).

Vercel readiness for the LafPOS Uzaktan project (Vercel project 'lafpos', team okans-projects-fcf7250e, production https://lafpos.vercel.app currently answers 404 at / and /api/health): read vercel.json, package.json, api/uzaktan.ts and explain why production is 404 today and whether merging this branch to main fixes it. You may run read-only Vercel CLI commands such as \`npx vercel@50 ls lafpos --scope okans-projects-fcf7250e\` and \`npx vercel@50 inspect <deployment-url> --scope okans-projects-fcf7250e\` (no env, deploy, promote, link or remove commands; if the CLI wants to link or log in, skip it). List every env var each Vercel project needs for the whole loop (names only, never values) and which side generates each secret.

Return markdown: 1) mismatches (each with both sides' evidence: file:line, and a proposed fix on the right side), 2) env/secrets matrix, 3) Vercel lafpos diagnosis, 4) an ordered go-live checklist.`

const SYN_SCHEMA = {
  type: 'object',
  properties: {
    buildNow: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short kebab-case id' },
          title: { type: 'string', description: 'Turkish title' },
          area: { type: 'string' },
          why: { type: 'string', description: 'value for a single café, which competitors have it' },
          spec: { type: 'string', description: 'precise spec: UX (screens, taps, copy), server rules, data, permissions, audit, reports, tests; what NOT to do' },
          files: { type: 'string', description: 'likely files/areas touched in LafPOS' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
          schemaChange: { type: 'boolean' },
        },
        required: ['key', 'title', 'area', 'why', 'spec', 'files', 'effort', 'schemaChange'],
      },
    },
    later: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, blocker: { type: 'string', description: 'hardware, vendor docs, credentials, legal, or scope' }, why: { type: 'string' } },
        required: ['title', 'blocker', 'why'],
      },
    },
    alreadyBetter: { type: 'array', items: { type: 'string' }, description: 'where LafPOS already beats them' },
    reportMarkdown: { type: 'string', description: 'a Turkish comparison report for the owner: per area what competitors do, what LafPOS does, the gap' },
  },
  required: ['buildNow', 'later', 'alreadyBetter', 'reportMarkdown'],
}

phase('Inventory')
const inventoryP = agent(inventoryPrompt, { label: 'inventory:lafpos', phase: 'Inventory', schema: FEATURE_SCHEMA })
phase('Research')
const researchP = parallel([
  ...CLUSTERS.map((c) => () => agent(researchPrompt(c), { label: `research:${c.key}`, phase: 'Research', schema: FEATURE_SCHEMA })),
  () => agent(modposPrompt, { label: 'research:modpos', phase: 'Research', schema: FEATURE_SCHEMA }),
])
const contractP = agent(contractPrompt, { label: 'contract:laffogato-lafmaliyet-vercel', phase: 'Contract' })

const [inventory, research] = await Promise.all([inventoryP, researchP])
const reports = research.filter(Boolean)
log(`Research: ${reports.length} reports, inventory ${inventory ? 'ok' : 'missing'}`)

phase('Synthesis')
const synPrompt = `You are the product lead for LafPOS. Compare LafPOS with the researched POS systems and decide what to build now.

LafPOS inventory (what exists today, with its weak spots):
${JSON.stringify(inventory)}

Competitor research (feature by feature, with sources):
${JSON.stringify(reports)}

Context: one café (L'Affogato, Istanbul: coffee, desserts, a karaoke room, an online shop and QR table orders through laffogato.net, costs and stock in lafmaliyet). Staff use the cash PC, tablets and phones. The owner wants LafPOS to be among the most compatible and capable POS systems in Turkey, simple to use, with reports that are never wrong and rich revenue statistics.

Decide:
- buildNow: 8 to 14 items that give the café the most value, can be built and tested now by coding agents in this repo (no new hardware, vendor docs or credentials; schema changes allowed via Drizzle migrations), and do not duplicate what LafPOS already has. Prefer the fine details that make daily work faster or safer (e.g. hold and fire, all-day counts, quick re-order, menu engineering, scheduled owner summary, cash drops, time clock) over big new modules. Each spec must be precise enough for an engineer: screens and copy (Turkish), server rules, permissions, audit entries, report effects, tests, and explicit non-goals. Stock/recipes stay in lafmaliyet; payments stay on the yazarkasa/POS device.
- later: what is blocked and by what.
- alreadyBetter: where LafPOS is already ahead.
- reportMarkdown: a Turkish report for the owner, per area: what the others do (with system names), what LafPOS does, and the decision.`
const synthesis = await agent(synPrompt, { label: 'synthesis', phase: 'Synthesis', schema: SYN_SCHEMA })

const critic = await agent(`Critically review this LafPOS build plan for completeness and correctness.

Plan:
${JSON.stringify(synthesis)}

Inventory of what LafPOS already has:
${JSON.stringify(inventory)}

Check: does any buildNow item duplicate something LafPOS already has (cite the inventory)? Is any spec vague, risky for money correctness, or in conflict with the rules (stock in lafmaliyet, payments on the device, one Z per business day, blind cash)? Which high-value competitor details from the research were missed? Return markdown: problems per item (keep/change/drop with reason) and up to 5 missed items with a spec.

Research for reference:
${JSON.stringify(reports).slice(0, 120000)}`, { label: 'critic', phase: 'Synthesis' })

const contract = await contractP
return { synthesis, critic, contract, inventory, reports }