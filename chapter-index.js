import * as CFI from './epubcfi.js'

// Neither rendered pages nor DOM nodes are part of a locator. CFIs preserve
// content order across layout changes; the resource index also supports PDF
// pages and spine entries without text.
const documents = new WeakMap()
const readers = new WeakMap()
const identities = new WeakMap()
const emptyToc = []
const identity = book => {
    if (!book) return
    let token = identities.get(book)
    if (!token) identities.set(book, token = Symbol('reading-document'))
    return token
}
const standalone = new WeakMap()
const resources = new WeakMap()
const decoded = value => {
    if (typeof value !== 'string') return value
    try { return decodeURIComponent(value) }
    catch { return value }
}
const resourceMap = book => {
    let map = resources.get(book)
    if (!map) {
        map = new Map()
        book.sections?.forEach((s, i) => {
            for (const key of [s.id, s.href]) if (key != null) {
                map.set(key, i)
                if (!map.has(decoded(key))) map.set(decoded(key), i)
            }
        })
        resources.set(book, map)
    }
    return map
}

const point = cfi => {
    if (!cfi || !CFI.isCFI.test(cfi)) return null
    try {
        const parts = CFI.collapse(CFI.parse(cfi))
        if (!parts[0]?.length) return null
        return parts
    } catch { return null }
}

export const locatorForCFI = (book, cfi, resourceIndex) => {
    const parts = point(cfi)
    if (resourceIndex == null && parts) {
        try { resourceIndex = book?.resolveCFI?.(cfi)?.index ?? CFI.fake.toIndex(parts[0]) }
        catch { return null }
    }
    if (!Number.isInteger(resourceIndex) || resourceIndex < 0
        || (book?.sections && resourceIndex >= book.sections.length)) return null
    return { document: identity(book), resourceIndex, cfi: parts ? cfi : undefined, parts }
}

const compare = (a, b) => a.resourceIndex - b.resourceIndex
    || (a.parts && b.parts ? CFI.compare(a.parts, b.parts) : Number(!!a.parts) - Number(!!b.parts))
export const compareReaderLocators = (a, b) =>
    a?.document === b?.document && a && b ? compare(a, b) : null

const upperBound = (items, compareItem) => {
    let lo = 0, hi = items.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (compareItem(items[mid]) <= 0) lo = mid + 1
        else hi = mid
    }
    return lo
}

class ChapterIndex {
    #nodes = new Map()
    #byItem = new WeakMap()
    #byHref = new Map()
    #groups = []
    #byResource = new Map()
    #unresolved = new Set()
    #coarse = []
    #live = new Map()
    #pdfPoints = new Map()
    #pdfAnchors = new Map()
    #prepared = new WeakSet()
    #paratext = new Set()
    #book
    constructor(toc, book) {
        this.#book = book
        const walk = (items, parent = null) => {
            const counts = new Map()
            for (const item of items) {
                const href = item.href ?? ''
                const count = counts.get(href) ?? 0
                counts.set(href, count + 1)
                const id = (parent ? parent.id + '/' : '') + encodeURIComponent(href) + ':' + count
                const node = { id, item, parent, depth: parent ? parent.depth + 1 : 0 }
                this.#nodes.set(id, node)
                this.#byItem.set(item, node)
                if (href && !this.#byHref.has(href)) this.#byHref.set(href, node)
                const [resource, fragment] = book?.splitTOCHref?.(href) ?? []
                const fromResource = resourceMapFor(book, resource)
                const pdf = !!book?.getPDFAnnotationRects
                const index = fromResource ?? (pdf && Number.isInteger(item.index) ? item.index : undefined)
                const location = href && locatorForCFI(book, item.cfi, index)
                // Missing EPUB fragment evidence must not turn into an exact
                // chapter start through the old section-CFI fallback.
                const base = book?.sections?.[location?.resourceIndex]?.cfi
                node.resourceIndex = location?.resourceIndex ?? index
                node.fragment = fragment || undefined
                if (location) {
                    if (!pdf && fragment && (!location.parts || item.cfi === base))
                        this.#unresolved.add(location.resourceIndex)
                    else node.start = location
                } else if (index != null && fragment) this.#unresolved.add(index)
                if (node.resourceIndex != null) {
                    const bucket = this.#byResource.get(node.resourceIndex) ?? []
                    bucket.push(node)
                    this.#byResource.set(node.resourceIndex, bucket)
                }
                if (item.subitems?.length) walk(item.subitems, node)
            }
        }
        walk(toc)
        for (const { type, href } of book?.landmarks ?? []) {
            if (!type?.some?.(name => /^(cover|frontmatter|titlepage|toc|endnotes|footnotes|rearnotes|notes|glossary|bibliography|index)$/.test(name))) continue
            const [resource, fragment] = book.splitTOCHref?.(href) ?? []
            const index = resourceMapFor(book, resource)
            if (!fragment && index != null) this.#paratext.add(index)
        }
        this.#rebuild()
    }
    #rebuild() {
        this.#coarse = [...this.#byResource]
            .filter(([, nodes]) => nodes.some(n => !n.start))
            .sort(([a], [b]) => a - b)
        this.#groups = []
        const nodes = [...this.#nodes.values()].filter(n => n.start).sort((a, b) =>
            compare(a.start, b.start) || a.depth - b.depth)
        for (const node of nodes) {
            node.end = undefined
            node.endNode = undefined
            let group = this.#groups.at(-1)
            if (!group || compare(group.start, node.start)) {
                group = { start: node.start, nodes: [] }
                this.#groups.push(group)
            }
            node.group = this.#groups.length - 1
            group.nodes.push(node)
        }
        let active = []
        for (const group of this.#groups) {
            const [first, ...rest] = group.nodes
            group.node = rest.reduce((a, b) => {
                if (!a) return null
                if (this.#isAncestor(a, b)) return b
                while (a && !this.#isAncestor(a, b)) a = a.parent
                return a
            }, first)
            group.unique = group.node != null && group.nodes.every(n =>
                n === group.node || this.#isAncestor(n, group.node))
            // Resolve bounds at distinct body positions; a parent and child
            // may legitimately open on the same heading. An unrelated node
            // closes the interval even if its TOC row is displayed earlier.
            active = active.filter(previous => {
                const next = group.nodes.find(n => !this.#isAncestor(previous, n))
                if (!next) return true
                previous.end = group.start
                previous.endNode = next
                return false
            })
            active.push(...group.nodes)
        }
    }
    #isAncestor(parent, node) {
        for (let n = node.parent; n; n = n.parent) if (n === parent) return true
        return false
    }
    // Resolve only the loaded resource's targets. No whole-book DOM work is
    // needed on relocation; the results are shared by all views of the book.
    prepareResource(resourceIndex, doc) {
        if (!doc || !this.#book) return false
        const book = this.#book
        const pdf = !!book.getPDFAnnotationRects
        if (this.#prepared.has(doc)) return false
        if (!pdf || doc.querySelector('.textLayer span')) this.#prepared.add(doc)
        let changed = false
        for (const node of this.#byResource.get(resourceIndex) ?? []) {
            if (this.#live.has(node.id) || (!pdf && node.start)) continue
            let target
            try {
                target = pdf ? book.getChapterAnchor?.(doc, node.item.href)
                    : node.fragment && (book.getTOCFragment?.(doc, node.fragment)
                        ?? book.getTOCFragment?.(doc, decoded(node.fragment)))
                if (!target || typeof target === 'number') continue
                const range = target.startContainer ? target.cloneRange() : doc.createRange()
                if (!target.startContainer) range.selectNodeContents(target)
                range.collapse(true)
                const cfi = CFI.joinIndir(book.sections[resourceIndex]?.cfi
                    ?? CFI.fake.fromIndex(resourceIndex), CFI.fromRange(range))
                const start = locatorForCFI(book, cfi, resourceIndex)
                if (!start) continue
                this.#live.set(node.id, true)
                if (pdf) {
                    this.#pdfAnchors.set(node.id, start)
                    changed = true
                } else if (!node.start || compare(node.start, start)) {
                    node.start = start
                    changed = true
                }
            } catch { /* A broken target remains unresolved or page-only. */ }
        }
        if (changed && pdf) {
            const points = (this.#byResource.get(resourceIndex) ?? [])
                .map(node => ({ node, point: this.#pdfAnchors.get(node.id) }))
                .filter(({ point }) => point).sort((a, b) => compare(a.point, b.point))
            this.#pdfPoints.set(resourceIndex, points)
        } else if (changed) this.#rebuild()
        if (this.#unresolved.has(resourceIndex) && this.#byResource.get(resourceIndex)
            ?.every(node => !node.fragment || node.start)) this.#unresolved.delete(resourceIndex)
        return changed
    }
    get usable() { return this.#groups.length > 0 }
    byItem(item) { return item ? this.#byItem.get(item) ?? null : null }
    byHref(href) { return this.#byHref.get(href) ?? null }
    node(id) { return this.#nodes.get(id) ?? null }
    path(id) {
        const result = []
        for (let n = this.node(id); n; n = n.parent) result.push(n)
        return result.reverse()
    }
    range(id) {
        const node = this.node(id)
        if (!node?.start) return null
        const point = this.#pdfAnchors.get(id)
        if (point) {
            const points = this.#pdfPoints.get(node.resourceIndex)
            const end = upperBound(points, entry => compare(entry.point, point))
            const next = points[end]
            const duplicate = end > 1 && compare(points[end - 2].point, point) === 0
            return { start: point, end: next?.point ?? node.end, endNode: next?.node ?? node.endNode,
                quality: next && !duplicate && points.length === this.#byResource.get(node.resourceIndex)?.length
                    ? 'exact' : 'resource' }
        }
        const pending = this.#coarse[upperBound(this.#coarse, ([i]) => i - node.resourceIndex + 1)]
        const precise = !this.#unresolved.has(node.resourceIndex)
            && !this.#unresolved.has(node.endNode?.resourceIndex)
            && (!pending || (node.end && pending[0] > node.end.resourceIndex))
            && this.#groups[node.group]?.unique
            && (!node.end || compare(node.start, node.end) < 0)
            && (!this.#book?.getPDFAnnotationRects || (!!node.start.parts?.[1]?.length
                && (!node.end || !!node.end.parts?.[1]?.length)))
        return { start: node.start, end: node.end, endNode: node.endNode,
            quality: precise ? 'exact' : 'resource' }
    }
    locate(locator) {
        const unknown = { node: null, quality: 'unknown' }
        if (!locator || (this.#book && locator.document !== identity(this.#book))) return unknown
        const { resourceIndex } = locator
        if ((this.#book?.sections?.[resourceIndex]?.linear === 'no' || this.#paratext.has(resourceIndex))
            && !this.#byResource.has(resourceIndex)) return unknown
        const pdfPoints = this.#pdfPoints.get(resourceIndex)
        if (locator.parts?.[1]?.length && pdfPoints?.length
            && pdfPoints.length === this.#byResource.get(resourceIndex)?.length) {
            const i = upperBound(pdfPoints, ({ point }) => compare(point, locator)) - 1
            if (i >= 0) {
                const { node, point } = pdfPoints[i]
                if (i > 0 && !compare(pdfPoints[i - 1].point, point)) return unknown
                return { node, quality: 'exact' }
            }
        }
        const group = this.#groups[upperBound(this.#groups, g => compare(g.start, locator)) - 1]
        // On a cold open a preceding resource can still be unparsed. A
        // single preceding entry may label the UI at resource precision; it
        // never supplies an extraction boundary or exact point.
        const pending = this.#coarse[upperBound(this.#coarse, ([i]) => i - resourceIndex + 1) - 1]
        if (pending && (!group || pending[0] > group.start.resourceIndex)) {
            const [index, nodes] = pending
            if (nodes.length !== 1 || this.#book?.sections?.[index]?.linear === 'no') return unknown
            return { node: nodes[0], quality: 'resource' }
        }
        const node = group?.node
        if (!node || (node.end && compare(node.end, locator) <= 0)) return unknown
        const pdf = !!this.#book?.getPDFAnnotationRects
        const coarse = pdf && (!locator.parts?.[1]?.length || !node.start.parts?.[1]?.length)
        return { node, quality: coarse || !group.unique || this.#unresolved.has(resourceIndex)
            ? 'resource' : 'exact' }
    }
    adjacent(id, direction) {
        const node = this.node(id)
        const group = node?.group
        if (group == null) return null
        const local = this.#pdfPoints.get(node.resourceIndex)
        const current = this.#pdfAnchors.get(id)
        if (current && local?.length) {
            const next = direction === 1
                ? local[upperBound(local, entry => compare(entry.point, current))]
                : local.findLast(entry => compare(entry.point, current) < 0)
            if (next) return next.node
        }
        for (let i = group + direction; i >= 0 && i < this.#groups.length; i += direction) {
            const group = this.#groups[i]
            const points = this.#pdfPoints.get(group.start.resourceIndex)
            if (points?.length && points.length === this.#byResource.get(group.start.resourceIndex)?.length)
                return points.at(direction === 1 ? 0 : -1).node
            const target = group.node ?? group.nodes[0]
            if (target?.item.href) return target
        }
        return null
    }
}

const resourceMapFor = (book, key) => !book ? undefined : (resourceMap(book).get(key)
    ?? resourceMap(book).get(decoded(key))
    ?? (Number.isInteger(key) ? key : undefined))

export const getChapterIndex = (book, toc = book.toc ?? emptyToc) => {
    const cached = documents.get(book)
    if (cached?.toc === toc) return cached.index
    const index = new ChapterIndex(toc, book)
    if (toc === (book.toc ?? emptyToc)) {
        documents.set(book, { toc, index })
    }
    return index
}
export const publishChapterIndex = (book, toc, contents = []) => {
    const index = getChapterIndex(book, toc)
    for (const { index: resourceIndex, doc } of contents) index.prepareResource(resourceIndex, doc)
    book.toc = toc
    documents.set(book, { toc, index })
    return index
}
export const retainChapterIndex = book => {
    readers.set(book, (readers.get(book) ?? 0) + 1)
    let retained = true
    return () => {
        if (!retained) return
        retained = false
        const remaining = readers.get(book) - 1
        if (remaining) readers.set(book, remaining)
        else {
            readers.delete(book)
            documents.delete(book)
            resources.delete(book)
        }
    }
}
export const getStandaloneChapterIndex = toc => {
    let index = standalone.get(toc)
    if (!index) standalone.set(toc, index = new ChapterIndex(toc))
    return index
}
