// Search and display use identical nodes, preserving CFI text offsets at zoom.
export const appendOCR = (container, page, viewport) => {
    if (!page || page.native || container.textContent?.trim()) return
    const doc = container.ownerDocument
    const context = doc.createElement('canvas').getContext('2d')
    for (const word of page.lines) {
        const span = doc.createElement('span')
        span.textContent = word.text
        const size = word.height * viewport.height
        Object.assign(span.style, {
            position: 'absolute', left: `${word.x * viewport.width}px`,
            top: `${word.y * viewport.height}px`, fontSize: `${size}px`,
            fontFamily: 'sans-serif', lineHeight: '1', color: 'transparent',
            whiteSpace: 'pre', transformOrigin: '0 0',
        })
        if (context) {
            context.font = `${size}px sans-serif`
            const measured = context.measureText(word.text.trimEnd()).width
            if (measured > 0) span.style.transform = `scaleX(${word.width * viewport.width / measured})`
        }
        container.append(span)
        if (word.endLine) container.append(doc.createElement('br'))
    }
}

export const ocrText = page => page?.native ? '' :
    page?.lines.map(word => word.text + (word.endLine ? '\n' : '')).join('') ?? ''
