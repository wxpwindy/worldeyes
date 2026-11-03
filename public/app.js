const form = document.querySelector('#search-form')
const resultsElement = document.querySelector('#results')
const statusElement = document.querySelector('#search-status')
const errorElement = document.querySelector('#error')
const searchButton = document.querySelector('#search-button')
const cancelButton = document.querySelector('#cancel-button')
const exportButton = document.querySelector('#export-button')
const names = {
    ebay: 'eBay',
    amazon: 'Amazon',
    amazon_uk: 'Amazon UK',
    amazon_de: 'Amazon DE',
}
let lastSearch = null
let controller = null
const pictureInput = document.querySelector('#picture')
const preview = document.querySelector('#picture-preview')
const pictureButton = document.querySelector('#picture-search-button')
const removePictureButton = document.querySelector('#remove-picture-button')
const photoStatus = document.querySelector('#photo-status')
let photoController = null
let selectedPicture = null
let previewUrl = null

function updatePhotoControls() {
    pictureButton.disabled = Boolean(controller || photoController || !selectedPicture)
    removePictureButton.disabled = Boolean(controller || photoController)
    pictureInput.disabled = Boolean(controller || photoController)
}

function clearPicture(resetInput = true) {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = null
    selectedPicture = null
    if (resetInput) pictureInput.value = ''
    preview.removeAttribute('src')
    preview.hidden = true
    removePictureButton.hidden = true
    photoStatus.textContent = ''
    updatePhotoControls()
}

pictureInput.addEventListener('change', () => {
    const file = pictureInput.files[0]
    clearPicture(false)
    errorElement.hidden = true
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 30 * 1024 * 1024) {
        pictureInput.value = ''
        errorElement.textContent = 'Choose a JPEG, PNG or WebP picture of 30 MB or less.'
        errorElement.hidden = false
        return
    }
    selectedPicture = file
    previewUrl = URL.createObjectURL(file)
    preview.src = previewUrl
    preview.hidden = false
    removePictureButton.hidden = false
    photoStatus.textContent = file.name
    updatePhotoControls()
})
preview.addEventListener('error', () => {
    if (!selectedPicture) return
    clearPicture()
    errorElement.textContent = 'This picture could not be opened. Try another image.'
    errorElement.hidden = false
})
removePictureButton.addEventListener('click', () => clearPicture())
window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl) })

pictureButton.addEventListener('click', async () => {
    if (!selectedPicture || controller || photoController) return
    errorElement.hidden = true
    if (!form.querySelector('[name="website"]:checked')) {
        errorElement.textContent = 'Select at least one website.'
        errorElement.hidden = false
        return
    }
    photoController = new AbortController()
    updatePhotoControls()
    searchButton.disabled = true
    cancelButton.hidden = false
    for (const input of form.querySelectorAll('input')) input.disabled = true
    photoStatus.textContent = 'Identifying the item...'
    const deadline = setTimeout(() => photoController?.abort('timeout'), 65000)
    let identified = false
    try {
        const response = await fetch('/api/image-keywords', {
            method: 'POST', headers: { 'Content-Type': selectedPicture.type, 'X-Worldeyes-Request': '1' },
            body: selectedPicture, signal: photoController.signal,
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not identify this picture.')
        document.querySelector('#keywords').value = data.keywords
        photoStatus.textContent = `Suggested keywords: ${data.keywords}`
        identified = true
    } catch (error) {
        const cancelled = photoController.signal.aborted && photoController.signal.reason !== 'timeout'
        photoStatus.textContent = cancelled ? 'Picture search cancelled.' : 'Item not identified.'
        if (!cancelled) {
            errorElement.textContent = photoController.signal.aborted ? 'Image recognition timed out. Try again or enter keywords manually.' : error.message
            errorElement.hidden = false
        }
    } finally {
        clearTimeout(deadline)
        photoController = null
        searchButton.disabled = false
        cancelButton.hidden = true
        for (const input of form.querySelectorAll('input')) input.disabled = false
        updatePhotoControls()
    }
    if (identified) form.requestSubmit()
})

function node(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
}

function externalLink(url, text, className) {
    const link = node('a', className, text)
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return link
}

function renderStore(store) {
    const panel = node('section', `store-panel ${store.status}`)
    panel.setAttribute('aria-label', names[store.store])
    const header = node('div', 'panel-header')
    header.append(node('h3', store.store, names[store.store]))
    const labels = { idle: 'NOT SEARCHED', loading: 'SEARCHING', blocked: 'ACCESS RESTRICTED', error: 'UNAVAILABLE', empty: 'NO MATCHES', cancelled: 'CANCELLED' }
    header.append(node('span', 'panel-state', store.status === 'success' ? `${store.results.length} RESULTS` : labels[store.status]))
    panel.append(header)
    if (store.results?.length) {
        const list = node('ol', 'product-list')
        for (const result of store.results) {
            const item = node('li', 'product')
            item.append(node('span', 'rank', String(result.rank).padStart(2, '0')))
            const placeholder = () => node('span', 'product-image image-placeholder', 'No image')
            if (result.image) {
                const image = node('img', 'product-image')
                image.src = result.image
                image.alt = result.title
                image.loading = 'lazy'
                image.referrerPolicy = 'no-referrer'
                image.addEventListener('error', () => image.replaceWith(placeholder()), { once: true })
                item.append(image)
            } else item.append(placeholder())
            const details = node('div', 'product-details')
            details.append(externalLink(result.url, result.title, 'product-title'), node('p', 'price', result.price || 'Price unavailable'))
            const meta = node('div', 'product-meta')
            meta.append(
                node('span', 'feedback-count', `Feedback: ${result.feedbackCount || 'N/A'}`),
                node('span', 'bought-count', `Bought (past month): ${result.boughtPastMonth || 'N/A'}`),
            )
            details.append(meta)
            if (result.shipping) details.append(node('p', 'shipping', result.shipping))
            if (result.sponsored) details.append(node('span', 'sponsored', 'Sponsored'))
            item.append(details)
            list.append(item)
        }
        panel.append(list, externalLink(store.searchUrl, `All results on ${names[store.store]}`, 'store-link'))
    } else {
        const empty = node('div', 'empty')
        if (store.status === 'loading') {
            const bars = node('div', 'loading-bars')
            bars.setAttribute('aria-hidden', 'true')
            bars.append(node('span'), node('span'), node('span'))
            empty.append(bars)
        } else empty.append(node('span', 'empty-number', store.status === 'idle' ? '01 - 10' : '--'))
        const titles = { idle: 'No search yet', loading: `Searching ${names[store.store]}...`, blocked: 'Access restricted', error: 'Store unavailable', empty: 'No matching products', cancelled: 'Search cancelled' }
        empty.append(node('h4', '', titles[store.status]))
        if (store.message) empty.append(node('p', '', store.message))
        if (store.searchUrl) empty.append(externalLink(store.searchUrl, `Open ${names[store.store]} search`, ''))
        panel.append(empty)
    }
    return panel
}

function render(stores) {
    resultsElement.replaceChildren(...stores.map(renderStore))
    resultsElement.classList.toggle('single', stores.length === 1)
}

render(Object.keys(names).map(store => ({ store, status: 'idle' })))
form.addEventListener('submit', async event => {
    event.preventDefault()
    if (controller || photoController) return
    const keywords = document.querySelector('#keywords').value.trim()
    const websites = [...form.querySelectorAll('[name="website"]:checked')].map(input => input.value)
    errorElement.hidden = true
    if (!keywords || !keywords.trim() || keywords.trim().length < 1 || keywords.trim().length > 160) {
        errorElement.textContent = 'Enter 1-160 characters.'
        errorElement.hidden = false
        return
    }
    const validWebsites = websites.filter(website => Object.hasOwn(names, website))
    if (validWebsites.length === 0) {
        errorElement.textContent = 'Select at least one supported store.'
        errorElement.hidden = false
        return
    }
    if (validWebsites.length > 2) {
        errorElement.textContent = 'Maximum 2 stores.'
        errorElement.hidden = false
        return
    }
    controller = new AbortController()
    updatePhotoControls()
    lastSearch = null
    searchButton.disabled = true
    cancelButton.hidden = false
    exportButton.disabled = true
    for (const input of form.querySelectorAll('input')) input.disabled = true
    render(websites.map(store => ({ store, status: 'loading' })))
    resultsElement.setAttribute('aria-busy', 'true')
    statusElement.textContent = `Searching for "${keywords}"...`
    const deadline = setTimeout(() => controller?.abort('timeout'), 70000)
    try {
        const response = await fetch('/api/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worldeyes-Request': '1' },
            body: JSON.stringify({ keywords, websites }), signal: controller.signal,
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Search failed. Please try again.')
        lastSearch = data
        render(data.stores)
        const total = data.stores.reduce((count, store) => count + store.results.length, 0)
        statusElement.textContent = `${total} results for "${keywords}" / ${new Date(data.searchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        exportButton.disabled = total === 0
    } catch (error) {
        const cancelled = controller.signal.aborted && controller.signal.reason !== 'timeout'
        const message = cancelled ? null : controller.signal.aborted ? 'Search timed out. Please try again.' : error.message
        render(websites.map(store => ({ store, status: cancelled ? 'cancelled' : 'error' })))
        statusElement.textContent = cancelled ? 'Search cancelled.' : 'Search could not finish.'
        if (message) { errorElement.textContent = message; errorElement.hidden = false }
    } finally {
        clearTimeout(deadline)
        controller = null
        searchButton.disabled = false
        cancelButton.hidden = true
        for (const input of form.querySelectorAll('input')) input.disabled = false
        resultsElement.setAttribute('aria-busy', 'false')
        updatePhotoControls()
    }
})

cancelButton.addEventListener('click', () => { controller?.abort(); photoController?.abort() })
exportButton.addEventListener('click', () => {
    if (!lastSearch) return
    const rows = [['Store', 'Rank', 'Title', 'Price', 'Feedback', 'Bought (past month)', 'Shipping', 'Sponsored', 'URL', 'Searched at']]
    for (const store of lastSearch.stores) for (const result of store.results) {
        rows.push([names[store.store], result.rank, result.title, result.price || '', result.feedbackCount || '', result.boughtPastMonth || '', result.shipping || '', result.sponsored ? 'Yes' : 'No', result.url, lastSearch.searchedAt])
    }
    const quote = value => {
        const text = String(value)
        const safe = /^\s*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text
        return `"${safe.replaceAll('"', '""')}"`
    }
    const blob = new Blob(['\uFEFF', rows.map(row => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `worldeyes-${Date.now()}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
})