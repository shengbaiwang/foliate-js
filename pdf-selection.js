// Keep the browser Selection/Range as the public selection. Only mouse endpoint
// hit testing on the OCR projection is geometric: Chromium can place a caret at
// the opposite end of a transformed word in a clipped/scrolled PDF iframe.
// Touch handles, native PDF text, keyboard extension and persisted CFIs retain
// their normal paths.
const controllers = new WeakMap()
const hitTests = new WeakMap()
const crossPageDocuments = new WeakSet()

export const setCrossPageSelection = (doc, active) => {
    if (active) crossPageDocuments.add(doc)
    else crossPageDocuments.delete(doc)
}

export const getPDFSelectionCaret = (doc, x, y) => {
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
    const reading = container.querySelector('[data-pdf-ocr-text]')
    if (!reading || !doc.defaultView) return
    const controller = new AbortController()
    controllers.set(doc, controller)
    const options = { signal: controller.signal }
    let drag = null

    const targetSpan = event => event.target?.closest?.('span')
    const supported = span => {
        if (!span || !reading.contains(span)) return false
        // The reader intentionally disables selection during instant annotation.
        const style = doc.defaultView.getComputedStyle(span)
        return style.userSelect !== 'none' && style.webkitUserSelect !== 'none'
    }
    const snapshot = () => Array.from(reading.querySelectorAll('span'), span =>
        ({ span, box: span.getBoundingClientRect() }))
    const caret = (items, x, y, cache) => {
        if (!items.length) return null
        const distance = box => Math.hypot(Math.max(box.top - y, 0, y - box.bottom),
            Math.max(box.left - x, 0, x - box.right))
        const item = items.reduce((best, item) =>
            !best || distance(item.box) < distance(best.box) ? item : best, null)
        if (!item || !supported(item.span)) return null
        const node = item.span.firstChild
        if (!node) return null
        let points = cache.get(node)
        if (!points) {
            points = []
            const range = doc.createRange()
            const vertical = doc.defaultView.getComputedStyle(item.span).writingMode.startsWith('vertical')
            let rtl = doc.defaultView.getComputedStyle(item.span).direction === 'rtl'
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
    hitTests.set(doc, (x, y) => caret(snapshot(), x, y, new Map()))
    const update = event => {
        if (!drag || crossPageDocuments.has(doc)) return
        const end = caret(drag.items, event.clientX, event.clientY, drag.cache)
        if (end) doc.getSelection()?.setBaseAndExtent(
            drag.start.node, drag.start.offset, end.node, end.offset)
    }
    const stop = () => {
        if (drag && reading.hasPointerCapture(drag.id)) reading.releasePointerCapture(drag.id)
        drag = null
    }
    reading.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse'
            || event.altKey || event.ctrlKey || event.metaKey || !supported(targetSpan(event))) return
        const items = snapshot(), cache = new Map()
        let start = caret(items, event.clientX, event.clientY, cache)
        const selection = doc.getSelection()
        if (event.shiftKey && reading.contains(selection?.anchorNode))
            start = { node: selection.anchorNode, offset: selection.anchorOffset }
        if (!start) return
        event.preventDefault()
        doc.defaultView.focus()
        drag = { start, items, cache, id: event.pointerId }
        reading.setPointerCapture(event.pointerId)
        update(event)
    }, options)
    reading.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return
        event.preventDefault()
        update(event)
    }, options)
    reading.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.id) return
        event.preventDefault()
        update(event)
        stop()
    }, options)
    reading.addEventListener('pointercancel', stop, options)
    reading.addEventListener('lostpointercapture', () => { drag = null }, options)
    doc.defaultView.addEventListener('blur', stop, options)
    doc.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) {
            stop()
            doc.getSelection()?.removeAllRanges()
        }
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
