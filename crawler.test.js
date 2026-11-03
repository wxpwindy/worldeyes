import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { chromium } from 'playwright'
import { searchStores } from './crawler.js'

test('crawls Amazon US, UK and DE pages and extracts marketplace results', async t => {
    const fixtures = {
        'www.amazon.com': '<div data-component-type="s-search-result" data-asin="US1"><h2><a href="/dp/US1"><span>US lamp</span></a></h2></div>',
        'www.amazon.co.uk': '<div data-component-type="s-search-result" data-asin="UK1"><a class="a-link-normal s-link-style" href="/Portable-Stand/dp/UK1"><h2 class="a-size-medium"><span>UK lamp</span></h2></a><div data-cy="reviews-block"><a aria-label="42 ratings" href="/Portable-Stand/dp/UK1#customerReviews"><span>(42)</span></a><span>100+ bought in past month</span></div><span class="a-price"><span class="a-offscreen">£19.99</span></span><img class="s-image" src="https://m.media-amazon.com/images/I/uk.jpg"></div>',
        'www.amazon.de': '<div data-component-type="s-search-result" data-asin="DE1"><a class="a-link-normal s-link-style" href="/Portable-Stand/dp/DE1"><h2 class="a-size-medium"><span>DE Lampe</span></h2></a><span class="a-price"><span class="a-offscreen">19,99 €</span></span><img class="s-image" src="https://m.media-amazon.com/images/I/de.jpg"><span>Gesponsert</span></div>',
    }
    const itemFixtures = {
        'https://www.amazon.com/dp/US1': '<span id="acrCustomerReviewText">(188)</span><span id="social-proofing-faceout-title-tk_bought">300+ bought in past month</span>',
        'https://www.amazon.de/Portable-Stand/dp/DE1': '<span id="acrCustomerReviewText">(75)</span><span id="social-proofing-faceout-title-tk_bought">50+ Mal im letzten Monat gekauft</span>',
    }
    const browser = {
        async newContext() {
            return {
                on() { },
                async route() { },
                async newPage() {
                    let html = ''
                    return {
                        async goto(url) {
                            html = itemFixtures[url] || fixtures[new URL(url).hostname] || ''
                            return { status: () => 200, ok: () => true }
                        },
                        async content() { return html },
                        locator() {
                            return {
                                first() { return { async waitFor() { } } },
                                async innerText() { return '' },
                            }
                        },
                        async close() { },
                    }
                },
                async close() { },
            }
        },
        async close() { },
    }
    t.mock.method(chromium, 'launch', async () => browser)
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))

    const results = await searchStores('lamp', ['amazon', 'amazon_uk', 'amazon_de'], new AbortController().signal)

    assert.deepEqual(results.map(result => result.status), ['success', 'success', 'success'])
    assert.deepEqual(results.map(result => result.results[0].title), ['US lamp', 'UK lamp', 'DE Lampe'])
    assert.deepEqual(results.map(result => result.results[0].url), [
        'https://www.amazon.com/dp/US1',
        'https://www.amazon.co.uk/Portable-Stand/dp/UK1',
        'https://www.amazon.de/Portable-Stand/dp/DE1',
    ])
    assert.deepEqual(results.map(result => result.results[0].feedbackCount), ['188', '42', '75'])
    assert.deepEqual(results.map(result => result.results[0].boughtPastMonth), [
        '300+ bought in past month',
        '100+ bought in past month',
        '50+ Mal im letzten Monat gekauft',
    ])
    assert.equal(results[2].results[0].sponsored, true)
})