import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { ImageSearchError } from './vision.js'

async function fixture(t, options) {
    const server = createApp(options).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const base = `http://127.0.0.1:${server.address().port}`
    return (body, headers = {}, path = '/api/search') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worldeyes-Request': '1', ...headers }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) })
}

test('returns independent results for the selected stores', async t => {
    const post = await fixture(t, {
        search: async (keywords, websites) => {
            assert.equal(keywords, 'camera')
            return websites.map(store => ({ store, status: store === 'amazon' ? 'blocked' : 'success', results: [] }))
        }
    })
    const response = await post({ keywords: ' camera ', websites: ['ebay', 'amazon'] })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).stores.map(store => store.status), ['success', 'blocked'])
})

test('rejects invalid input, arbitrary hosts, duplicate stores and cross-origin requests', async t => {
    const post = await fixture(t, { search: () => { throw new Error('must not run') } })
    for (const body of [null, {}, { keywords: '', websites: ['ebay'] }, { keywords: 'x', websites: ['http://127.0.0.1'] }, { keywords: 'x', websites: ['ebay', 'ebay'] }, { keywords: 'x', websites: ['toString'] }]) {
        assert.equal((await post(body)).status, 400)
    }
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] }, { Origin: 'https://evil.test' })).status, 403)
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] }, { 'X-Worldeyes-Request': '' })).status, 403)
})

test('throttles repeated searches', async t => {
    const post = await fixture(t, { search: async () => [] })
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] })).status, 200)
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] })).status, 429)
})

test('releases the search lock after a provider failure', async t => {
    let calls = 0
    const post = await fixture(t, { cooldownMs: 0, search: async () => { if (!calls++) throw new Error('failed'); return [] } })
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] })).status, 503)
    assert.equal((await post({ keywords: 'x', websites: ['ebay'] })).status, 200)
})

test('picture upload passes bytes to recognition and allows the subsequent keyword search', async t => {
    const bytes = Buffer.from('fixture')
    const post = await fixture(t, {
        identify: async (body, type) => {
            assert.deepEqual(body, bytes)
            assert.equal(type, 'image/png')
            return { keywords: 'desk lamp' }
        }, search: async () => []
    })
    const response = await post(bytes, { 'Content-Type': 'image/png' }, '/api/image-keywords')
    assert.deepEqual(await response.json(), { keywords: 'desk lamp' })
    assert.equal((await post({ keywords: 'desk lamp', websites: ['amazon'] })).status, 200)
    assert.equal((await post(bytes, { 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 429)
})

test('picture uploads retain origin/header guards and report recognition errors', async t => {
    const post = await fixture(t, { cooldownMs: 0, identify: async () => { throw new ImageSearchError('No product recognized.', 422) } })
    const bytes = Buffer.from('fixture')
    assert.equal((await post(bytes, { Origin: 'https://evil.test', 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 403)
    assert.equal((await post(bytes, { 'X-Worldeyes-Request': '', 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 403)
    assert.equal((await post(bytes, { 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 422)
    assert.equal((await post(bytes, { 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 422)
    assert.equal((await post(Buffer.alloc(30 * 1024 * 1024 + 1), { 'Content-Type': 'image/png' }, '/api/image-keywords')).status, 413)
})