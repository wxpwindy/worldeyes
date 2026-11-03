import express from 'express'
import { fileURLToPath } from 'node:url'
import { stores } from './search.js'
import { searchStores } from './crawler.js'
import { identifyImage, ImageSearchError } from './vision.js'

export function createApp({ search = searchStores, identify = identifyImage, cooldownMs = 15000 } = {}) {
    const app = express()
    let busy = false
    let lastStarted = -Infinity
    let lastImageStarted = -Infinity
    app.disable('x-powered-by')
    app.use((req, res, next) => {
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return res.status(403).json({ error: 'Local access only.' })
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            'Cache-Control': 'no-store',
        })
        if (req.method === 'POST' && (req.get('X-Worldeyes-Request') !== '1' || (req.get('Origin') && req.get('Origin') !== `http://${req.headers.host}`))) {
            return res.status(403).json({ error: 'Request must originate from this app.' })
        }
        next()
    })
    app.post('/api/image-keywords', express.raw({ type: () => true, limit: '30mb', inflate: false }), async (req, res) => {
        if (busy) return res.status(409).json({ error: 'A search is already running. Wait for it to finish.' })
        if (Date.now() - lastImageStarted < cooldownMs) return res.status(429).json({ error: 'Please wait a few seconds between picture searches.' })
        busy = true
        lastImageStarted = Date.now()
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        try {
            const result = await identify(req.body, (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase(), controller.signal)
            if (!res.destroyed) res.json(result)
        } catch (error) {
            if (!res.destroyed) res.status(error instanceof ImageSearchError ? error.status : 503).json({ error: error instanceof ImageSearchError ? error.message : 'Image recognition is unavailable. Try again or enter keywords manually.' })
        } finally {
            busy = false
        }
    })
    app.use(express.json({ limit: '4kb' }))
    app.get('/api/stores', (_req, res) => res.json(Object.entries(stores).map(([id, store]) => ({ id, name: store.name, host: store.host }))))
    app.post('/api/search', async (req, res) => {
        const { keywords, websites } = req.body || {}
        if (typeof keywords !== 'string' || !keywords.trim() || keywords.trim().length > 160
            || !Array.isArray(websites) || !websites.length || websites.length > 2
            || websites.some(site => typeof site !== 'string' || !Object.hasOwn(stores, site))
            || new Set(websites).size !== websites.length) {
            return res.status(400).json({ error: 'Enter 1-160 characters and select at least one supported store.' })
        }
        if (busy) return res.status(409).json({ error: 'A search is already running. Wait for it to finish.' })
        if (Date.now() - lastStarted < cooldownMs) {
            res.set('Retry-After', String(Math.ceil((cooldownMs - (Date.now() - lastStarted)) / 1000)))
            return res.status(429).json({ error: 'Please wait a few seconds between searches.' })
        }
        busy = true
        lastStarted = Date.now()
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        try {
            const results = await search(keywords.trim(), websites, controller.signal)
            if (!res.destroyed) res.json({ keywords: keywords.trim(), searchedAt: new Date().toISOString(), stores: results })
        } catch {
            if (!res.destroyed) res.status(503).json({ error: 'The browser is unavailable. Run npm run browser:install and retry.' })
        } finally {
            busy = false
        }
    })
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }))
    app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))))
    app.use((error, _req, res, _next) => {
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? 'Upload exceeds the allowed size. Pictures must be 30 MB or smaller.' : 'Invalid request body.' })
    })
    return app
}