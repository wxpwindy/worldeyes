import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import robotsParser from 'robots-parser'
import { extractItemMetrics, extractResults, isChallenge, stores, searchEbayApi } from './search.js'

const agent = 'Worldeyes/1.0'
const browserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function isAllowedStoreAsset(url, store, storeId) {
    const root = store.host.replace(/^www\./, '')
    const allowedHost = url.hostname === root
        || url.hostname.endsWith(`.${root}`)
        || (storeId.startsWith('amazon') && (
            url.hostname.endsWith('.media-amazon.com')
            || url.hostname.endsWith('.ssl-images-amazon.com')
            || url.hostname.endsWith('.token.awswaf.com')
        ))
    return url.protocol === 'https:' && (!url.port || url.port === '443') && allowedHost
}

function directItemUrl(rawUrl, storeId) {
    if (!storeId.startsWith('amazon')) return rawUrl
    try {
        const parsed = new URL(rawUrl)
        const embedded = parsed.pathname.includes('/sspa/click') ? parsed.searchParams.get('url') : null
        if (embedded) return new URL(embedded, `https://${stores[storeId].host}`).href
    } catch {
        // Fall back to original URL
    }
    return rawUrl
}

async function enrichFromItemPages(results, storeId, context, policy, signal) {
    const missing = results.filter(item => !item.feedbackCount || !item.boughtPastMonth).slice(0, 3)
    if (!missing.length) return
    const queue = [...missing]
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
        const itemPage = await context.newPage()
        try {
            while (queue.length && !signal.aborted) {
                const item = queue.shift()
                if (!item) break
                const targetUrl = directItemUrl(item.url, storeId)
                if (policy && policy.isAllowed(targetUrl, agent) === false) continue
                try {
                    const nav = await itemPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 })
                    if (!nav?.ok()) continue
                    const itemHtml = await itemPage.content()
                    if (isChallenge(itemHtml)) continue
                    const metrics = extractItemMetrics(itemHtml, storeId)
                    if (!item.feedbackCount && metrics.feedbackCount) item.feedbackCount = metrics.feedbackCount
                    if (!item.boughtPastMonth && metrics.boughtPastMonth) item.boughtPastMonth = metrics.boughtPastMonth
                } catch {
                    // Keep search card result if individual item page times out or blocks
                }
            }
        } finally {
            await itemPage.close().catch(() => { })
        }
    })
    await Promise.all(workers)
}

async function crawl(storeId, keywords, browser, signal) {
    const store = stores[storeId]
    const searchUrl = store.url(keywords)
    const base = { store: storeId, name: store.name, searchUrl, results: [] }
    let context
    try {
        if (storeId === 'ebay' && process.env.EBAY_ACCESS_TOKEN?.trim()) {
            return await searchEbayApi(keywords, signal, process.env.EBAY_ACCESS_TOKEN.trim())
        }
        const robotsUrl = `https://${store.host}/robots.txt`
        const response = await fetch(robotsUrl, {
            headers: { 'User-Agent': agent },
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        })
        let policy = null
        if (response.status !== 404) {
            if (!response.ok) return { ...base, status: 'blocked', message: 'Could not verify this store\'s crawl policy. Open the store directly.' }
            policy = robotsParser(robotsUrl, await response.text())
            if (policy.isAllowed(searchUrl, agent) === false) {
                return {
                    ...base, status: 'blocked', message: storeId === 'ebay'
                        ? 'eBay disallows automated search crawling. Connect an eBay Browse API token on the server, or open the store directly.'
                        : 'This store\'s robots.txt does not allow automated search. Open the store directly.'
                }
            }
        }
        signal.throwIfAborted()
        context = await browser.newContext({ userAgent: browserAgent, locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
        const abort = () => { void context.close().catch(() => { }) }
        signal.addEventListener('abort', abort, { once: true })
        context.on('close', () => signal.removeEventListener('abort', abort))
        await context.route('**/*', route => {
            const url = new URL(route.request().url())
            if (!isAllowedStoreAsset(url, store, storeId) || ['image', 'media', 'font'].includes(route.request().resourceType())) return route.abort()
            return route.continue()
        })
        const page = await context.newPage()
        let navigation = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
        if (navigation?.status() === 503 && storeId.startsWith('amazon')) {
            await page.goto(`https://${store.host}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
            await page.locator('#twotabsearchtextbox, #nav-bb-search').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => { })
            navigation = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
        }
        if ([401, 403, 429, 503].includes(navigation?.status())) {
            return { ...base, status: 'blocked', message: 'The store refused automated access or is rate-limiting requests. Try the store directly.' }
        }
        if (!navigation?.ok()) throw new Error('navigation failed')
        const selector = storeId.startsWith('amazon')
            ? '[data-component-type="s-search-result"], [data-cast="search-result"]'
            : '.srp-results .s-item, .srp-results .s-card'
        if (!isChallenge(await page.content())) {
            await page.locator(selector).first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => { })
        }
        const html = await page.content()
        if (isChallenge(html)) return { ...base, status: 'blocked', message: 'The store requires a human verification check. No challenge bypass was attempted.' }
        const results = extractResults(html, storeId)
        if (results.length) {
            await enrichFromItemPages(results, storeId, context, policy, signal)
            return { ...base, status: 'success', results, checkedAt: new Date().toISOString() }
        }
        const text = await page.locator('body').innerText()
        if (/no results for|no exact matches found|0 results for/i.test(text)) return { ...base, status: 'empty', message: 'No matching products found.' }
        return { ...base, status: 'error', message: 'No product cards could be read. The store layout may have changed or access may be restricted.' }
    } catch (error) {
        return {
            ...base, status: 'error', message: signal.aborted || error.name === 'TimeoutError'
                ? 'This store exceeded the search time limit or the search was cancelled.'
                : 'Could not reach or read this store. Try again later or open it directly.'
        }
    } finally {
        await context?.close().catch(() => { })
    }
}

export async function searchStores(keywords, storeIds, clientSignal) {
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(55000)])
    let browser
    try {
        const channel = process.env.BROWSER_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome')
        browser = await chromium.launch({ headless: true, timeout: 15000, channel })
        return await Promise.all(storeIds.map(storeId => crawl(storeId, keywords, browser, signal)))
    } catch {
        throw new Error('Browser could not start. Run npm run browser:install, then retry.')
    } finally {
        await browser?.close().catch(() => { })
    }
}