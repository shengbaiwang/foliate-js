// Versioned presentation only; never rewrite persisted Vision words or offsets.
// A TOC's title column and page-number column are often separate observations.
// Merge those rows only with repeated page-label evidence; ordinary multi-column
// prose keeps Vision's block order instead of being interleaved by y-coordinate.
export const orderedOCR = page => {
    const fragments = []
    let words = []
    for (const word of page?.lines ?? []) {
        words.push(word)
        if (word.endLine) { fragments.push(words); words = [] }
    }
    if (words.length) fragments.push(words)
    const parts = fragments.map(words => {
        const x = Math.min(...words.map(w => w.x))
        const y = Math.min(...words.map(w => w.y))
        return { words, x, y,
            right: Math.max(...words.map(w => w.x + w.width)),
            height: Math.max(...words.map(w => w.y + w.height)) - y }
    })
    const rows = []
    for (const part of [...parts].sort((a, b) => b.height - a.height)) {
        const center = part.y + part.height / 2
        const row = rows.find(({ anchor }) => {
            const overlap = Math.min(anchor.y + anchor.height, part.y + part.height)
                - Math.max(anchor.y, part.y)
            return overlap >= Math.min(anchor.height, part.height) * 0.5
                && Math.abs(anchor.y + anchor.height / 2 - center)
                    <= Math.max(anchor.height, part.height) * 0.6
        })
        if (row) row.parts.push(part)
        else rows.push({ anchor: part, parts: [part] })
    }
    const labels = rows.filter(({ parts }) => {
        parts.sort((a, b) => a.x - b.x)
        const last = parts.at(-1), previous = parts.at(-2)
        return previous && last.x > 0.5
            && /^[.·…_。•⋯∙●‧﹒\s]*(?:\d{1,4}|[ivxlcdm]+)$/i
                .test(last.words.map(w => w.text).join('').normalize('NFKC').trim())
            && last.x - previous.right > Math.max(last.height, previous.height) * 1.5
    })
    if (labels.length < 2) return page?.lines ?? []
    return rows.sort((a, b) => a.anchor.y - b.anchor.y)
        .flatMap(({ parts }) => {
            const row = parts.flatMap(p => p.words)
            return row.map((word, i) => ({ ...word, endLine: i === row.length - 1 }))
        })
}

// Keep the old direct children in their original order for existing CFI ranges.
// They have geometry for old annotations, but are excluded from interaction and
// text traversal. New selections/search use a separate, stable v2 subtree.
export const appendOCR = (container, page, viewport) => {
    if (!page || page.native || container.textContent?.trim()) return
    const doc = container.ownerDocument
    const legacy = []
    for (const word of page.lines) {
        const span = doc.createElement('span')
        span.textContent = word.text
        span.setAttribute('data-pdf-legacy', '')
        span.setAttribute('aria-hidden', 'true')
        Object.assign(span.style, { visibility: 'hidden', pointerEvents: 'none', userSelect: 'none' })
        container.append(span)
        legacy.push(span)
        if (word.endLine) {
            const br = doc.createElement('br')
            br.setAttribute('data-pdf-legacy', '')
            br.style.visibility = 'hidden'
            container.append(br)
        }
    }
    const reading = doc.createElement('div')
    reading.setAttribute('data-pdf-ocr-text', '2')
    Object.assign(reading.style, { position: 'absolute', inset: '0', transform: 'none' })
    container.append(reading)
    const spans = []
    const ordered = orderedOCR(page)
    for (const word of ordered) {
        const span = doc.createElement('span')
        span.textContent = word.text
        // Infer only unambiguous tall CJK runs. Keep stored words, node order,
        // offsets and the legacy projection intact; this changes geometry only.
        const vertical = /[\u3040-\u30ff\u3400-\u9fff]{2}/u.test(word.text)
            && word.height * viewport.height > word.width * viewport.width * 1.6
        span.dir = 'auto'
        Object.assign(span.style, {
            position: 'absolute', left: '0', top: '0', fontSize: `${word.height * viewport.height}px`,
            fontFamily: 'sans-serif', lineHeight: '1', color: 'transparent',
            whiteSpace: 'pre', transform: 'none', transformOrigin: '0 0',
            writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
            textOrientation: vertical ? 'upright' : 'mixed',
        })
        reading.append(span)
        spans.push(span)
        if (word.endLine) reading.append(doc.createElement('br'))
    }
    // Batch layout reads before writes. Actual DOM font metrics (including CJK
    // fallback and trailing spaces) match native caret/Range geometry; font size
    // alone describes neither the glyph box nor the browser's selection box.
    const origin = reading.getBoundingClientRect()
    const metrics = spans.map(span => {
        const range = doc.createRange()
        range.selectNodeContents(span)
        return range.getBoundingClientRect()
    })
    const styles = new Map()
    ordered.forEach((word, i) => {
        const box = metrics[i]
        const sx = box.width > 0 ? word.width * viewport.width / box.width : 1
        const sy = box.height > 0 ? word.height * viewport.height / box.height : 1
        const style = {
            left: `${word.x * viewport.width - (box.left - origin.left) * sx}px`,
            top: `${word.y * viewport.height - (box.top - origin.top) * sy}px`,
            transform: `scale(${sx}, ${sy})`,
        }
        Object.assign(spans[i].style, style)
        // orderedOCR clones words; pair legacy nodes by their unchanged boxes/text.
        const key = [word.x, word.y, word.width, word.height, word.text].join('|')
        styles.set(key, { ...style, fontSize: spans[i].style.fontSize, fontFamily: 'sans-serif',
            writingMode: spans[i].style.writingMode, textOrientation: spans[i].style.textOrientation,
            direction: doc.defaultView?.getComputedStyle(spans[i]).direction ?? 'ltr',
            lineHeight: '1', whiteSpace: 'pre', position: 'absolute', transformOrigin: '0 0' })
    })
    page.lines.forEach((word, i) => Object.assign(legacy[i].style,
        styles.get([word.x, word.y, word.width, word.height, word.text].join('|'))))
}

export const ocrText = page => page?.native ? '' :
    orderedOCR(page).map(word => word.text + (word.endLine ? '\n' : '')).join('')
