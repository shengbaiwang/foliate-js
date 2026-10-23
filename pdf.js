const pdfjsPath = path => `/vendor/pdfjs/${path}`
import * as CFI from './epubcfi.js'

import '@pdfjs/pdf.min.mjs'
import { appendOCR, ocrText } from './pdf-ocr.js'
import { setupOCRSelection } from './pdf-selection.js'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.min.mjs')

const fetchText = async url => await (await fetch(url)).text()

// Some system WebViews support stream readers but not async iteration. PDF.js
// getTextContent uses `for await`; consume its public stream with a reader so
// extraction and import work with the same content and normalization there.
const readTextContent = async page => {
    if (!page.streamTextContent) return page.getTextContent()
    const reader = page.streamTextContent().getReader()
    const content = { items: [], styles: Object.create(null), lang: null }
    try {
        for (;;) {
            const { value, done } = await reader.read()
            if (done) return content
            content.lang ??= value.lang
            Object.assign(content.styles, value.styles)
            content.items.push(...value.items)
        }
    } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
    } finally { reader.releaseLock() }
}

// The OS accessibility "font size" setting scales every piece of WebView-rendered
// text (including this transparent selection/highlight text layer) but leaves the
// page's canvas bitmap untouched. Only the glyph *size* (a font-size) is scaled;
// the text layer's positions are percentages of the `--total-scale-factor`-sized
// container and are not. Left uncorrected the glyphs render `fontScale`x larger
// than the ones baked into the canvas, so selection and highlight rectangles
// overshoot the text into the blank margins and sit too low (readest #4480).
// Measure the scale here so render() can divide it back out of the glyph-size
// lever only. offsetHeight of a 100px/line-height-1 box reflects the OS font
// scaling but not devicePixelRatio or CSS transforms, so it isolates it.
const getFontScale = doc => {
    const probe = doc.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
        + 'font-size:100px;line-height:1;text-size-adjust:none;-webkit-text-size-adjust:none'
    probe.textContent = 'x'
    doc.body.append(probe)
    const fontScale = probe.offsetHeight / 100
    probe.remove()
    return fontScale > 0 ? fontScale : 1
}

let textLayerBuilderCSS = null
let annotationLayerBuilderCSS = null

// Track active render tasks per iframe document to cancel superseded renders
const activeRenderTasks = new WeakMap()
const activeTextTasks = new WeakMap()
// Generation counter per document to detect stale renders after async gaps
const renderGenerations = new WeakMap()

// Set up panning and selection event handlers once per iframe document
const setupPanningEvents = (doc) => {
    if (doc._readestEventsInitialized) return
    doc._readestEventsInitialized = true

    const container = doc.querySelector('.textLayer')
    if (!container) return

    let isPanning = false
    let startX = 0
    let startY = 0
    let scrollLeft = 0
    let scrollTop = 0
    let scrollParent = null

    const findScrollableParent = (element) => {
        let current = element
        while (current) {
            if (current !== document.body && current.nodeType === 1) {
                const style = window.getComputedStyle(current)
                const overflow = style.overflow + style.overflowY + style.overflowX
                if (/(auto|scroll)/.test(overflow)) {
                    if (current.scrollHeight > current.clientHeight ||
                        current.scrollWidth > current.clientWidth) {
                        return current
                    }
                }
            }
            if (current.parentElement) {
                current = current.parentElement
            } else if (current.parentNode && current.parentNode.host) {
                current = current.parentNode.host
            } else {
                break
            }
        }
        return window
    }

    container.onpointerdown = (e) => {
        if (e.button !== 0 || !e.isPrimary) return
        const selection = doc.getSelection()
        const hasTextSelection = selection && selection.toString().length > 0

        const elementUnderCursor = doc.elementFromPoint(e.clientX, e.clientY)
        const hasTextUnderneath = elementUnderCursor &&
                             (elementUnderCursor.tagName === 'SPAN' || elementUnderCursor.tagName === 'P') &&
                             elementUnderCursor.textContent.trim().length > 0

        if (!hasTextUnderneath && !hasTextSelection) {
            isPanning = true
            startX = e.screenX
            startY = e.screenY

            const iframe = doc.defaultView?.frameElement
            if (iframe) {
                scrollParent = findScrollableParent(iframe)
                if (scrollParent === window) {
                    scrollLeft = window.scrollX || window.pageXOffset
                    scrollTop = window.scrollY || window.pageYOffset
                } else {
                    scrollLeft = scrollParent.scrollLeft
                    scrollTop = scrollParent.scrollTop
                }
                container.style.cursor = 'grabbing'
            }
        } else {
            container.classList.add('selecting')
        }
    }

    container.onpointermove = (e) => {
        if (isPanning && scrollParent) {
            e.preventDefault()

            const dx = e.screenX - startX
            const dy = e.screenY - startY

            if (scrollParent === window) {
                window.scrollTo(scrollLeft - dx, scrollTop - dy)
            } else {
                scrollParent.scrollLeft = scrollLeft - dx
                scrollParent.scrollTop = scrollTop - dy
            }
        }
    }

    container.onpointerup = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        } else {
            container.classList.remove('selecting')
        }
    }

    container.onpointerleave = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        }
    }

    doc.addEventListener('selectionchange', () => {
        const selection = doc.getSelection()
        if (selection && selection.toString().length > 0) {
            container.style.cursor = 'text'
        } else if (!isPanning) {
            container.style.cursor = 'grab'
        }
    })

    container.style.cursor = 'grab'
}

// iOS kills the WKWebView content process when it exceeds a per-process memory
// high-water limit (~2 GB). A device crash log for readest #5118 shows the
// foreground WebContent process reaching 2.1 GB while paging a PDF, right before
// the reader "closed". Both a page's canvas bitmap and its WebKit backing layer
// are allocated at the render scale, so their memory grows with the SQUARE of the
// device pixel ratio. Phones report dpr 3, which is the tipping factor.
// Rendering at 2x instead of 3x is still retina-sharp but uses ~2.25x less memory
// per page (the crisp, selectable text layer is a separate DOM layer, unaffected).
const MAX_RENDER_DPR = 2
// Hard ceiling on a single page's bitmap area (~3.1 Mpx ≈ 12.6 MB) so a large
// tablet page can't blow the budget even after the dpr clamp.
const MAX_CANVAS_PIXELS = 2048 * 1536

// Only mobile WebViews get that budget. Desktop browsers have no per-process
// memory ceiling, and a page fitted to a desktop window is several times the
// budget on its own, so clamping there bought nothing and cost sharpness: the
// raster ended up coarser than the screen, the browser upscaled it into the CSS
// box, and PDF text looked blurry (readest #5251). iPadOS reports a desktop
// ("Macintosh") user agent, so touch points are what give a tablet away.
const isMobileWebView = () => {
    const ua = navigator.userAgent
    return /Android|iPhone|iPad|iPod/i.test(ua)
        || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

// The device pixel ratio to rasterise this page at: the real dpr on desktop, or
// on mobile the dpr clamped by both MAX_RENDER_DPR and the per-canvas pixel
// budget. Never below 1 (CSS resolution).
const getRenderDpr = (page, zoom) => {
    let dpr = devicePixelRatio || 1
    if (isMobileWebView()) {
        dpr = Math.min(dpr, MAX_RENDER_DPR)
        const { width, height } = page.getViewport({ scale: zoom || 1 })
        const area = width * height * dpr * dpr
        if (area > MAX_CANVAS_PIXELS) dpr *= Math.sqrt(MAX_CANVAS_PIXELS / area)
    }
    return Math.max(1, dpr)
}

const render = async (page, doc, zoom, pageColors, ocr) => {
    if (!doc) return

    // Increment generation to invalidate any in-progress render for this doc
    const generation = (renderGenerations.get(doc) || 0) + 1
    renderGenerations.set(doc, generation)

    // Cancel any in-progress render task for this document
    const existingTask = activeRenderTasks.get(doc)
    if (existingTask) {
        existingTask.cancel()
        activeRenderTasks.delete(doc)
    }
    activeTextTasks.get(doc)?.cancel()

    // Rasterise the page bitmap over-sampled (clamped for the iOS content-process
    // memory budget, see getRenderDpr / readest #5118) but lay the whole DOM out
    // at the true display size. The <canvas> element natively downscales its
    // bitmap to its CSS box, so the raster stays crisp WITHOUT scaling the
    // document. Scaling the document with `transform` promotes the whole page to
    // one over-sized GPU IOSurface that OOM-kills the iOS WebContent process on
    // zoom; scaling it with `zoom` throws off getBoundingClientRect, misplacing
    // text selection and the annotation toolbar. Neither is used: the text and
    // annotation layers live in real display coordinates.
    const renderDpr = getRenderDpr(page, zoom)
    const renderScale = zoom * renderDpr
    // The bitmap viewport is over-sampled; the display viewport drives the CSS
    // box, the text layer and the annotation layer (all in display coordinates).
    const renderViewport = page.getViewport({ scale: renderScale })
    const displayViewport = page.getViewport({ scale: zoom })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = renderViewport.height
    canvas.width = renderViewport.width
    // The CSS box is the un-truncated display size, so the (integer-truncated)
    // over-sampled bitmap is scaled by the browser to fill the page box exactly.
    // Pinning the box to the display viewport (rather than letting the truncated
    // bitmap drive layout) also keeps the left page flush to the spine of a
    // two-page spread instead of exposing a one-pixel white seam (#4587).
    canvas.style.width = `${displayViewport.width}px`
    canvas.style.height = `${displayViewport.height}px`
    const canvasContext = canvas.getContext('2d')
    const renderTask = page.render({ canvasContext, viewport: renderViewport, pageColors })
    activeRenderTasks.set(doc, renderTask)

    try {
        await renderTask.promise
    } catch {
        // Render was cancelled or failed — release canvas bitmap memory
        canvas.width = 0
        canvas.height = 0
        return
    } finally {
        if (activeRenderTasks.get(doc) === renderTask) {
            activeRenderTasks.delete(doc)
        }
    }

    // Bail out if a newer render has started or iframe was removed
    if (renderGenerations.get(doc) !== generation || !doc.defaultView) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    const canvasElement = doc.querySelector('#canvas')
    if (!canvasElement) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    // Render into an isolated, CFI-inert staging layer. A cancelled zoom must
    // never append old text into a newer layer or expose a new bitmap with old
    // hit targets. The live canvas and text swap together after both are ready.
    const container = doc.querySelector('.textLayer')
    const staged = doc.createElement('div')
    staged.className = 'textLayer'
    staged.setAttribute('cfi-inert', '')
    Object.assign(staged.style, { visibility: 'hidden', pointerEvents: 'none' })
    staged.style.setProperty('--total-scale-factor', zoom)
    staged.style.setProperty('--user-unit', '1')
    staged.style.setProperty('--scale-round-x', '1px')
    staged.style.setProperty('--scale-round-y', '1px')
    doc.body.append(staged)
    let textLayer
    try {
        const source = await page.streamTextContent()
        if (renderGenerations.get(doc) !== generation) return
        textLayer = new pdfjsLib.TextLayer({
            textContentSource: source, container: staged, viewport: displayViewport,
        })
        activeTextTasks.set(doc, textLayer)
        await textLayer.render()
        if (renderGenerations.get(doc) !== generation) return
        appendOCR(staged, ocr, displayViewport)
        const oldCanvas = canvasElement.querySelector('canvas')
        if (oldCanvas) oldCanvas.width = oldCanvas.height = 0
        canvasElement.replaceChildren(doc.adoptNode(canvas))
        staged.style.removeProperty('visibility')
        staged.style.removeProperty('pointer-events')
        container.style.cssText = staged.style.cssText
        container.replaceChildren(...staged.childNodes)
        doc.documentElement.style.setProperty('--total-scale-factor', zoom)
        doc.documentElement.style.setProperty('--user-unit', '1')
        doc.documentElement.style.setProperty('--scale-round-x', '1px')
        doc.documentElement.style.setProperty('--scale-round-y', '1px')
    } catch (error) {
        if (renderGenerations.get(doc) === generation) throw error
        return
    } finally {
        staged.remove()
        if (!canvas.isConnected) canvas.width = canvas.height = 0
        if (activeTextTasks.get(doc) === textLayer) activeTextTasks.delete(doc)
    }

    // Counteract the OS font-size accessibility scaling on the text layer's glyph
    // size only (see getFontScale). `--text-scale-factor` feeds `font-size` and
    // nothing else, so dividing it leaves positions (which scale with
    // `--total-scale-factor`) aligned with the canvas at any font-size setting.
    const fontScale = getFontScale(doc)
    if (fontScale !== 1) container.style.setProperty('--text-scale-factor',
        `calc(var(--total-scale-factor) * var(--min-font-size) / ${fontScale})`)

    // hide "offscreen" canvases appended to document when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(hiddenCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)

    // Set up panning/selection event handlers once per document
    setupOCRSelection(container)
    setupPanningEvents(doc)

    // Clear annotation layer before re-rendering to prevent DOM accumulation
    const div = doc.querySelector('.annotationLayer')
    div.replaceChildren()
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        // pdf.js AnnotationLayer calls getAnchorUrl for named-action / GoTo link
        // annotations; without it the render rejects with "getAnchorUrl is not a
        // function" (READEST-2M). Match pdf.js SimpleLinkService, which returns ''.
        getAnchorUrl: () => '',
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport: displayViewport, div, linkService }).render({
        annotations: await page.getAnnotations(),
    })
    return generation
}

const renderPage = async (page, getImageBlob, ocr = null, prepareOCR, labels) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(blob => {
            // Release canvas bitmap memory after extracting the blob
            canvas.width = 0
            canvas.height = 0
            resolve(blob)
        }))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.css
    if (textLayerBuilderCSS == null) {
        textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/annotation_layer_builder.css
    if (annotationLayerBuilderCSS == null) {
        annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))
    }
    const data = `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `
    const src = URL.createObjectURL(new Blob([data], { type: 'text/html' }))
    const onZoom = async ({ doc, scale, pageColors }) => {
        const generation = await render(page, doc, scale, pageColors, ocr)
        if (generation == null || renderGenerations.get(doc) !== generation) return
        const container = doc.querySelector('.textLayer')
        const publish = result => {
            const end = container.querySelector('.endOfContent')
            end?.remove()
            appendOCR(container, result, page.getViewport({ scale }))
            if (end) container.append(end)
            setupOCRSelection(container)
            doc.querySelector('[data-pdf-ocr-status]')?.remove()
            doc.dispatchEvent(new Event('pdf-text-ready'))
        }
        // Recognition may finish while render() is painting a new scale using
        // its earlier empty OCR snapshot. Publish the now-ready words too.
        if (ocr && !container?.textContent?.trim()) publish(ocr)
        if (!prepareOCR || ocr || container?.textContent?.trim()) {
            doc.querySelector('[data-pdf-ocr-status]')?.remove()
            return
        }
        const current = () => Boolean(doc.defaultView?.frameElement?.isConnected)
        if (!current()) return
        let status = doc.querySelector('[data-pdf-ocr-status]')
        if (!status) {
            status = doc.createElement('div')
            status.setAttribute('data-pdf-ocr-status', '')
            status.setAttribute('cfi-inert', '')
            status.setAttribute('role', 'status')
            status.style.cssText = 'position:fixed;top:8px;right:8px;padding:4px 8px;background:Canvas;color:CanvasText;font:12px sans-serif;pointer-events:none'
            doc.body.append(status)
        }
        status.textContent = labels?.loading ?? 'Recognizing page text…'
        // Paint first. Recognition neither delays the canvas nor page navigation.
        void prepareOCR(current).then(result => {
            if (result) ocr = result
            if (!current() || renderGenerations.get(doc) !== generation) return
            if (!result) throw new Error('pdf_recognition_failed')
            // Keep the same direct-child order as an OCR page loaded from
            // disk; otherwise a new highlight would have a different CFI on reopen.
            publish(result)
        }).catch(() => {
            if (current() && renderGenerations.get(doc) === generation)
                status.textContent = labels?.failed ?? 'Page text could not be recognized.'
        })
    }
    return { src, data, onZoom }
}

const resolveDestination = async (value, pdf) => {
    try {
        const dest = typeof value === 'string' ? await pdf.getDestination(value) : value
        if (!Array.isArray(dest) || dest[0] == null) return
        // Explicit destinations can carry a zero-based page number, including 0.
        const index = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0])
        if (Number.isInteger(index) && index >= 0 && index < pdf.numPages)
            return { index, dest }
    } catch { /* Invalid links must not break the reading session. */ }
}

const makeTOCItem = async (item, resolve, destinations) => {
    const target = await resolve(item.dest)
    const href = target ? JSON.stringify(item.dest) : ''
    if (href) destinations.set(href, target)
    return {
        label: item.title,
        href,
        index: target?.index,
        cfi: target ? CFI.fake.fromIndex(target.index) : undefined,
        subitems: item.items?.length
            ? await Promise.all(item.items.map(i => makeTOCItem(i, resolve, destinations)))
            : null,
    }
}

const destinationAnchor = (page, dest) => {
    const viewport = page.getViewport({ scale: 1 })
    const mode = dest[1]?.name
    const left = mode === 'XYZ' || mode === 'FitR' || mode === 'FitV' || mode === 'FitBV'
        ? dest[2] : null
    const top = mode === 'XYZ' ? dest[3] : mode === 'FitR' ? dest[5]
        : mode === 'FitH' || mode === 'FitBH' ? dest[2] : null
    if (!Number.isFinite(top) && !Number.isFinite(left)) return
    const [x, y] = viewport.convertToViewportPoint(left ?? 0, top ?? viewport.viewBox[3])
    return doc => {
        const layer = doc.querySelector('.textLayer')
        const scale = parseFloat(doc.documentElement.style.getPropertyValue('--total-scale-factor')) || 1
        let closest, distance = Infinity
        for (const span of layer?.querySelectorAll('span') ?? []) {
            if (!span.textContent) continue
            const rect = span.getBoundingClientRect()
            const d = Math.abs(rect.top - y * scale) + Math.abs(rect.left - x * scale) * 0.1
            if (d < distance) { closest = span; distance = d }
        }
        if (!closest) return Math.max(0, Math.min(1, y / viewport.height))
        const range = doc.createRange()
        range.selectNodeContents(closest)
        return range
    }
}

// Cache of decoded pdf.js page objects and their rendered HTML blobs. These are
// cheap (page metadata + a small blob URL, not the large canvas bitmap, which
// lives in the visible iframe) so this can comfortably exceed the live-canvas
// cap in fixed-layout's scroll mode, sparing a re-parse when the reader scrolls
// back over a recently seen page.
const MAX_CACHED_PAGES = 16

const CALIBRE_NS = 'http://calibre-ebook.com/xmp-namespace'
const CALIBRE_SI_NS = 'http://calibre-ebook.com/xmp-namespace-series-index'
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

// Calibre writes series metadata into the XMP packet as
// <calibre:series rdf:parseType="Resource">
//   <rdf:value>Name</rdf:value>
//   <calibreSI:series_index>1.00</calibreSI:series_index>
// </calibre:series>
const parseCalibreSeriesFromXMP = raw => {
    if (!raw || typeof raw !== 'string') return null
    let doc
    try {
        doc = new DOMParser().parseFromString(raw, 'application/xml')
    } catch {
        return null
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    const seriesEls = doc.getElementsByTagNameNS(CALIBRE_NS, 'series')
    const seriesEl = seriesEls.item(0)
    if (!seriesEl) return null
    const valueEl = seriesEl.getElementsByTagNameNS(RDF_NS, 'value').item(0)
    const name = valueEl?.textContent?.trim()
    if (!name) return null
    const indexEl = seriesEl.getElementsByTagNameNS(CALIBRE_SI_NS, 'series_index').item(0)
    const position = indexEl?.textContent?.trim()
    return position ? { name, position } : { name }
}

// Maximum number of range reads to keep in flight at once. While parsing a
// large PDF's cross-reference and object streams, pdf.js can request hundreds
// of byte ranges in a single burst. A real HTTP transport is implicitly
// throttled by the browser's per-host connection limit (~6); the custom file
// schemes readest serves these reads through (Android's `rangefile` /
// `shouldInterceptRequest`, iOS' native file bridge) have no such limit, so
// firing every request at once floods the native handler and exhausts the
// WebView's heap, crashing on 50 MB+ PDFs (readest #3470). Throttle here.
const MAX_CONCURRENT_RANGES = 6

export const makePDF = async (file, { loadOCR, recognizeOCR, disposeOCR, ocrLabels } = {}) => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    // Bound the concurrent range reads instead of dispatching them all at once.
    let active = 0
    let stopped = false
    let loadingTask
    let rangeError
    const pendingReads = new Set()
    const withRanges = promise => {
        if (rangeError) {
            Promise.resolve(promise).catch(() => {})
            return Promise.reject(rangeError)
        }
        return new Promise((resolve, reject) => {
            pendingReads.add(reject)
            Promise.resolve(promise).then(resolve, reject)
                .finally(() => pendingReads.delete(reject))
        })
    }
    const queue = []
    const stop = () => { stopped = true; queue.length = 0 }
    const fail = error => {
        if (stopped) return
        stop()
        const message = error instanceof Error ? error.message : ''
        rangeError = new Error(/^pdf_range_(?:truncated|mismatch|read_failed)$/.test(message)
            ? message : 'pdf_range_read_failed')
        for (const reject of pendingReads) reject(rangeError)
        pendingReads.clear()
        Promise.resolve().then(() => loadingTask?.destroy?.()).catch(() => {})
    }
    const pump = () => {
        while (!stopped && active < MAX_CONCURRENT_RANGES && queue.length) {
            const [begin, end] = queue.shift()
            active++
            Promise.resolve().then(() => file.slice(begin, end).arrayBuffer())
                .then(chunk => {
                    if (stopped) return
                    if (chunk.byteLength !== end - begin)
                        throw new Error(chunk.byteLength < end - begin
                            ? 'pdf_range_truncated' : 'pdf_range_mismatch')
                    transport.onDataRange(begin, chunk)
                })
                .catch(fail)
                .finally(() => { active--; pump() })
        }
    }
    transport.abort = stop
    transport.requestDataRange = (begin, end) => {
        if (stopped) return
        queue.push([begin, end])
        pump()
    }
    loadingTask = pdfjsLib.getDocument({
        range: transport,
        wasmUrl: pdfjsPath(''),
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    })
    const pdf = await withRanges(loadingTask.promise)

    // Get viewport dimensions from first page for fixed-layout rendering
    const firstPage = await withRanges(pdf.getPage(1))
    const firstViewport = firstPage.getViewport({ scale: 1 })
    const book = { rendition: {
        layout: 'pre-paginated',
        viewport: { width: firstViewport.width, height: firstViewport.height },
    } }

    const { metadata, info } = await withRanges(pdf.getMetadata()) ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const calibreSeries = parseCalibreSeriesFromXMP(metadata?.getRaw?.())
    if (calibreSeries) book.metadata.belongsTo = { series: calibreSeries }

    const destinations = new Map()
    const resolve = value => resolveDestination(value, pdf)
    const outline = await withRanges(pdf.getOutline())
    book.toc = outline?.length
        ? await Promise.all(outline.map(item => makeTOCItem(item, resolve, destinations))) : []
    const labels = await withRanges(pdf.getPageLabels?.())
    book.pageList = Array.from({ length: pdf.numPages }, (_, index) => {
        const dest = [index, { name: 'Fit' }]
        const href = JSON.stringify(dest)
        destinations.set(href, { index, dest })
        return { id: index, label: labels?.[index] ?? String(index + 1),
            href, index, cfi: CFI.fake.fromIndex(index) }
    })
    // Without an embedded outline, expose honest page navigation in the TOC.
    if (!book.toc.length) book.toc = book.pageList.map(item => ({ ...item }))
    let tocID = 0
    const assignID = items => {
        for (const item of items) {
            item.id = tocID++
            if (item.subitems) assignID(item.subitems)
        }
    }
    assignID(book.toc)

    const cache = new Map()
    const pageCache = new Map()
    const getPage = async (i) => {
        const cached = pageCache.get(i)
        if (cached) {
            // Move to end for LRU ordering
            pageCache.delete(i)
            pageCache.set(i, cached)
            return cached
        }
        const page = await withRanges(pdf.getPage(i + 1))
        pageCache.set(i, page)

        // Evict oldest pages when over limit, freeing internal page data
        while (pageCache.size > MAX_CACHED_PAGES) {
            const oldestKey = pageCache.keys().next().value
            const oldPage = pageCache.get(oldestKey)
            pageCache.delete(oldestKey)
            oldPage?.cleanup()
        }

        return page
    }
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) {
                // Move to end for LRU ordering
                cache.delete(i)
                cache.set(i, cached)
                return cached
            }
            const url = await renderPage(await getPage(i), false, await loadOCR?.(i),
                recognizeOCR && (current => recognizeOCR(i, current)), ocrLabels)
            cache.set(i, url)

            // Evict oldest render results when over limit
            while (cache.size > MAX_CACHED_PAGES) {
                const oldestKey = cache.keys().next().value
                const oldEntry = cache.get(oldestKey)
                cache.delete(oldestKey)
                if (oldEntry?.src) URL.revokeObjectURL(oldEntry.src)
            }

            return url
        },
        createDocument: async () => {
            const page = await getPage(i)
            const doc = document.implementation.createHTMLDocument('')

            const canvas = doc.createElement('div')
            canvas.id = 'canvas'
            doc.body.appendChild(canvas)

            const textLayer = doc.createElement('div')
            textLayer.className = 'textLayer'
            doc.body.appendChild(textLayer)

            const annotationLayer = doc.createElement('div')
            annotationLayer.className = 'annotationLayer'
            doc.body.appendChild(annotationLayer)

            // TextLayer requires canvas 2d context for font metrics;
            // fall back to manual span construction when unavailable
            const probe = doc.createElement('canvas')
            if (probe.getContext?.('2d')) {
                const textLayerInstance = new pdfjsLib.TextLayer({
                    textContentSource: await page.streamTextContent(),
                    container: textLayer, viewport: page.getViewport({ scale: 1 }),
                })
                await textLayerInstance.render()
            } else {
                const content = await readTextContent(page)
                for (const item of content.items) {
                    if (item.str) {
                        const span = doc.createElement('span')
                        span.textContent = item.str
                        textLayer.appendChild(span)
                    }
                }
            }
            appendOCR(textLayer, await loadOCR?.(i), page.getViewport({ scale: 1 }))
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    // Separate bounded bitmap work from the reader's text layers and CFI cache.
    book.getPDFImage = async (index, width = 180, region) => {
        if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages
            || !Number.isFinite(width) || width < 1 || width > 3200)
            throw new Error('invalid_pdf_image')
        const r = region ?? { x: 0, y: 0, width: 1, height: 1 }
        if (![r.x, r.y, r.width, r.height].every(Number.isFinite)
            || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0
            || r.x + r.width > 1.001 || r.y + r.height > 1.001)
            throw new Error('invalid_pdf_region')
        const page = await getPage(index)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(width / (base.width * r.width),
            Math.sqrt(4_000_000 / (base.width * base.height * r.width * r.height)))
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width * r.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height * r.height))
        try {
            await page.render({ canvasContext: canvas.getContext('2d'), viewport,
                transform: [1, 0, 0, 1, -r.x * viewport.width, -r.y * viewport.height],
                background: '#ffffff' }).promise
            return await new Promise((resolve, reject) => canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error('pdf_image_failed')), 'image/png'))
        } finally { canvas.width = canvas.height = 0 }
    }
    book.getPDFText = async index => {
        const content = await withRanges(readTextContent(await getPage(index)))
        const native = content.items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('')
        return native.trim() ? native : ocrText(await loadOCR?.(index))
    }
    // Native internal links nominate destinations without OCR or guessed page
    // offsets. The caller still verifies every title on its destination page.
    book.getPDFContentsLinks = async index => {
        const page = await getPage(index)
        const annotations = (await page.getAnnotations()).filter(a => a.subtype === 'Link' && a.dest != null)
        if (!annotations.length || annotations.length > 128) return null
        const content = await withRanges(readTextContent(page))
        const entries = []
        for (const annotation of annotations) {
            const target = await resolve(annotation.dest)
            if (!target || target.index === index || !Array.isArray(annotation.rect)) return null
            const [left, bottom, right, top] = annotation.rect
            const items = content.items.filter(item => {
                if (!item.str?.trim() || !item.transform) return false
                const x = item.transform[4] + (item.width ?? 0) / 2
                const y = item.transform[5] + (item.height ?? Math.abs(item.transform[3])) / 2
                return x >= left - 1 && x <= right + 1 && y >= bottom - 1 && y <= top + 1
            }).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
            const title = items.map(item => item.str.trim()).join(' ').replace(/^[•●·\-]\s*/, '').trim()
            if (!title || title.length > 500) return null
            entries.push({ title, pageIndex: target.index, left, top })
        }
        entries.sort((a, b) => b.top - a.top || a.left - b.left)
        const indents = []
        for (const left of entries.map(entry => entry.left).sort((a, b) => a - b))
            if (!indents.some(indent => Math.abs(left - indent) < 8)) indents.push(left)
        if (indents.length > 6) return null
        return entries.map(entry => ({ title: entry.title, pageIndex: entry.pageIndex,
            level: indents.findIndex(indent => Math.abs(entry.left - indent) < 8) }))
    }
    const getContentsRows = async index => {
        const page = await getPage(index)
        const content = await withRanges(readTextContent(page))
        const viewport = page.getViewport({ scale: 1 })
        const rows = []
        for (const item of content.items) {
            if (!item.str?.trim() || !item.transform) continue
            const x = item.transform[4], y = item.transform[5]
            const height = Math.max(1, item.height ?? Math.abs(item.transform[3]))
            let row = rows.find(row => Math.abs(row.y - y) <= Math.min(row.height, height) * .5)
            if (!row) rows.push(row = { y, height, items: [] })
            row.items.push({ text: item.str, x, width: item.width, height })
        }
        const prepared = rows.sort((a, b) => b.y - a.y).map(row => {
            row.items.sort((a, b) => a.x - b.x)
            const text = row.items.map(item => item.text.trim()).join(' ').normalize('NFKC')
            const last = row.items.at(-1), previous = row.items.at(-2)
            const gap = previous && /^(?:\d{1,4}|[ivxlcdm]+)$/i.test(last.text.trim())
                && last.x - (previous.x + previous.width) >= Math.max(last.height, previous.height) * 1.5
            const boxes = row.items.map(item => viewport.convertToViewportRectangle(
                [item.x, row.y, item.x + item.width, row.y + item.height]))
            const left = Math.min(...boxes.map(box => Math.min(box[0], box[2])))
            const top = Math.min(...boxes.map(box => Math.min(box[1], box[3])))
            const right = Math.max(...boxes.map(box => Math.max(box[0], box[2])))
            const bottom = Math.max(...boxes.map(box => Math.max(box[1], box[3])))
            return { text, x: left / viewport.width, y: top / viewport.height,
                width: (right - left) / viewport.width, height: (bottom - top) / viewport.height,
                contents: gap || /[.·…_。•⋯∙●‧﹒]{2,}\s*(?:\d{1,4}|[ivxlcdm]+)\s*$/i.test(text) }
        })
        return prepared
    }
    book.getPDFContentsLayout = async index => (await getContentsRows(index))
        .map(({ text, x, y, width, height }) => ({ text, x, y, width, height }))
    book.getPDFContentsLines = async (index, allRows = false) => {
        const prepared = await getContentsRows(index)
        const sizes = prepared.filter(row => row.contents).map(row => row.height).sort((a,b) => a-b)
        const minimum = (sizes[Math.floor(sizes.length / 2)] ?? 0) * .8
        const tolerance = Math.max(.000001, minimum * .02)
        return prepared.filter(row => allRows ? row.contents || row.height + tolerance >= minimum : row.contents).map(row => row.text)
    }
    book.getPDFAnnotationRects = async cfi => {
        const parts = CFI.parse(cfi)
        const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
        const page = await getPage(index)
        const viewport = page.getViewport({ scale: 1 })
        const frame = document.createElement('iframe')
        frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${viewport.width}px;height:${viewport.height}px;visibility:hidden;border:0`
        const entry = await renderPage(page, false, await loadOCR?.(index))
        let timer
        try {
            await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('pdf_annotation_timeout')), 15000)
                frame.onload = resolve
                frame.onerror = () => reject(new Error('pdf_annotation_unresolved'))
                frame.srcdoc = entry.data
                document.body.append(frame)
            })
            await entry.onZoom({ doc: frame.contentDocument, scale: 1 })
            const range = CFI.toRange(frame.contentDocument, parts)
            const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
                .map(r => ({ x: Math.max(0, r.x / viewport.width), y: Math.max(0, r.y / viewport.height),
                    width: Math.min(r.width, viewport.width - r.x) / viewport.width,
                    height: Math.min(r.height, viewport.height - r.y) / viewport.height }))
            if (!rects.length) throw new Error('pdf_annotation_unresolved')
            return { index, rects }
        } finally { clearTimeout(timer); frame.remove(); URL.revokeObjectURL(entry.src) }
    }
    book.resolveHref = async href => {
        let target = destinations.get(href)
        if (!target) {
            try { target = await resolve(JSON.parse(href)) }
            catch { return }
        }
        if (!target) return
        const { index, dest } = target
        const page = await getPage(index)
        return { index, anchor: destinationAnchor(page, dest) }
    }
    book.splitTOCHref = href => [destinations.get(href)?.index ?? null, null]
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        stop()
        disposeOCR?.()
        // Clean up all cached canvases and revoke blob URLs
        for (const [, entry] of cache) {
            if (entry?.src) URL.revokeObjectURL(entry.src)
        }
        cache.clear()
        for (const [, page] of pageCache) {
            page?.cleanup()
        }
        pageCache.clear()
        pdf.destroy()
    }
    return book
}
