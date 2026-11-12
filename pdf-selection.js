// Keep browser Selection/Range and persisted CFIs as the public selection.
// Mouse endpoints use visible glyph geometry: native caret hit testing can jump
// to a whole line/paragraph between the absolutely positioned PDF text spans.
// Touch handles and keyboard extension retain their native paths.
const controllers = new WeakMap()
const hitTests = new WeakMap()
const crossPageDocuments = new WeakSet()

export const setCrossPageSelection = (doc, active) => {
    if (active) crossPageDocuments.add(doc)
    else crossPageDocuments.delete(doc)
    doc.documentElement?.toggleAttribute('data-pdf-coordinated-selection', active)
}

export const getPDFSelectionCaret = (doc, x, y) => {
    if (!doc.defaultView) return null
    const hit = hitTests.get(doc)?.(x, y)
    if (hit) return hit
    const position = doc.caretPositionFromPoint?.(x, y)
    const range = position ? null : doc.caretRangeFromPoint?.(x, y)
    const node = position?.offsetNode ?? range?.startContainer
    const offset = position?.offset ?? range?.startOffset
    if (node?.nodeType !== 3 || !node.parentElement?.closest('.textLayer')) return null
    return { node, offset }
}

export const setupOCRSelection = container => {
    const doc = container.ownerDocument
    controllers.get(doc)?.abort()
    hitTests.delete(doc)
    const reading = container.querySelector('[data-pdf-ocr-text]') ?? container
    // A retiring iframe loses doc.defaultView before a late render can abort
    // its previous handlers. Keep the original window for safe cancellation.
    const win = doc.defaultView
    if (!win) return
    const controller = new win.AbortController()
    controllers.set(doc, controller)
    const options = { signal: controller.signal }
    let drag = null
    let animation = null
    let pending = null
    let hitSnapshot = null
    let hitAnimation = null

    const targetSpan = event => event.target?.closest?.('span')
    const supported = span => {
        if (!doc.defaultView || !span || !reading.contains(span)) return false
        // The reader intentionally disables selection during instant annotation.
        const style = win.getComputedStyle(span)
        return style.userSelect !== 'none' && style.webkitUserSelect !== 'none'
    }
    const snapshot = () => Array.from(reading.querySelectorAll('span'))
        .filter(span => span.firstChild?.nodeType === 3 && span.textContent.length
            && !span.hasAttribute('data-pdf-legacy'))
        .map(span => ({
            span, box: span.getBoundingClientRect(),
            vertical: win.getComputedStyle(span).writingMode.startsWith('vertical'),
        }))
    const caret = (items, x, y, cache) => {
        if (!items.length) return null
        // Keep the endpoint on the line under the pointer in its trailing
        // whitespace, even when the next line has a much longer text span.
        let item = null
        let bestAcross = Infinity, bestAlong = Infinity
        for (const candidate of items) {
            const { box, vertical } = candidate
            const dx = Math.max(box.left - x, 0, x - box.right)
            const dy = Math.max(box.top - y, 0, y - box.bottom)
            const [across, along] = vertical ? [dx, dy] : [dy, dx]
            if (across < bestAcross || (across === bestAcross && along < bestAlong)) {
                item = candidate
                bestAcross = across
                bestAlong = along
            }
        }
        if (!item || !supported(item.span)) return null
        const node = item.span.firstChild
        if (!node) return null
        let points = cache.get(node)
        if (!points) {
            points = []
            const range = doc.createRange()
            const { vertical } = item
            let rtl = win.getComputedStyle(item.span).direction === 'rtl'
            // Grapheme boundaries prevent splitting surrogate pairs or accents.
            for (const { index, segment } of new Intl.Segmenter(undefined,
                { granularity: 'grapheme' }).segment(node.textContent)) {
                range.setStart(node, index)
                range.setEnd(node, index + segment.length)
                const box = range.getBoundingClientRect()
                if (/[\u0590-\u08ff]/u.test(segment)) rtl = true
                else if (/[\p{L}\p{N}]/u.test(segment)) rtl = false
                const start = vertical ? box.top : rtl ? box.right : box.left
                const end = vertical ? box.bottom : rtl ? box.left : box.right
                points.push({ offset: index, position: start, vertical },
                    { offset: index + segment.length, position: end, vertical })
            }
            cache.set(node, points)
        }
        if (!points.length) return null
        const nearest = points.reduce((best, point) =>
            Math.abs(point.position - (point.vertical ? y : x))
                < Math.abs(best.position - (best.vertical ? y : x)) ? point : best)
        return { node, offset: nearest.offset }
    }
    hitTests.set(doc, (x, y) => {
        // Cross-page coordination also asks for an endpoint while the mouse is
        // moving. Reuse this gesture's measured page instead of laying out all
        // text spans again for every pointer event.
        if (drag) return caret(drag.items, x, y, drag.cache)
        if (!hitSnapshot) {
            hitSnapshot = { items: snapshot(), cache: new Map() }
            hitAnimation = win.requestAnimationFrame(() => { hitSnapshot = null })
        }
        return caret(hitSnapshot.items, x, y, hitSnapshot.cache)
    })
    const update = event => {
        if (!drag || crossPageDocuments.has(doc)) return
        const end = caret(drag.items, event.clientX, event.clientY, drag.cache)
        if (end) {
            const selection = doc.getSelection()
            if (selection?.anchorNode === drag.start.node && selection.anchorOffset === drag.start.offset
                && selection.focusNode === end.node && selection.focusOffset === end.offset) return
            selection?.setBaseAndExtent(drag.start.node, drag.start.offset, end.node, end.offset)
        }
    }
    const cancelUpdate = () => {
        if (animation != null) win.cancelAnimationFrame(animation)
        animation = null
        pending = null
    }
    const stop = () => {
        cancelUpdate()
        if (drag && reading.hasPointerCapture(drag.id)) reading.releasePointerCapture(drag.id)
        drag = null
    }
    reading.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse'
            || event.altKey || event.ctrlKey || event.metaKey || !supported(targetSpan(event))) return
        const { items, cache } = hitSnapshot ?? { items: snapshot(), cache: new Map() }
        let start = caret(items, event.clientX, event.clientY, cache)
        const selection = doc.getSelection()
        if (event.shiftKey && reading.contains(selection?.anchorNode))
            start = { node: selection.anchorNode, offset: selection.anchorOffset }
        if (!start) return
        event.preventDefault()
        win.focus()
        drag = { start, items, cache, id: event.pointerId }
        reading.setPointerCapture(event.pointerId)
        update(event)
    }, options)
    reading.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return
        event.preventDefault()
        pending = { clientX: event.clientX, clientY: event.clientY }
        if (animation != null) return
        animation = win.requestAnimationFrame(() => {
            animation = null
            const point = pending
            pending = null
            if (point) update(point)
        })
    }, options)
    reading.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.id) return
        event.preventDefault()
        cancelUpdate()
        update(event)
        stop()
    }, options)
    reading.addEventListener('pointercancel', stop, options)
    reading.addEventListener('lostpointercapture', () => { cancelUpdate(); drag = null }, options)
    controller.signal.addEventListener('abort', () => {
        stop()
        if (hitAnimation != null) win.cancelAnimationFrame(hitAnimation)
    }, { once: true })
    win.addEventListener('blur', stop, options)
    doc.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) {
            stop()
            doc.getSelection()?.removeAllRanges()
        }
    }, options)
    if (reading === container) reading.addEventListener('click', event => {
        // A deliberate third click retains the browser's paragraph selection;
        // ordinary press-drag gestures continue to use exact glyph endpoints.
        if (event.detail !== 3 || event.button !== 0 || event.altKey
            || event.ctrlKey || event.metaKey || event.shiftKey) return
        const point = caret(snapshot(), event.clientX, event.clientY, new Map())
        if (!point) return
        const box = point.node.parentElement.getBoundingClientRect()
        if (event.clientX < box.left || event.clientX > box.right
            || event.clientY < box.top || event.clientY > box.bottom) return
        event.preventDefault()
        const selection = doc.getSelection()
        selection.collapse(point.node, point.offset)
        selection.modify('move', 'backward', 'paragraphboundary')
        selection.modify('extend', 'forward', 'paragraphboundary')
    }, options)
    reading.addEventListener('dblclick', event => {
        // Pointer capture can retarget the compatibility dblclick to `reading`.
        const point = caret(snapshot(), event.clientX, event.clientY, new Map())
        if (!point) return
        const box = point.node.parentElement.getBoundingClientRect()
        if (event.clientX < box.left || event.clientX > box.right
            || event.clientY < box.top || event.clientY > box.bottom) return
        const value = point.node.textContent
        const segments = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(value)]
        const segment = segments.find(s => point.offset >= s.index
            && point.offset < s.index + s.segment.length) ?? segments.at(-1)
        if (!segment) return
        event.preventDefault()
        doc.getSelection()?.setBaseAndExtent(point.node, segment.index,
            point.node, segment.index + segment.segment.length)
    }, options)
}
