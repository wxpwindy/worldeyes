import test from 'node:test'
import assert from 'node:assert/strict'
import { extractItemMetrics, extractResults, isChallenge, stores, searchEbayApi } from './search.js'

test('eBay preserves rank, deduplicates items, and returns at most ten', () => {
    const card = number => `<li class="s-item"><a class="s-item__link" href="https://www.ebay.com/itm/${number}?x=1"><h3 class="s-item__title">New Listing Camera ${number}</h3></a><span class="s-item__price">$12.00</span><img src="https://i.ebayimg.com/camera.jpg"></li>`
    const html = `<ul class="srp-results">${card(100)}${card(100)}${Array.from({ length: 12 }, (_, index) => card(index + 101)).join('')}</ul>`
    const results = extractResults(html, 'ebay')
    assert.equal(results.length, 10)
    assert.equal(results[0].title, 'Camera 100')
    assert.equal(results[1].title, 'Camera 101')
    assert.equal(results[9].rank, 10)
    assert.equal(results[0].price, '$12.00')
})

test('Amazon handles both heading link layouts and unavailable prices', () => {
    const html = `<div data-component-type="s-search-result" data-asin="ABC"><h2><a href="/dp/ABC"><span>Desk light</span></a></h2><span class="a-price"><span class="a-offscreen">$21</span></span><img class="s-image" src="https://m.media-amazon.com/light.jpg"><span>Sponsored</span></div>
  <div data-component-type="s-search-result" data-asin="DEF"><a href="/dp/DEF"><h2>Second light</h2></a></div>`
    const results = extractResults(html, 'amazon')
    assert.equal(results.length, 2)
    assert.equal(results[0].url, 'https://www.amazon.com/dp/ABC')
    assert.equal(results[0].sponsored, true)
    assert.equal(results[1].price, null)
})

test('Amazon extracts the product heading, feedback count and monthly purchases without treating star ratings as feedback', () => {
    const html = `<div data-component-type="s-search-result" data-asin="FERRARI1"><div data-cy="title-recipe"><div class="a-row a-color-secondary"><h2 class="a-size-mini">LEGO</h2></div><a href="/dp/FERRARI1"><h2 aria-label="Icons Ferrari F2004 & Michael Schumacher 11375">Icons Ferrari F2004 &amp; Michael Schumacher 11375</h2></a></div><div data-cy="reviews-block"><a aria-label="4.8 out of 5 stars, rating details">4.8 stars</a><a aria-label="935 ratings" href="/dp/FERRARI1#customerReviews"><span>(935)</span></a><span>900+ bought in past month</span></div></div>`
    const [result] = extractResults(html, 'amazon_uk')
    assert.equal(result.title, 'LEGO Icons Ferrari F2004 & Michael Schumacher 11375')
    assert.equal(result.feedbackCount, '935')
    assert.equal(result.boughtPastMonth, '900+ bought in past month')
})

test('Amazon item-page feedback ignores average star rating and reads localized monthly purchases', () => {
    const html = '<div id="averageCustomerReviews"><a aria-label="4.7 out of 5 stars, rating details">4.7 stars</a><span id="acrCustomerReviewText">(940)</span></div><div id="social-proofing-faceout-title-tk_bought"><span>600+ Mal im letzten Monat gekauft</span></div>'
    assert.deepEqual(extractItemMetrics(html, 'amazon_de'), {
        feedbackCount: '940',
        boughtPastMonth: '600+ Mal im letzten Monat gekauft',
    })
    assert.deepEqual(extractItemMetrics('<span aria-label="4.7 out of 5 stars, rating details">4.7 stars</span>', 'amazon'), {
        feedbackCount: null,
        boughtPastMonth: null,
    })
})

test('eBay supports s-card layout', () => {
    assert.equal(extractResults('<div class="srp-results"><div class="s-card"><a class="s-card__link" href="/itm/123"><h3 class="s-card__title">Camera</h3></a><span class="s-card__price">$10</span></div></div>', 'ebay')[0].title, 'Camera')
})

test('rejects unsafe and off-store product links', () => {
    for (const href of ['javascript:alert(1)', 'https://amazon.com.evil.test/dp/ABC', 'http://www.amazon.com/dp/ABC']) {
        assert.deepEqual(extractResults(`<div data-component-type="s-search-result" data-asin="ABC"><h2><a href="${href}">Item</a></h2></div>`, 'amazon'), [])
    }
})

test('recognizes access challenges and encodes keywords', () => {
    assert.equal(isChallenge('<title>Robot Check</title>'), true)
    assert.equal(isChallenge('<title>Search</title><body>Verify you are human</body>'), true)
    assert.equal(isChallenge('<title>Camera results</title>'), false)
    assert.match(stores.ebay.url('camera & lens'), /camera%20%26%20lens$/)
})

test('eBay API requests ten Best Match items with a server-side token', async () => {
    const result = await searchEbayApi('camera & lens', new AbortController().signal, 'test-token', async (url, options) => {
        assert.equal(url.searchParams.get('q'), 'camera & lens')
        assert.equal(url.searchParams.get('limit'), '10')
        assert.equal(options.headers.Authorization, 'Bearer test-token')
        assert.equal(options.redirect, 'error')
        return Response.json({ itemSummaries: [{ itemId: '1', title: 'Camera', itemWebUrl: 'https://www.ebay.com/itm/123', price: { currency: 'USD', value: '25.00' } }] })
    })
    assert.equal(result.status, 'success')
    assert.equal(result.results[0].price, 'USD 25.00')
    assert.equal(JSON.stringify(result).includes('test-token'), false)
})

test('eBay API reports expired tokens, empty results, rate limits and malformed responses', async () => {
    const search = response => searchEbayApi('camera', new AbortController().signal, 'test-token', async () => response)
    assert.equal((await search(new Response('', { status: 401 }))).status, 'blocked')
    assert.equal((await search(new Response('', { status: 429 }))).status, 'error')
    assert.equal((await search(Response.json({ total: 0 }))).status, 'empty')
    assert.equal((await search(Response.json({ errors: [] }))).status, 'error')
})