import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { identifyImage } from './vision.js'

const picture = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#145e4a' } }).png().toBuffer()
const signal = () => new AbortController().signal

test('normalizes image bytes and uses a local vision model, not the filename', async () => {
    const result = await identifyImage(await picture(), 'image/png', signal(), async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:11434/api/generate')
        const body = JSON.parse(options.body)
        assert.equal(body.stream, false)
        assert.equal((await sharp(Buffer.from(body.images[0], 'base64')).metadata()).format, 'jpeg')
        return Response.json({ response: JSON.stringify({ keywords: ' green desk lamp ', itemDetected: true }) })
    })
    assert.deepEqual(result, { keywords: 'green desk lamp' })
})

test('rejects invalid MIME, disguised images, corrupt and oversized files before inference', async () => {
    const request = () => { throw new Error('Must not call inference') }
    for (const [bytes, type, status] of [[Buffer.from('<svg/>'), 'image/svg+xml', 400], [await picture(), 'image/jpeg', 400], [Buffer.from('bad'), 'image/png', 400], [Buffer.alloc(30 * 1024 * 1024 + 1), 'image/png', 413]]) {
        await assert.rejects(identifyImage(bytes, type, signal(), request), error => error.status === status)
    }
})

test('reports model availability, no item, malformed output and timeout separately', async () => {
    const image = await picture()
    const identify = request => identifyImage(image, 'image/png', signal(), request)
    await assert.rejects(identify(async () => new Response('', { status: 404 })), error => error.status === 503)
    for (const [response, status] of [['not JSON', 502], [JSON.stringify({ keywords: '', itemDetected: false }), 422], [JSON.stringify({ keywords: 'x'.repeat(101), itemDetected: true }), 502], ['null', 502]]) {
        await assert.rejects(identify(async () => Response.json({ response })), error => error.status === status)
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(identifyImage(image, 'image/png', controller.signal, async (_url, options) => { options.signal.throwIfAborted() }), error => error.status === 504)
})