import { load } from 'cheerio'

export const stores = {
    ebay: { name: 'eBay', host: 'www.ebay.com', url: keywords => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}` },
    amazon: { name: 'Amazon', host: 'www.amazon.com', url: keywords => `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}` },
    amazon_uk: { name: 'Amazon UK', host: 'www.amazon.co.uk', url: keywords => `https://www.amazon.co.uk/s?k=${encodeURIComponent(keywords)}` },
    amazon_de: { name: 'Amazon DE', host: 'www.amazon.de', url: keywords => `https://www.amazon.de/s?k=${encodeURIComponent(keywords)}` },
}

function safeUrl(value, base, product = false) {
    try {
        const url = new URL(value, base)
        const host = new URL(base).hostname.replace(/^www\./, '')
        if (url.protocol !== 'https:' || url.username || url.password) return null
        if (product && url.hostname !== host && !url.hostname.endsWith(`.${host}`)) return null
        return url.href
    } catch {
        return null
    }
}

function cleanCount(value) {
    if (!value) return null
    const match = String(value).replace(/\s+/g, ' ').trim().match(/\b\d[\d,.]*\s*[kKmM]?\+?/)
    return match ? match[0].replace(/\s+/g, '') : null
}

function extractAmazonTitle(card) {
    const brand = card.find('[data-cy="title-recipe"] h2.a-size-mini').first().text().replace(/\s+/g, ' ').trim()
    const headings = card.find('h2')
    let title = ''
    for (let index = 0; index < headings.length; index++) {
        const heading = headings.eq(index)
        if (heading.hasClass('a-size-mini')) continue
        title = heading.attr('aria-label') || heading.text().replace(/\s+/g, ' ').trim()
        if (title) break
    }
    if (!title) title = headings.last().attr('aria-label') || headings.last().text()
    if (brand && !title.toLowerCase().startsWith(brand.toLowerCase())) title = `${brand} ${title}`
    return title.replace(/^(?:Ad\s*[-–—]\s*|Sponsored\s*|Gesponsert\s*|New Listing\s*|Neues Angebot\s*)/i, '').replace(/\s+/g, ' ').trim()
}

function extractFeedbackCount(root, amazon, isItemPage = false) {
    if (amazon) {
        const labels = root.find(
            isItemPage
                ? '#averageCustomerReviews [aria-label], #acrCustomerReviewLink[aria-label]'
                : '[data-cy="reviews-block"] a[aria-label], [data-cy="reviews-block"] span[aria-label], a[href*="#customerReviews"][aria-label]'
        ).map((_, el) => root.find(el).attr('aria-label')).get()
        for (const label of labels) {
            const match = String(label || '').match(/^\s*(\d[\d,.]*\s*[kKmM]?\+?)\s*(?:global\s+|globale\s+)?(?:ratings?|reviews?|bewertungen|sternebewertungen|评级|条评论)\s*$/i)
            if (match) return match[1].replace(/\s+/g, '')
        }
        if (isItemPage) {
            const itemCount = root.find('#averageCustomerReviews #acrCustomerReviewText, #acrCustomerReviewText, [data-hook="total-review-count"]')
                .map((_, el) => root.find(el).text().trim())
                .get()
                .find(Boolean)
            return itemCount ? cleanCount(itemCount) : null
        }
        const linkText = root.find('[data-cy="reviews-block"] a[href*="#customerReviews"] span, a[href*="#customerReviews"] span')
            .first()
            .text()
        if (linkText) return cleanCount(linkText)
        const parenMatch = root.find('[data-cy="reviews-block"]').text().match(/\(([\d,.]+\s*[kKmM]?\+?)\)/)
        return parenMatch ? parenMatch[1].replace(/\s+/g, '') : null
    }
    const text = root.find('.s-item__reviews-count span, .s-card__reviews-count, .x-star-rating .ux-textspans, .fdbk-detail-list__btn-container__btn-text')
        .first()
        .text()
    return cleanCount(text)
}

const boughtBadgePattern = /\b\d[\d,.]*\s*[kKmM]?\+?\s*(?:bought in past month|(?:mal\s+)?im letzten monat gekauft|gekauft\s+mal im letzten monat)\b|过去一个月有\s*\d[\d,.]*\s*[kKmM]?\+?\s*顾客购买/i

function extractBoughtPastMonth(root, amazon, isItemPage = false) {
    if (!amazon) {
        const sold = root.find('.s-item__quantitySold, .s-card__sold, .d-quantity__availability')
            .map((_, el) => root.find(el).text().replace(/\s+/g, ' ').trim())
            .get()
            .find(text => /\b\d[\d,.]*\s*[kKmM]?\+?\s+sold\b/i.test(text))
        return sold || null
    }
    const selector = isItemPage
        ? '#social-proofing-faceout-title-tk_bought, .social-proofing-faceout-title-text, #socialProofingAsinFaceout_feature_div'
        : '[data-cy="reviews-block"] span, .a-row.a-size-base span.a-color-secondary, #social-proofing-faceout-title-tk_bought, .social-proofing-faceout-title-text'
    const candidates = root.find(selector)
        .map((_, el) => root.find(el).text().replace(/\s+/g, ' ').trim())
        .get()
    for (const text of candidates) {
        const match = text.match(boughtBadgePattern)
        if (match) return match[0].trim()
    }
    return null
}

export function extractItemMetrics(html, storeId) {
    const store = stores[storeId]
    if (!store) throw new Error('Unsupported store')
    const document = load(html)
    const root = document.root()
    const amazon = storeId.startsWith('amazon')
    return {
        feedbackCount: extractFeedbackCount(root, amazon, true),
        boughtPastMonth: extractBoughtPastMonth(root, amazon, true),
    }
}

export function extractResults(html, storeId) {
    const store = stores[storeId]
    if (!store) throw new Error('Unsupported store')
    const document = load(html)
    const results = []
    const seen = new Set()
    const amazon = storeId.startsWith('amazon')
    const cards = amazon
        ? document('[data-component-type="s-search-result"], [data-cast="search-result"]')
        : document('.srp-results .s-item, .srp-results .s-card')

    cards.each((_, element) => {
        if (results.length >= 10) return
        const card = document(element)
        const title = amazon
            ? extractAmazonTitle(card)
            : card.find('.s-item__title, .s-card__title').first().text().replace(/^New Listing\s*/i, '').replace(/\s+/g, ' ').trim()
        const link = amazon
            ? card.find('h2 a, a:has(h2), a.a-link-normal.s-no-outline, a.s-link-style').first().attr('href')
            : card.find('a.s-item__link, a.s-card__link').first().attr('href')
        if (!title || /shop on ebay/i.test(title) || !link) return
        const url = safeUrl(link, `https://${store.host}`, true)
        if (!url) return
        const itemId = amazon
            ? card.attr('data-asin') || new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([^/?]+)/)?.[1]
            : new URL(url).pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/)?.[1]
        if (!itemId || seen.has(itemId)) return
        seen.add(itemId)
        const image = card.find(amazon ? 'img.s-image, img[data-cast="search-result-image"], img[data-asin]' : '.s-item__image-wrapper img, .s-card__image img, img').first()
        const imageSource = image.attr('data-src') || image.attr('src')
        results.push({
            rank: results.length + 1,
            title,
            url,
            image: imageSource ? safeUrl(imageSource, `https://${store.host}`) : null,
            price: card.find(amazon ? '.a-price .a-offscreen' : '.s-item__price, .s-card__price').first().text().trim() || null,
            shipping: amazon ? null : card.find('.s-item__shipping, .s-item__logisticsCost').first().text().trim() || null,
            feedbackCount: extractFeedbackCount(card, amazon),
            boughtPastMonth: extractBoughtPastMonth(card, amazon),
            sponsored: /sponsored|gesponsert/i.test(card.text()),
        })
    })
    return results
}

export function extractAmazonResults(html, storeId) {
    if (storeId === 'amazon_us' || storeId === 'amazon') return extractAmazonUs(html)
    if (storeId === 'amazon_uk') return extractAmazonUk(html)
    if (storeId === 'amazon_de') return extractAmazonDe(html)
    throw new Error('Unknown Amazon store')
}

export function extractAmazonUs(html) {
    return extractResults(html, 'amazon')
}

export function extractAmazonUk(html) {
    return extractResults(html, 'amazon_uk')
}

export function extractAmazonDe(html) {
    return extractResults(html, 'amazon_de')
}

export function isChallenge(html) {
    const document = load(html)
    const title = document('title').text()
    return /robot check|captcha|access denied|pardon our interruption/i.test(title)
        || document('form[action*="validateCaptcha"], input#captchacharacters, #captcha_form').length > 0
        || /enter the characters you see below|verify (?:that )?you are (?:a )?human|checking your browser/i.test(document('body').text())
}

export async function searchEbayApi(keywords, signal, token, request = fetch) {
    const base = { store: 'ebay', name: 'eBay', searchUrl: stores.ebay.url(keywords), results: [], source: 'eBay Browse API' }
    if (keywords.length > 100) return { ...base, status: 'error', message: 'eBay API searches support at most 100 characters. Shorten your keywords.' }
    try {
        const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
        url.search = new URLSearchParams({ q: keywords, limit: '10' }).toString()
        const response = await request(url, {
            headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            redirect: 'error',
        })
        if ([401, 403].includes(response.status)) return { ...base, status: 'blocked', message: 'The eBay API token expired or lacks production Browse API access. Update the server credentials.' }
        if (!response.ok) return { ...base, status: 'error', message: 'eBay API is unavailable or rate-limiting requests. Try again later.' }
        const data = await response.json()
        if (!Array.isArray(data.itemSummaries) && data.total !== 0) throw new Error('Invalid API response')
        const results = []
        const seen = new Set()
        for (const item of data.itemSummaries || []) {
            if (results.length >= 10) break
            const url = typeof item.itemWebUrl === 'string' ? safeUrl(item.itemWebUrl, 'https://www.ebay.com', true) : null
            if (!url || !item.itemId || typeof item.title !== 'string' || seen.has(item.itemId)) continue
            seen.add(item.itemId)
            results.push({
                rank: results.length + 1, title: item.title, url,
                image: item.image?.imageUrl ? safeUrl(item.image.imageUrl, 'https://www.ebay.com') : null,
                price: item.price?.value && (!item.priceDisplayCondition || item.priceDisplayCondition === 'ALWAYS_SHOW') ? `${item.price.currency} ${item.price.value}` : null,
                shipping: null,
                feedbackCount: item.seller?.feedbackScore != null ? String(item.seller.feedbackScore) : null,
                boughtPastMonth: null,
                sponsored: item.priorityListing === true,
            })
        }
        return { ...base, results, status: results.length ? 'success' : 'empty', checkedAt: new Date().toISOString(), message: results.length ? undefined : 'No matching products found.' }
    } catch {
        return { ...base, status: 'error', message: 'eBay API request failed, timed out, or was cancelled.' }
    }
}