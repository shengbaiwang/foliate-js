import { Overlayer } from './overlayer.js'
import { getPDFSelectionCaret, setCrossPageSelection } from './pdf-selection.js'

const editable = element => element?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
const textNodes = doc => {
    const root = doc.querySelector('[data-pdf-ocr-text]') ?? doc.querySelector('.textLayer')
    if (!root) return []
    const walker = doc.createTreeWalker(root, 4)
    const nodes = []
    for (let node; (node = walker.nextNode());) if (node.textContent.length) nodes.push(node)
    return nodes
}
const pointFromSelection = (doc, index, selection, side) => {
    const node = selection?.[`${side}Node`], offset = selection?.[`${side}Offset`]
    return node?.nodeType === 3 && textNodes(doc).includes(node) ? { doc, index, node, offset } : null
}

// Keep the page documents and their existing CFIs. A cross-page selection is
// an ordered set of real Ranges, never a Range spanning unrelated documents.
export class PDFCrossPageSelection {
    #view
    #controller = new AbortController()
    #documents = new WeakSet()
    #drag = null
    #ranges = null
    #anchor = null
    #focus = null
    #revision = 0
    #keyBusy = false
    #previews = []
    #animation = null
    #layoutObserver = new MutationObserver(() => this.clear({ native: true }))
    #sizeObserver = new ResizeObserver(() => this.clear({ native: true }))
    constructor(view) {
        this.#view = view
        this.#listen(view.ownerDocument)
        this.#layoutObserver.observe(view.renderer, {
            attributes: true,
            attributeFilter: ['zoom', 'scale-factor', 'spread', 'flow', 'scroll-direction'],
        })
        this.#sizeObserver.observe(view.renderer)
    }
    #listen(doc) {
        const options = { capture: true, signal: this.#controller.signal }
        doc.addEventListener('copy', event => {
            if (!this.#ranges?.length || !event.clipboardData) return
            if (editable(event.target) || editable(doc.activeElement)) return
            const selected = doc.getSelection()
            if (doc === this.#view.ownerDocument && !selected?.isCollapsed
                && !this.#view.contains(selected?.anchorNode)) return
            event.clipboardData.setData('text/plain', this.#ranges.map(x => x.range.toString()).join('\n'))
            event.preventDefault()
        }, options)
        doc.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.clear({ native: true })
            else this.#keyDown(event, doc)
        }, options)
    }
    #keyDown(event, doc) {
        if (event.isComposing || editable(event.target) || editable(doc.activeElement)
            || event.target?.closest?.('button, [role="button"], [role="menuitem"]')) return
        const directions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'backward', ArrowDown: 'forward', Home: 'backward', End: 'forward' }
        const direction = directions[event.key]
        if (!direction || (!event.shiftKey && (!this.#ranges || event.altKey || event.metaKey || event.ctrlKey))) return
        const contents = this.#view.renderer.getContents()
        const source = contents.find(item => item.doc === doc && item.doc.getSelection()?.rangeCount)
            ?? contents.find(item => !item.doc.getSelection()?.isCollapsed)
        if (!this.#anchor || !this.#focus) {
            if (!source) return
            const selection = source.doc.getSelection()
            this.#anchor = pointFromSelection(source.doc, source.index, selection, 'anchor')
            this.#focus = pointFromSelection(source.doc, source.index, selection, 'focus')
        }
        if (!this.#anchor || !this.#focus || !this.#focus.doc.getSelection()?.modify) return
        // A selection made in the surrounding app belongs to that surface.
        const selection = doc.getSelection()
        if (doc === this.#view.ownerDocument && !selection?.isCollapsed
            && !this.#view.contains(selection?.anchorNode)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        if (this.#keyBusy) return
        const revision = this.#revision
        this.#keyBusy = true
        const boundary = event.key === 'Home' || event.key === 'End'
        const granularity = boundary ? (event.ctrlKey || event.metaKey ? 'documentboundary' : 'lineboundary')
            : event.metaKey ? (event.key === 'ArrowUp' || event.key === 'ArrowDown' ? 'documentboundary' : 'lineboundary')
                : event.key === 'ArrowUp' || event.key === 'ArrowDown' ? 'line'
                    : event.ctrlKey || event.altKey ? 'word' : 'character'
        this.#extendKey(direction, granularity, event.shiftKey, revision)
            .catch(() => { /* Keep the last complete selection if a page cannot load. */ })
            .finally(() => { if (revision === this.#revision) this.#keyBusy = false })
    }
    async #extendKey(direction, granularity, extend, revision, preview = false) {
        let anchor = this.#anchor
        const focus = this.#focus
        const backward = direction === 'left' || direction === 'backward'
        if (!extend) {
            const first = this.#ranges[0], last = this.#ranges.at(-1)
            const fragment = backward ? first : last
            const range = fragment.range.cloneRange()
            range.collapse(backward)
            this.clear()
            range.startContainer.ownerDocument.getSelection()?.addRange(range)
            range.startContainer.ownerDocument.defaultView?.focus()
            return
        }
        const selection = focus.doc.getSelection()
        const local = anchor.doc === focus.doc ? anchor
            : { node: focus.index < anchor.index ? textNodes(focus.doc).at(-1) : textNodes(focus.doc)[0] }
        if (local.offset == null) local.offset = focus.index < anchor.index ? local.node.textContent.length : 0
        selection.setBaseAndExtent(local.node, local.offset, focus.node, focus.offset)
        selection.modify('extend', direction, granularity)
        let end = pointFromSelection(focus.doc, focus.index, selection, 'focus')
        if (!end || (end.node === focus.node && end.offset === focus.offset)) {
            // The browser cannot extend a Range into another iframe. Step into
            // the next text page, keeping the original anchor and page CFIs.
            const step = backward ? -1 : 1
            for (let index = focus.index + step; index >= 0 && index < this.#view.book.sections.length; index += step) {
                if (Math.abs(index - anchor.index) >= 24) {
                    this.#view.dispatchEvent(new Event('pdf-selection-limit'))
                    break
                }
                let doc = this.#view.renderer.getContents().find(item => item.index === index)?.doc
                if (!doc) {
                    this.#view.renderer.setSelectionPages?.(Array.from({ length: Math.abs(index - anchor.index) + 1 }, (_, i) => Math.min(index, anchor.index) + i))
                    await this.#view.renderer.loadSelectionPage(index)
                    if (revision !== this.#revision) return
                    doc = this.#view.renderer.getContents().find(item => item.index === index)?.doc
                }
                if (!doc || doc.querySelector('[data-pdf-ocr-status]')) break
                const nodes = textNodes(doc)
                if (!nodes.length) continue
                const node = backward ? nodes.at(-1) : nodes[0]
                let boundary = { doc, index, node, offset: backward ? node.textContent.length : 0 }
                if (!this.#view.renderer.scrolled) {
                    // Hidden iframe selections cannot reliably move a caret.
                    // Show the page first, then resolve both endpoints against
                    // its final text layer before asking the browser to extend.
                    const anchorCFI = this.#savePoint(anchor), boundaryCFI = this.#savePoint(boundary)
                    await this.#view.renderer.goTo({ index })
                    if (revision !== this.#revision) return
                    anchor = this.#restorePoint(anchorCFI)
                    boundary = this.#restorePoint(boundaryCFI)
                }
                selection.removeAllRanges()
                const next = boundary.doc.getSelection()
                next.setBaseAndExtent(boundary.node, boundary.offset, boundary.node, boundary.offset)
                next.modify('extend', direction, granularity)
                end = pointFromSelection(boundary.doc, index, next, 'focus') ?? boundary
                break
            }
        }
        if (revision !== this.#revision) return
        if (end && this.#selectBetween(anchor, end)) {
            if (!preview) end.doc.defaultView?.focus()
            this.#reveal(end)
            this.#view.dispatchEvent(new CustomEvent(preview ? 'pdf-selection-preview' : 'pdf-selection', { detail: this.#ranges }))
        } else this.#selectBetween(anchor, focus)
    }
    #reveal(point) {
        const range = point.doc.createRange()
        const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(point.node.textContent)]
        const segment = segments.find(item => item.index >= point.offset) ?? segments.at(-1)
        if (!segment) return
        range.setStart(point.node, segment.index)
        range.setEnd(point.node, segment.index + segment.segment.length)
        const box = range.getBoundingClientRect()
        const frame = point.doc.defaultView.frameElement.getBoundingClientRect()
        const host = this.#view.renderer.getBoundingClientRect()
        const dx = frame.left + box.left < host.left + 16 ? frame.left + box.left - host.left - 16
            : frame.left + box.right > host.right - 16 ? frame.left + box.right - host.right + 16 : 0
        const dy = frame.top + box.top < host.top + 16 ? frame.top + box.top - host.top - 16
            : frame.top + box.bottom > host.bottom - 16 ? frame.top + box.bottom - host.bottom + 16 : 0
        if (dx || dy) this.#view.renderer.scrollBy({ left: dx, top: dy, behavior: 'auto' })
    }
    #savePoint(point) {
        const range = point.doc.createRange()
        range.setStart(point.node, point.offset)
        range.collapse(true)
        return this.#view.getCFI(point.index, range)
    }
    #restorePoint(cfi) {
        const { index, anchor } = this.#view.resolveCFI(cfi)
        const doc = this.#view.renderer.getContents().find(item => item.index === index)?.doc
        const range = anchor(doc)
        return { doc, index, node: range.startContainer, offset: range.startOffset }
    }
    attach(doc, index) {
        if (this.#documents.has(doc)) return
        this.#documents.add(doc)
        this.#listen(doc)
        const options = { capture: true, signal: this.#controller.signal }
        doc.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary
                || event.ctrlKey || event.metaKey || event.altKey) return
            const target = event.target?.closest?.('[data-pdf-ocr-text], .textLayer')
            if (!target) { this.clear(); return }
            const style = doc.defaultView.getComputedStyle(event.target)
            if (style.userSelect === 'none' || style.webkitUserSelect === 'none') return
            const start = getPDFSelectionCaret(doc, event.clientX, event.clientY)
            if (!start) return
            const selected = event.shiftKey && this.#view.renderer.getContents()
                .find(item => !item.doc.getSelection()?.isCollapsed)
            const anchor = event.shiftKey ? this.#anchor
                ?? pointFromSelection(selected?.doc ?? doc, selected?.index ?? index,
                    (selected?.doc ?? doc).getSelection(), 'anchor') : null
            if (anchor) {
                // Preserve the complete range until a new endpoint is valid.
                // The OCR and native handlers must not reset its logical anchor.
                this.#revision++
                this.#keyBusy = false
                this.#stopDrag()
                event.preventDefault()
                event.stopImmediatePropagation()
                if (Math.abs(index - anchor.index) >= 24) {
                    this.#view.dispatchEvent(new Event('pdf-selection-limit'))
                    return
                }
                // Move focus before starting a drag: the previous iframe's
                // blur must not cancel this deliberate Shift-click transfer.
                doc.defaultView.focus()
            } else this.clear()
            this.#drag = { doc, index, start, anchor, id: event.pointerId, target, crossed: !!anchor, captured: !!anchor }
            if (!anchor) this.#view.renderer.setSelectionPages?.([index])
            this.#rememberPoint(event)
            this.#drag.origin = { ...this.#drag.point }
            if (anchor) {
                target.setPointerCapture(event.pointerId)
                this.#updateAtPoint()
            }
            this.#animation = requestAnimationFrame(this.#scroll)
        }, options)
        doc.addEventListener('pointermove', event => {
            if (this.#drag?.doc !== doc || event.pointerId !== this.#drag.id) return
            this.#update(event)
        }, options)
        doc.addEventListener('pointerup', event => {
            if (this.#drag?.doc !== doc || event.pointerId !== this.#drag.id) return
            this.#update(event)
            const crossed = this.#drag.crossed && this.#ranges?.length
            this.#stopDrag()
            if (!crossed) this.clear()
            if (crossed && this.#ranges?.length)
                this.#view.dispatchEvent(new CustomEvent('pdf-selection', { detail: this.#ranges }))
        }, options)
        doc.addEventListener('pointercancel', () => this.clear(), options)
        doc.defaultView.addEventListener('blur', () => {
            // WebKit can blur an iframe while its captured pointer continues
            // outside it, and again when a page turn hides it. Capture, cancel
            // and pointerup own that gesture; focus alone must not discard it.
            const drag = this.#drag
            if (drag && !drag.captured && !drag.handle && !drag.turning) this.clear()
        }, options)
    }
    #rememberPoint(event) {
        const drag = this.#drag
        const source = drag?.doc.defaultView?.frameElement?.getBoundingClientRect()
        if (!source) return
        drag.point = { x: source.left + event.clientX, y: source.top + event.clientY }
    }
    #scroll = time => {
        const drag = this.#drag
        if (!drag) return
        const renderer = this.#view.renderer
        if (renderer.scrolled && drag.point) {
            const rect = renderer.getBoundingClientRect()
            const speed = (p, start, end) => p < start + 40
                ? -Math.min(1, (start + 40 - p) / 40)
                : p > end - 40 ? Math.min(1, (p - end + 40) / 40) : 0
            const step = Math.min(32, time - (drag.time ?? time)) * 0.9
            const travel = (p, origin, velocity) => Math.sign(p - origin) === Math.sign(velocity)
                && Math.abs(p - origin) > 8 ? velocity : 0
            const dx = travel(drag.point.x, drag.origin.x, speed(drag.point.x, rect.left, rect.right)) * step
            const dy = travel(drag.point.y, drag.origin.y, speed(drag.point.y, rect.top, rect.bottom)) * step
            if (dx || dy) {
                if (!drag.limited) renderer.scrollBy({ left: dx, top: dy, behavior: 'auto' })
                this.#updateAtPoint()
                if (drag.handle) this.#view.dispatchEvent(new Event('pdf-selection-preview'))
            }
            drag.time = time
        } else if (drag.point && !drag.turning) {
            const rect = renderer.getBoundingClientRect()
            const { x, y } = drag.point
            const dx = x - drag.origin.x, dy = y - drag.origin.y
            const forward = (x > rect.right - 28 && dx > 8) || (y > rect.bottom - 28 && dy > 8)
            const backward = (x < rect.left + 28 && dx < -8) || (y < rect.top + 28 && dy < -8)
            const direction = forward ? 1 : backward ? -1 : 0
            if (!direction || drag.blockPoint) drag.edge = null
            else if (drag.edge?.direction !== direction) drag.edge = { direction, time }
            else if (time - drag.edge.time >= 600) void this.#turnPaged(direction)
        }
        this.#animation = requestAnimationFrame(this.#scroll)
    }
    async #turnPaged(direction) {
        const drag = this.#drag
        const renderer = this.#view.renderer
        if (!drag || drag.turning) return
        const visible = renderer.getContents().filter(({ doc }) =>
            doc.defaultView?.frameElement?.parentElement?.style.visibility !== 'hidden')
        const indices = visible.map(item => item.index).filter(Number.isInteger)
        if (!indices.length) return
        const index = direction > 0 ? Math.max(...indices) + 1 : Math.min(...indices) - 1
        let anchor = drag.anchor ?? { ...drag.start, doc: drag.doc, index: drag.index }
        if (index < 0 || index >= this.#view.book.sections.length) return
        if (Math.abs(index - anchor.index) >= 24) {
            if (!drag.limited) this.#view.dispatchEvent(new Event('pdf-selection-limit'))
            drag.limited = true
            return
        }
        drag.turning = true
        const revision = this.#revision
        try {
            renderer.setSelectionPages(Array.from({ length: Math.abs(index - anchor.index) + 1 },
                (_, i) => Math.min(index, anchor.index) + i))
            let doc = await renderer.loadSelectionPage(index)
            if (revision !== this.#revision || this.#drag !== drag || !doc
                || doc.querySelector('[data-pdf-ocr-status]')) return
            if (!textNodes(doc).length) return
            const anchorCFI = this.#savePoint(anchor)
            await renderer.goTo({ index })
            if (revision !== this.#revision || this.#drag !== drag) return
            anchor = this.#restorePoint(anchorCFI)
            drag.anchor = anchor
            doc = renderer.getContents().find(item => item.index === index)?.doc
            const nodes = textNodes(doc)
            if (!nodes.length) return
            doc.defaultView.focus()
            const node = direction > 0 ? nodes[0] : nodes.at(-1)
            const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(node.textContent)]
            const offset = direction > 0 ? segments[0].segment.length : segments.at(-1).index
            this.#selectBetween(anchor, { doc, index, node, offset })
            drag.crossed = true
            drag.blockPoint = { ...drag.point }
            this.#view.dispatchEvent(new Event('pdf-selection-preview'))
        } catch { /* Retain the last complete range when a page cannot load. */ }
        finally { if (this.#drag === drag) drag.turning = false }
    }
    #stopDrag() {
        const drag = this.#drag
        this.#drag = null
        if (this.#animation !== null) cancelAnimationFrame(this.#animation)
        this.#animation = null
        if (drag?.target?.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id)
    }
    #update(event) {
        this.#rememberPoint(event)
        const drag = this.#drag
        if (drag && !drag.captured) {
            const frame = drag.doc.defaultView?.frameElement?.getBoundingClientRect()
            const host = this.#view.renderer.getBoundingClientRect()
            const { x, y } = drag.point
            const atEdge = (rect, margin) => x < rect.left + margin || x > rect.right - margin
                || y < rect.top + margin || y > rect.bottom - margin
            if (frame && (atEdge(frame, 24) || atEdge(host, 24))) {
                drag.target.setPointerCapture(drag.id)
                drag.captured = true
            }
        }
        if (this.#updateAtPoint()) event.preventDefault()
    }
    #updateAtPoint() {
        const drag = this.#drag
        if (!drag?.point) return
        const { x, y } = drag.point
        if (drag.turning) return
        if (drag.blockPoint) {
            if (Math.hypot(x - drag.blockPoint.x, y - drag.blockPoint.y) < 12) return
            drag.blockPoint = null
        }
        const contents = this.#view.renderer.getContents()
            .filter(x => x.doc.querySelector('.textLayer') && x.doc.defaultView?.frameElement
                && x.doc.defaultView.frameElement.parentElement?.style.visibility !== 'hidden')
        const distance = rect => Math.max(rect.left - x, 0, x - rect.right)
            + Math.max(rect.top - y, 0, y - rect.bottom)
        const target = contents.reduce((best, item) => {
            const rect = item.doc.defaultView.frameElement.getBoundingClientRect()
            return !best || distance(rect) < best.distance ? { ...item, rect, distance: distance(rect) } : best
        }, null)
        if (!target || (!drag.crossed && !drag.captured && target.index === drag.index)) return
        const end = getPDFSelectionCaret(target.doc,
            Math.max(0, Math.min(target.rect.width - 1, x - target.rect.left)),
            Math.max(0, Math.min(target.rect.height - 1, y - target.rect.top)))
        if (!end) return
        const selected = this.#selectBetween(drag.anchor ?? { ...drag.start, doc: drag.doc, index: drag.index }, { ...end, doc: target.doc, index: target.index })
        if (selected) drag.crossed = true
        return selected
    }
    #selectBetween(start, end) {
        const contents = this.#view.renderer.getContents()
        const lo = Math.min(start.index, end.index), hi = Math.max(start.index, end.index)
        if (hi - lo >= 24) {
            if (!this.#drag?.limited) this.#view.dispatchEvent(new Event('pdf-selection-limit'))
            if (this.#drag) this.#drag.limited = true
            return
        }
        if (this.#drag) this.#drag.limited = false
        const pages = contents.filter(x => x.index >= lo && x.index <= hi).sort((a,b) => a.index - b.index)
        // Do not claim an unrendered middle page was selected. The renderer's
        // normal load path can fill it before the next pointer movement.
        if (pages.length !== hi - lo + 1) return
        if (pages.some(x => x.doc.querySelector('[data-pdf-ocr-status]'))) return
        this.#view.renderer.setSelectionPages?.(pages.map(x => x.index))
        const forward = end.index > start.index
        const ranges = pages.map(({ doc, index }) => {
            const range = doc.createRange()
            const nodes = textNodes(doc)
            if (!nodes.length) return { index, range }
            // Text-node offsets keep CFI endpoints stable; an element boundary
            // after the last span does not round-trip through legacy EPUB CFI.
            range.setStart(nodes[0], 0)
            range.setEnd(nodes.at(-1), nodes.at(-1).textContent.length)
            if (start.index === end.index) {
                const a = doc.createRange(), b = doc.createRange()
                a.setStart(start.node, start.offset); a.collapse(true)
                b.setStart(end.node, end.offset); b.collapse(true)
                const first = a.compareBoundaryPoints(0, b) <= 0 ? start : end
                const last = first === end ? start : end
                range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset)
            } else {
                if (index === start.index) {
                    if (forward) range.setStart(start.node, start.offset)
                    else range.setEnd(start.node, start.offset)
                }
                if (index === end.index) {
                    if (forward) range.setEnd(end.node, end.offset)
                    else range.setStart(end.node, end.offset)
                }
            }
            return { index, range, focus: index === end.index }
        }).filter(x => !x.range.collapsed && x.range.toString().trim())
        this.#anchor = ranges.length ? start : null
        this.#focus = ranges.length ? end : null
        for (const { doc } of contents) {
            setCrossPageSelection(doc, ranges.length > 0)
            doc.getSelection()?.removeAllRanges()
        }
        this.#removePreviews()
        this.#ranges = ranges.length ? ranges : null
        for (const { index, range } of ranges) {
            const { doc } = contents.find(x => x.index === index)
            const selection = doc.getSelection()
            selection.addRange(range.cloneRange())
            // Inactive iframe native selections are not consistently painted by
            // WebKit. Draw the same real ranges with the existing SVG engine.
            const preview = new Overlayer(doc)
            preview.element.dataset.pdfSelectionPreview = ''
            preview.add('selection', range, Overlayer.highlight, {
                color: 'Highlight', padding: 0, radius: 0, radiusPadding: 0,
            })
            preview.element.style.opacity = '.3'
            doc.body.append(preview.element)
            this.#previews.push(preview.element)
        }
        // Preserve direction in the focus page for native keyboard extension.
        const focusSelection = end.doc.getSelection()
        const nodes = textNodes(end.doc)
        const local = end.doc === start.doc ? start : {
            node: forward ? nodes[0] : nodes.at(-1),
            offset: forward ? 0 : nodes.at(-1).textContent.length,
        }
        focusSelection.setBaseAndExtent(local.node, local.offset, end.node, end.offset)
        return true
    }
    #removePreviews() {
        for (const preview of this.#previews) preview.remove()
        this.#previews = []
    }
    get ranges() { return this.#ranges }
    async startHandle(cfis, side) {
        if (!cfis?.length || cfis.length > 24) return false
        this.#stopDrag()
        const revision = ++this.#revision
        try {
            const resolved = cfis.map(cfi => this.#view.resolveCFI(cfi))
            const lo = resolved[0].index, hi = resolved.at(-1).index
            if (lo < 0 || hi - lo >= 24 || hi < lo) return false
            this.#view.renderer.setSelectionPages?.(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))
            for (let index = lo; index <= hi; index++) {
                await this.#view.renderer.loadSelectionPage?.(index)
                if (revision !== this.#revision) return false
            }
            const contents = this.#view.renderer.getContents()
            const ranges = resolved.map(({ index, anchor }) => {
                const doc = contents.find(item => item.index === index)?.doc
                if (!doc || doc.querySelector('[data-pdf-ocr-status]')) throw new Error('pdf_selection_unavailable')
                const range = anchor(doc)
                if (!range || range.collapsed || !range.toString().trim()) throw new Error('pdf_selection_unavailable')
                return { doc, index, range }
            })
            const first = ranges[0], last = ranges.at(-1)
            const start = { doc: first.doc, index: first.index, node: first.range.startContainer, offset: first.range.startOffset }
            const end = { doc: last.doc, index: last.index, node: last.range.endContainer, offset: last.range.endOffset }
            if (!this.#selectBetween(start, end)) return false
            const anchor = side === 'start' ? end : start
            const focus = side === 'start' ? start : end
            this.#anchor = anchor
            this.#focus = focus
            this.#drag = { doc: focus.doc, index: focus.index, start: focus, anchor, crossed: true, handle: true }
            this.#animation = requestAnimationFrame(this.#scroll)
            return true
        } catch { return false }
    }
    moveHandle(point) {
        if (!this.#drag?.handle) return
        this.#drag.point = point
        this.#drag.origin ??= point
        this.#updateAtPoint()
        this.#view.dispatchEvent(new Event('pdf-selection-preview'))
    }
    stopHandle() { this.#stopDrag() }
    async extendHandle(direction) {
        if (!this.#drag?.handle) return false
        try {
            await this.#extendKey(direction, 'character', true, this.#revision, true)
            return !!this.#ranges?.length
        } catch { return false }
    }
    clear({ native = false } = {}) {
        this.#revision++
        this.#keyBusy = false
        this.#stopDrag()
        this.#removePreviews()
        for (const { doc } of this.#view.renderer.getContents()) {
            if (!doc) continue
            setCrossPageSelection(doc, false)
            if (native || this.#ranges) doc.getSelection()?.removeAllRanges()
        }
        const selected = !!this.#ranges
        this.#ranges = null
        this.#anchor = null
        this.#focus = null
        this.#view.renderer.setSelectionPages?.([])
        if (native || selected) this.#view.dispatchEvent(new CustomEvent('pdf-selection', { detail: null }))
    }
    destroy() {
        this.clear({ native: true })
        this.#layoutObserver.disconnect()
        this.#sizeObserver.disconnect()
        this.#controller.abort()
    }
}
