---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.
license: Complete terms in LICENSE.txt
---

> **Kaynak:** [anthropics/skills](https://github.com/anthropics/skills) `skills/webapp-testing` @ `b9e19e6` (Apache-2.0, `LICENSE.txt`). Değişiklik (Apache-2.0 §4b): yalnız bu "Bu projede" bölümü eklendi; Python yardımcıları (`scripts/with_server.py`, `examples/`) alınmadı, karşılıkları aşağıda.

## Bu projede (LafPOS): bu bölüm aşağıdakilerin hepsinden önce gelir

Yöntem aynı (sunucunun yaşam döngüsünü betik yönetir; önce gözle, sonra eylem yap), araç Node:

| Skill'de | LafPOS'ta |
|---|---|
| `scripts/with_server.py --server ... -- python test.py` | `npm run e2e`: `e2e/lib.mjs` `startServer()` boş bir veri klasörüyle üretim sunucusunu açar, bitince siler |
| Python `sync_playwright`, `chromium.launch()` | `playwright-core` ve sistemdeki Google Chrome (`channel: 'chrome'`); başka tarayıcı için `LAFPOS_E2E_CHROME=/yol` |
| `wait_for_load_state('networkidle')` | **Kullanma:** canlı ekranlar SSE bağlantısını açık tutar, ağ hiç susmaz. `settle()` yükleme göstergelerinin kaybolmasını bekler |
| Keşif: ekran görüntüsü, DOM | `e2e/out/<boyut>-<rol>-<ekran>.png`, `overflowReport()`, `smallTargets()` |

- Tarama listesi `e2e/run.mjs` içindeki `ROUTES`; yeni bir ekran eklersen oraya da ekle.
- Akışlar `e2e/flows.mjs`: telefonda garson siparişi, tablette ödeme, yönetimde düzenleme. Seçicide önce rol ve görünen metin (`getByRole`, `getByText`).
- Sunucu `dist/web`'i sunduğu için önce `npm run build`. Tek ekran: `node e2e/run.mjs --only=tarama --roles=patron --routes=/yonetim/menu --viewports=telefon`.

# Web Application Testing

To test local web applications, write native Python Playwright scripts.

**Helper Scripts Available**:
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

**Always run scripts with `--help` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is abslutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: python scripts/with_server.py --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.py

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Always launch chromium in headless mode
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.wait_for_load_state('networkidle') # CRITICAL: Wait for JS to execute
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.wait_for_load_state('networkidle')` before inspection

## Best Practices

- **Use bundled scripts as black boxes** - To accomplish a task, consider whether one of the scripts available in `scripts/` can help. These scripts handle common, complex workflows reliably without cluttering the context window. Use `--help` to see usage, then invoke directly. 
- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.py` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.py` - Using file:// URLs for local HTML
  - `console_logging.py` - Capturing console logs during automation