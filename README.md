# Worldeyes

A local shopping search app for Amazon (US/UK/DE), eBay, and more. Enter keywords, select stores, and receive up to ten unique products per store, in the order returned by the source. Results include titles, available prices, product images, sponsored labels, and links. Export the current results as CSV or cancel an active search.

## Run

Requires Node.js 22.9+ and either installed Google Chrome or Playwright Chromium.

```bash
npm install
npm start
```

Open http://127.0.0.1:3000. If that port is occupied, use `PORT=3002 npm start`.

The crawler uses bundled Chromium when installed, otherwise installed Google Chrome. To install Chromium, run `npm run browser:install`. To explicitly use Chrome, run `BROWSER_CHANNEL=chrome npm start`. Browsing uses an isolated headless session, not your personal Chrome profile or store login.

Optional settings can be placed in a local `.env` file using `.env.example` as a reference. `.env` files are ignored by Git. Never put API tokens in frontend code or commit them.

## Search by Picture

Choose a product picture and click **Search picture**. Worldeyes identifies the main item locally, fills in suggested keywords, and searches the selected stores. You can edit those keywords and search again. This is image-to-keyword search, not an exact-match reverse-image engine; identification can be imperfect, especially with several products or unreadable branding.

Start Ollama locally (its default address is `http://127.0.0.1:11434`) and install the vision model:

```bash
ollama pull gemma3:4b
```

This is a multi-gigabyte download and requires sufficient local memory. You can select another installed image-capable Ollama model using `OLLAMA_VISION_MODEL` in `.env`, then restart Worldeyes. A text-only model cannot recognize pictures. If Ollama or the model is missing, the app displays a setup error; keyword search still works.

Uploads accept still JPEG, PNG and WebP files up to 30 MB and 20 megapixels. The server verifies file signatures, decodes and resizes images to at most 1024 pixels, and strips metadata. Images are processed in memory and sent only to local Ollama; Worldeyes does not persist them or send them to Amazon/eBay. Only suggested keywords go to the selected stores. Recognition has a 60-second timeout and can be cancelled. Ollama's own logging/storage settings are managed separately.

Automated tests cover upload validation and the recognition-to-search flow using a mocked vision response. Real recognition needs the installed vision model; it is not included in the repository. Existing store restrictions, including eBay API credentials, still apply.

## Store Availability

- **Amazon (US/UK/DE):** Playwright opens the keyword search page and extracts the first ten distinct product cards. Availability, prices and ranking vary with region, session and time. CAPTCHA, access-denied and rate-limit pages are reported, not bypassed.

- **eBay:** The website adapter checks robots.txt before browsing. At the live verification on October 28, 2026, eBay disallowed search-page crawling. To retrieve eBay results, configure `EBAY_ACCESS_TOKEN` with a production **Application access token**, obtained through the eBay client-credentials flow with scope `https://api.ebay.com/oauth/api_scope`. Production Browse API access is subject to eBay approval and terms. Tokens expire and must be replaced; automatic token refresh is not implemented.

- With an eBay token set, the app uses the official Browse API with `limit=10`, US marketplace, and default Best Match ordering. This API defaults to fixed-price listings and can differ from the consumer website's ranking. Its keywords are limited to 100 characters. The browser adapters support up to 160 characters.

- Stores may return fewer than ten results. No results are fabricated, and one store's failure does not discard the other store's results.

Live verification returned ten Amazon results; eBay website access was blocked by robots.txt. eBay API behavior is fixture-tested but not live-verified without credentials.

Official eBay reference: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search

## Safety and Limits

The server binds only to `127.0.0.1`. Host, Origin and custom mutation-header checks prevent arbitrary websites from triggering crawls through your local server. Only configured stores are accepted, not arbitrary URLs. The UI renders product text without interpreting HTML; CSV exports neutralize spreadsheet formulas.

One search is active at a time, with a 15-second cooldown between starts. Browser navigation is bounded to 25 seconds, robots.txt checks to 8 seconds, and a search has a 55-second cancellation deadline. Store requests run concurrently. Robots policy failures stop crawling; challenges are not solved automatically. Search results are not persisted. Product thumbnails load directly from their source, without a referrer.

This is a local single-user app, not an authenticated public service. Review store terms and obtain permission for your intended use. Do not expose this server directly to the internet.

## Development

```bash
npm test
npm run test:ui
```

Backend/parser/API tests use fixtures without live network access. The browser check uses a local fixture server and checks desktop/phone layouts, results, errors, CSV downloads and cancellation. Screenshots are written to ignored `test-results/`. Set `BROWSER_CHANNEL=chrome` for the browser checks if desired.

`search.js` contains store URLs, extraction rules and the optional eBay API adapter. `crawler.js` owns browsing and crawl-policy enforcement. `app.js` owns validation and the HTTP API. The browser interface lives in `public/`.

Adding another store requires an explicit adapter, allowed host, parser tests and UI store entry. Arbitrary user-supplied websites are intentionally not fetched.
