---
name: fix-no-search-results
description: 'Diagnoses and fixes empty or broken search results in Worldeyes across keyword search, picture search, and regional Amazon/eBay storefronts. Use when: search shows no results, Search stores button does not work, Search Picture returns no results, Amazon UK or Amazon DE returns empty/error, or new stores fail to extract products.'
---

# Fix No Search Results Issue

## When to Use

- Searching a store (`amazon`, `amazon_uk`, `amazon_de`, `ebay`) returns `empty` or `error` even though opening the store URL in a browser shows products.
- Clicking **Search stores** or **Search picture** does not trigger `/api/search` or fails client-side validation.
- Adding or updating a regional storefront causes selector or product-link extraction failures.

## Architecture Overview

Worldeyes search flows through four files:

1. `public/app.js` — validates form input, runs optional `/api/image-keywords` recognition, and posts `{ keywords, websites }` to `/api/search`.
2. `app.js` — validates request origin/headers (`X-Worldeyes-Request: 1`), keywords, and store IDs against `stores` in `search.js`.
3. `crawler.js` — checks `robots.txt`, opens the store search URL in headless Playwright Chromium/Chrome, waits for product card selectors, checks `isChallenge(html)`, and passes page HTML to `extractResults(html, storeId)`.
4. `search.js` — defines `stores` and parses product cards (`title`, `url`, `itemId`, `image`, `price`, `shipping`, `sponsored`) with Cheerio.

## Step-by-Step Diagnosis & Fix Procedure

### 1. Check Frontend Form Submission (`public/app.js`)

If clicking **Search stores** or **Search picture** does nothing or never calls `/api/search`:

1. Verify every variable used in the `form` `submit` listener is defined in browser scope.
   - `public/app.js` does not import `stores` from `search.js`; validate store IDs against the client `names` map (`Object.hasOwn(names, website)`).
2. Ensure every checkbox `value` in `public/index.html` matches a key in both `names` (`public/app.js`) and `stores` (`search.js`).
3. Verify the store count limit matches between client (`public/app.js`) and server (`app.js`).

### 2. Test the Live API Directly

Run a direct API request against the local server to separate UI issues from crawler/parser issues:

```bash
node --input-type=module -e '
const response = await fetch("http://127.0.0.1:3000/api/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Worldeyes-Request": "1",
    Origin: "http://127.0.0.1:3000"
  },
  body: JSON.stringify({ keywords: "travel portable stand", websites: ["amazon_uk", "amazon_de"] })
});
console.log(response.status, await response.json());
'
```

Interpret the store status:
- `blocked`: `robots.txt` disallowed crawling (common for eBay without `EBAY_ACCESS_TOKEN`), HTTP 401/403/429/503, or CAPTCHA challenge detected by `isChallenge()`.
- `empty` or `error` when products exist on the website: selector wait or Cheerio HTML extraction mismatch in `crawler.js` / `search.js`.

### 3. Inspect Live Store DOM with Playwright + Cheerio

When a store returns 0 extracted items despite HTTP 200 and `challenge: false`, inspect the live card markup:

```bash
node --input-type=module <<'EOF'
import { chromium } from 'playwright'
import { load } from 'cheerio'
import { stores, extractResults, isChallenge } from './search.js'

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
try {
  for (const storeId of ['amazon', 'amazon_uk', 'amazon_de']) {
    const page = await browser.newPage()
    await page.goto(stores[storeId].url('travel portable stand'), { waitUntil: 'domcontentloaded', timeout: 25000 })
    const html = await page.content()
    const $ = load(html)
    const card = $('[data-component-type="s-search-result"][data-asin]').first()
    console.log(storeId, {
      title: $('title').text().trim(),
      challenge: isChallenge(html),
      cardCount: $('[data-component-type="s-search-result"][data-asin]').length,
      extractedCount: extractResults(html, storeId).length,
      asin: card.attr('data-asin'),
      h2Text: card.find('h2').first().text().replace(/\s+/g, ' ').trim(),
      links: card.find('a').map((_, a) => ({
        class: $(a).attr('class'),
        href: $(a).attr('href')?.slice(0, 100),
        hasH2: $(a).find('h2').length > 0,
      })).get().slice(0, 5),
    })
    await page.close()
  }
} finally {
  await browser.close()
}
EOF
```

### 4. Fix Common Extraction Pitfalls in `search.js` and `crawler.js`

Check each of these failure points in `extractResults(html, storeId)`:

1. **Store ID check for Amazon marketplaces**
   - Use `const amazon = storeId.startsWith('amazon')`, not `storeId === 'amazon'`, so `amazon`, `amazon_uk`, and `amazon_de` share Amazon extraction rules.
2. **Product card selector**
   - Match both standard and regional card containers:
     `[data-component-type="s-search-result"], [data-cast="search-result"]`
3. **Title link selector (wrapped `<h2>` vs nested `<a>`)**
   - Amazon US/UK/DE frequently wrap `<h2>` inside `<a class="a-link-normal ... s-link-style">` instead of placing `<a>` inside `<h2>`.
   - Use:
     `card.find('h2 a, a:has(h2), a.a-link-normal.s-no-outline, a.s-link-style').first().attr('href')`
4. **Domain validation (`safeUrl`)**
   - Validate relative links against `https://${store.host}` so `amazon.co.uk` and `amazon.de` URLs resolve to their own marketplace domains.
5. **Product ID (`itemId`) extraction**
   - Prefer `card.attr('data-asin')` first, with a URL fallback that does not require a trailing slash:
     `card.attr('data-asin') || new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([^/?]+)/)?.[1]`
6. **Localized prefixes and sponsored labels**
   - Strip localized prefixes from titles: `.replace(/^(?:Sponsored|New Listing|Neues Angebot)\s*/i, '')`
   - Detect localized sponsored badges: `/sponsored|gesponsert/i.test(card.text())`

### 5. Verify and Restart

1. Run unit and UI tests:
   ```bash
   node --test crawler.test.js search.test.js
   npm run test:ui
   ```
2. Restart the running local server on port 3000 so updated `search.js` / `crawler.js` code takes effect:
   ```bash
   lsof -nP -iTCP:3000 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null
   npm start
   ```
