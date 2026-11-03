import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { createApp } from '../app.js'
import sharp from 'sharp'

const photo = { name: 'not-the-product-name.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 120, height: 100, channels: 3, background: '#145e4a' } }).png().toBuffer() }

const server = createApp({ cooldownMs: 0, search: async () => { throw new Error('Tests must intercept searches') } }).listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
let browser
try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome') })
    await mkdir('test-results', { recursive: true })
    for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        let mode = 'success'
        let photoMode = 'success'
        let photoCalls = 0
        let lastKeywords
        await page.route('**/api/image-keywords', async route => {
            photoCalls++
            assert.deepEqual(route.request().postDataBuffer(), photo.buffer)
            if (photoMode === 'cancel') return
            if (photoMode === 'error') return route.fulfill({ status: 503, json: { error: 'Local vision model unavailable.' } })
            await route.fulfill({ json: { keywords: 'green desk lamp' } })
        })
        await page.route('**/api/search', async route => {
            if (mode === 'cancel') return
            if (mode === 'error') return route.fulfill({ status: 429, json: { error: 'Please wait between searches.' } })
            const { websites, keywords } = route.request().postDataJSON()
            lastKeywords = keywords
            await route.fulfill({
                json: {
                    keywords, searchedAt: new Date().toISOString(),
                    stores: websites.map(store => ({
                        store, searchUrl: `https://www.${store}.com/`,
                        status: mode === 'empty' ? 'empty' : store === 'amazon' ? 'blocked' : 'success',
                        message: store === 'amazon' ? 'Fixture: automated access restricted.' : 'No matching products found.',
                        results: store === 'ebay' && mode === 'success' ? Array.from({ length: 10 }, (_, index) => ({
                            rank: index + 1, title: index ? `Camera fixture ${index + 1}` : '=Untrusted product title <script>alert(1)</script>',
                            price: '$25.00', url: 'https://www.ebay.com/itm/123', image: null,
                        })) : [],
                    })),
                }
            })
        })
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.fill('#keywords', 'camera')
        await page.click('#search-button')
        await page.waitForSelector('.product')
        assert.equal(await page.locator('.product').count(), 10)
        assert.equal(await page.locator('.blocked').count(), 1)
        assert.equal(await page.locator('.product script').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        const downloadPromise = page.waitForEvent('download')
        await page.click('#export-button')
        const download = await downloadPromise
        assert.match(download.suggestedFilename(), /\.csv$/)
        assert.match(await readFile(await download.path(), 'utf8'), /"'=Untrusted/)
        await page.screenshot({ path: `test-results/search-${width}.png`, fullPage: true })
        mode = 'empty'
        await page.uncheck('[value="amazon"]')
        await page.click('#search-button')
        await page.waitForSelector('.store-panel.empty')
        assert.equal(await page.locator('.store-panel').count(), 1)
        assert.equal(await page.locator('#export-button').isDisabled(), true)
        mode = 'error'
        await page.click('#search-button')
        await page.waitForSelector('#error:not([hidden])')
        assert.match(await page.locator('#error').textContent(), /Please wait/)
        mode = 'cancel'
        await page.click('#search-button')
        await page.click('#cancel-button')
        await page.waitForSelector('.cancelled')
        assert.equal(await page.locator('#search-button').isEnabled(), true)
        mode = 'success'
        await page.locator('#picture').setInputFiles(photo)
        await page.waitForFunction(() => document.querySelector('#picture-preview').naturalWidth === 120)
        assert.match(await page.locator('#picture').inputValue(), /not-the-product-name\.png$/)
        await page.click('#picture-search-button')
        await page.waitForSelector('.product')
        assert.equal(await page.locator('#keywords').inputValue(), 'green desk lamp')
        assert.equal(lastKeywords, 'green desk lamp')
        assert.equal(photoCalls, 1)
        assert.equal(await page.locator('.product').count(), 10)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: `test-results/photo-${width}.png`, fullPage: true })
        photoMode = 'error'
        await page.click('#picture-search-button')
        await page.waitForSelector('#error:not([hidden])')
        assert.match(await page.locator('#error').textContent(), /vision model unavailable/)
        photoMode = 'cancel'
        await page.click('#picture-search-button')
        await page.click('#cancel-button')
        await page.waitForFunction(() => document.querySelector('#photo-status').textContent === 'Picture search cancelled.')
        assert.equal(await page.locator('#picture-search-button').isEnabled(), true)
        await page.click('#remove-picture-button')
        assert.equal(await page.locator('#picture-preview').isVisible(), false)
        assert.equal(await page.locator('#picture-search-button').isDisabled(), true)
        await page.locator('#picture').setInputFiles({ name: 'image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
        assert.equal(await page.locator('#picture-search-button').isDisabled(), true)
        assert.match(await page.locator('#error').textContent(), /JPEG, PNG or WebP/)
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`PASS ${width}px: keyword search, photo preview/search/removal, invalid upload, recognition error/cancel, CSV safety, no overflow`)
    }
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}