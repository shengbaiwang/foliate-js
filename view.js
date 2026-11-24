import { compareReaderLocators, getChapterIndex, locatorForCFI, publishChapterIndex, retainChapterIndex } from './chapter-index.js'
import { NavigationController } from './navigation-controller.js'
import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress, PageProgress } from './progress.js'
import { Overlayer } from './overlayer.js'
import { textWalker } from './text-walker.js'

const SEARCH_PREFIX = 'foliate-search:'
const SEARCH_ACTIVE_PREFIX = 'foliate-search-active:'

// Paper-and-ink search match styling: a low-saturation parchment fill that
// reads like a light marker stroke on the page. The active match gets a
// stronger fill plus a hairline in the theme's text color ("ink").
const SEARCH_FILL_COLOR = '#d6c9a8'
const SEARCH_FILL_OPACITY = 0.32
const SEARCH_ACTIVE_FILL_OPACITY = 0.5
const SEARCH_ACTIVE_STROKE_WIDTH = 1

const isSearchValue = value =>
    value.startsWith(SEARCH_PREFIX) || value.startsWith(SEARCH_ACTIVE_PREFIX)

const drawSearchMatch = active => rects => {
    // Zero horizontal overhang: Overlayer.highlight extends the first/last
    // rect by radiusPadding + padding on each side, which is fine for Latin
    // (the overhang lands in word spacing) but paints over the neighbouring
    // glyph in CJK text, where characters have no gap between them.
    const g = Overlayer.highlight(rects, {
        color: SEARCH_FILL_COLOR,
        padding: 0,
        radius: 3,
        radiusPadding: 0,
    })
    g.style.opacity = active ? SEARCH_ACTIVE_FILL_OPACITY : SEARCH_FILL_OPACITY
    const rootStyle = window.getComputedStyle(document.documentElement)
    g.style.mixBlendMode =
        rootStyle.getPropertyValue('--overlayer-highlight-blend-mode').trim() || 'normal'
    if (active) {
        const outline = Overlayer.outline(rects, {
            color: 'currentColor',
            width: SEARCH_ACTIVE_STROKE_WIDTH,
            padding: 0,
            radius: 3,
        })
        g.append(outline)
    }
    return g
}

const NOTE_PREFIX = 'foliate-note:'

const isZip = async file => {
    const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}

const isPDF = async file => {
    const arr = new Uint8Array(await file.slice(0, 5).arrayBuffer())
    return arr[0] === 0x25
        && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46
        && arr[4] === 0x2d
}

const isCBZ = ({ name, type }) =>
    type === 'application/vnd.comicbook+zip' || name.endsWith('.cbz')

const isFB2 = ({ name, type }) =>
    type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

const isFBZ = ({ name, type }) =>
    type === 'application/x-zip-compressed-fb2'
    || name.endsWith('.fb2.zip') || name.endsWith('.fbz')

const makeZipLoader = async file => {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } =
        await import('./vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) =>
        map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return { entries, loadText, loadBlob, getSize }
}

const getFileEntries = async entry => entry.isFile ? entry
    : (await Promise.all(Array.from(
        await new Promise((resolve, reject) => entry.createReader()
            .readEntries(entries => resolve(entries), error => reject(error))),
        getFileEntries))).flat()

const makeDirectoryLoader = async entry => {
    const entries = await getFileEntries(entry)
    const files = await Promise.all(
        entries.map(entry => new Promise((resolve, reject) =>
            entry.file(file => resolve([file, entry.fullPath]),
                error => reject(error)))))
    const map = new Map(files.map(([file, path]) =>
        [path.replace(entry.fullPath + '/', ''), file]))
    const decoder = new TextDecoder()
    const decode = x => x ? decoder.decode(x) : null
    const getBuffer = name => map.get(name)?.arrayBuffer() ?? null
    const loadText = async name => decode(await getBuffer(name))
    const loadBlob = name => map.get(name)
    const getSize = name => map.get(name)?.size ?? 0
    return { loadText, loadBlob, getSize }
}

export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}

const fetchFile = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new ResponseError(
        `${res.status} ${res.statusText}`, { cause: res })
    return new File([await res.blob()], new URL(res.url).pathname)
}

export const makeBook = async file => {
    if (typeof file === 'string') file = await fetchFile(file)
    let book
    if (file.isDirectory) {
        const loader = await makeDirectoryLoader(file)
        const { EPUB } = await import('./epub.js')
        book = await new EPUB(loader).init()
    }
    else if (!file.size) throw new NotFoundError('File not found')
    else if (await isZip(file)) {
        const loader = await makeZipLoader(file)
        if (isCBZ(file)) {
            const { makeComicBook } = await import('./comic-book.js')
            book = makeComicBook(loader, file)
        }
        else if (isFBZ(file)) {
            const { makeFB2 } = await import('./fb2.js')
            const { entries } = loader
            const entry = entries.find(entry => entry.filename.endsWith('.fb2'))
            const blob = await loader.loadBlob((entry ?? entries[0]).filename)
            book = await makeFB2(blob)
        }
        else {
            const { EPUB } = await import('./epub.js')
            book = await new EPUB(loader).init()
        }
    }
    else if (await isPDF(file)) {
        const { makePDF } = await import('./pdf.js')
        book = await makePDF(file)
    }
    else {
        const { isMOBI, MOBI } = await import('./mobi.js')
        if (await isMOBI(file)) {
            const fflate = await import('./vendor/fflate.js')
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        }
        else if (isFB2(file)) {
            const { makeFB2 } = await import('./fb2.js')
            book = await makeFB2(file)
        }
    }
    if (!book) throw new UnsupportedTypeError('File type not supported')
    return book
}

class CursorAutohider {
    #timeout
    #el
    #check
    #state
    constructor(el, check, state = {}) {
        this.#el = el
        this.#check = check
        this.#state = state
        if (this.#state.hidden) this.hide()
        this.#el.addEventListener('mousemove', ({ screenX, screenY }) => {
            // check if it actually moved
            if (screenX === this.#state.x && screenY === this.#state.y) return
            this.#state.x = screenX, this.#state.y = screenY
            this.show()
            if (this.#timeout) clearTimeout(this.#timeout)
            if (check()) this.#timeout = setTimeout(this.hide.bind(this), 1000)
        }, false)
    }
    cloneFor(el) {
        return new CursorAutohider(el, this.#check, this.#state)
    }
    #hasSelection() {
        const selection = this.#el.ownerDocument?.getSelection()
        return selection ? !selection.isCollapsed : false
    }
    hide() {
        // The pointer is what the reader aims a selection with, so leave it
        // alone while one stands: a paused drag, or a double-click word
        // select (which fires no mousemove at all), would otherwise blank it.
        if (this.#hasSelection()) return
        this.#el.style.cursor = 'none'
        this.#state.hidden = true
    }
    show() {
        this.#el.style.removeProperty('cursor')
        this.#state.hidden = false
    }
}

class History extends EventTarget {
    #arr = []
    #index = -1
    pushState(x, nodeId) {
        const last = this.#arr[this.#index]
        if (last && last.nodeId === nodeId && (last.target === x
            || (typeof last.target?.fraction === 'number' && last.target.fraction === x?.fraction))) return
        this.#arr[++this.#index] = { target: x, nodeId }
        this.#arr.length = this.#index + 1
        this.dispatchEvent(new Event('index-change'))
    }
    replaceState(x) {
        const index = this.#index
        if (index < 0) this.pushState(x)
        else this.#arr[index] = { target: x }
    }
    move
    back() { return this.#step(-1) }
    forward() { return this.#step(1) }
    #step(delta) {
        const index = this.#index + delta
        if (index < 0 || index >= this.#arr.length) return
        const { target, nodeId } = this.#arr[index]
        return this.move?.(target, () => {
            this.#index = index
            this.dispatchEvent(new CustomEvent('popstate', { detail: { state: target } }))
            this.dispatchEvent(new Event('index-change'))
        }, nodeId)
    }
    get canGoBack() {
        return this.#index > 0
    }
    get canGoForward() {
        return this.#index < this.#arr.length - 1
    }
    clear() {
        this.#arr = []
        this.#index = -1
    }
}

const languageInfo = lang => {
    if (!lang) return {}
    try {
        const canonical = Intl.getCanonicalLocales(lang)[0]
        const locale = new Intl.Locale(canonical)
        const isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
        const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        return { canonical, locale, isCJK, direction }
    } catch (e) {
        console.warn(e)
        return {}
    }
}

export class View extends HTMLElement {
    #root = this.attachShadow({ mode: 'open' })
    #pdfSelection = null
    #sectionProgress
    #navigator = new NavigationController()
    #observed
    #moving = false
    #intent
    #observedSequence = 0
    #navigationSession = { pending: 0 }
    #releaseChapterIndex
    #openRequest
    #pageProgress
    #cfiProgress
    #searchResults = new Map()
    #activeSearchCFI = null
    #cursorAutohider = new CursorAutohider(this, () =>
        this.hasAttribute('autohide-cursor'))
    isFixedLayout = false
    lastLocation
    history = new History()
    constructor() {
        super()
        this.history.move = (target, commitHistory, nodeId) => this.navigate(target, {
            commitHistory, nodeId: getChapterIndex(this.book).node(nodeId)?.id })
        for (const type of ['wheel', 'touchmove'])
            this.addEventListener(type, this.#onReadingGesture, { passive: true })
    }
    #onReadingGesture = event => {
        if (event.ctrlKey || event.touches?.length > 1) return
        this.#interruptAbsoluteNavigation()
    }
    #interruptAbsoluteNavigation() {
        this.#intent = null
        this.#navigator.cancelAbsolute()
        if (this.#moving) this.#moving.interrupted = true
    }
    async open(book) {
        if (this.#releaseChapterIndex) this.close()
        const request = this.#openRequest = {}
        const opening = () => request === this.#openRequest
        if (typeof book === 'string'
        || typeof book.arrayBuffer === 'function'
        || book.isDirectory) book = await makeBook(book)
        if (!opening()) return
        this.book = book
        this.#releaseChapterIndex = retainChapterIndex(book)
        this.language = languageInfo(book.metadata?.language)

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            getChapterIndex(book)
            this.#pageProgress = new TOCProgress()
            await this.#pageProgress.init({
                toc: book.pageList ?? [], ids, splitHref, getFragment })
        }
        if (!opening()) return
        this.#cfiProgress = new PageProgress(book, this.resolveNavigation.bind(this))

        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            await import('./fixed-layout.js')
            if (!opening()) return
            this.renderer = document.createElement('foliate-fxl')
            if (book.getPDFAnnotationRects) {
                const { PDFCrossPageSelection } = await import('./pdf-cross-page-selection.js')
                if (!opening()) return
                this.#pdfSelection = new PDFCrossPageSelection(this)
            }
        } else {
            await import('./paginator.js')
            if (!opening()) return
            this.renderer = document.createElement('foliate-paginator')
        }
        this.renderer.setAttribute('exportparts', 'head,foot,filter,container')
        const renderer = this.renderer
        const current = () => this.book === book && this.renderer === renderer
        renderer.addEventListener('load', e => { if (current()) this.#onLoad(e.detail) })
        renderer.addEventListener('relocate', e => { if (current()) this.#onRelocate(e.detail) })
        renderer.addEventListener('create-overlayer', e => {
            if (current()) e.detail.attach(this.#createOverlayer(e.detail))
        })
        renderer.open(book)
        this.#root.append(renderer)

        if (book.sections.some(section => section.mediaOverlay)) {
            const activeClass = book.media.activeClass
            const playbackActiveClass = book.media.playbackActiveClass
            this.mediaOverlay = book.getMediaOverlay()
            let lastActive
            this.mediaOverlay.addEventListener('highlight', e => {
                this.#pdfSelection?.clear({ native: true })
                this.navigate(e.detail.text, { history: false })
                    .then(({ status, resolved }) => {
                        if (status !== 'arrived') return
                        const { doc } = this.renderer.getContents()
                            .find(x => x.index === resolved.index)
                        const el = resolved.anchor(doc)
                        el.classList.add(activeClass)
                        if (playbackActiveClass) el.ownerDocument
                            .documentElement.classList.add(playbackActiveClass)
                        lastActive = new WeakRef(el)
                    })
            })
            this.mediaOverlay.addEventListener('unhighlight', () => {
                const el = lastActive?.deref()
                if (el) {
                    el.classList.remove(activeClass)
                    if (playbackActiveClass) el.ownerDocument
                        .documentElement.classList.remove(playbackActiveClass)
                }
            })
        }
    }
    close() {
        this.#openRequest = null
        this.#navigator.cancel()
        this.#navigator = new NavigationController()
        this.#navigationSession = { pending: 0 }
        this.#moving = false
        this.#observed = null
        this.#intent = null
        this.#pdfSelection?.destroy()
        this.#pdfSelection = null
        this.#releaseChapterIndex?.()
        this.#releaseChapterIndex = null
        const renderer = this.renderer
        this.renderer = null
        renderer?.destroy()
        renderer?.remove()
        this.#sectionProgress = null
        this.#pageProgress = null
        this.#cfiProgress = null
        this.#searchResults = new Map()
        this.#activeSearchCFI = null
        this.lastLocation = null
        this.history.clear()
        this.tts = null
        this.mediaOverlay = null
    }
    goToTextStart() {
        return this.goTo(this.book.landmarks
            ?.find(m => m.type.includes('bodymatter') || m.type.includes('text'))
            ?.href ?? this.book.sections.findIndex(s => s.linear !== 'no'))
    }
    // Refresh navigation after a verified local outline changes, keeping the
    // renderer, text selection, CFI and history alive.
    async updateTOC(toc, signal) {
        const book = this.book
        if (!book || signal?.aborted || !this.#sectionProgress) return
        publishChapterIndex(book, toc, this.renderer.getContents())
        if (this.#observed && !this.#moving) this.#publishLocation(this.#observed, 'outline')
    }
    async init({ lastLocation, showTextStart }) {
        if (lastLocation && (await this.navigate(lastLocation)).status === 'arrived') return
        if (showTextStart) await this.goToTextStart()
        else await this.next()
    }
    #emit(name, detail, cancelable) {
        return this.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
    }
    #onRelocate({ reason, range, index, fraction, size }) {
        if (!this.book?.sections[index] || !this.#sectionProgress) return
        const progress = this.#sectionProgress.getProgress(index, fraction, size)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        this.#observed = { ...progress, index, pageItem, cfi, range, reason }
        this.#observedSequence++
        if (!this.#moving || (this.#moving.interrupted
            && (reason === 'scroll' || reason === 'container-scroll')))
            this.#publishLocation(this.#observed)
    }
    #publishLocation(location, reason = location.reason) {
        const { index, cfi } = location
        const chapters = getChapterIndex(this.book)
        const locator = locatorForCFI(this.book, cfi, index)
        if (reason === 'page' || reason === 'snap') this.#intent = null
        if (this.#intent && !this.#visible(this.#intent.resolved, location)) this.#intent = null
        const target = this.#intent
        const matched = target?.nodeId ? chapters.node(target.nodeId) : null
        const position = chapters.locate(target?.locator ?? locator)
        const chapter = matched ?? position.node
        this.lastLocation = { ...location, reason, locator,
            chapterId: chapter?.id, tocItem: chapter?.item ?? null,
            chapterQuality: matched ? chapters.range(matched.id)?.quality ?? 'resource' : position.quality }
        if (!this.#intent && ['snap', 'page', 'scroll', 'container-scroll'].includes(reason))
            this.history.replaceState(cfi)
        this.#emit('relocate', this.lastLocation)
    }
    #onLoad({ doc, index }) {
        const book = this.book, renderer = this.renderer
        const prepare = () => {
            if (this.book !== book || this.renderer !== renderer || !this.#sectionProgress) return
            const changed = getChapterIndex(book).prepareResource(index, doc)
            if (changed && !this.#moving && this.#observed?.index === index)
                this.#publishLocation(this.#observed, 'layout')
        }
        getChapterIndex(book).prepareResource(index, doc)
        if (book.getPDFAnnotationRects) doc.addEventListener('pdf-text-ready', prepare)
        for (const type of ['wheel', 'touchmove'])
            doc.addEventListener(type, this.#onReadingGesture, { passive: true })
        this.#pdfSelection?.attach(doc, index)
        // set language and dir if not already set
        doc.documentElement.lang ||= this.language.canonical ?? ''
        if (!this.language.isCJK)
            doc.documentElement.dir ||= this.language.direction ?? ''

        this.#handleLinks(doc, index)
        this.#cursorAutohider.cloneFor(doc.documentElement)

        this.#emit('load', { doc, index })
    }
    #handleLinks(doc, index) {
        const { book } = this
        const renderer = this.renderer
        const section = book.sections[index]
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (!a) return
            e.preventDefault()
            const href_ = a.getAttribute('href')
            const href = section?.resolveHref?.(href_) ?? href_
            if (book?.isExternal?.(href))
                Promise.resolve(this.#emit('external-link', { a, href }, true))
                    .then(x => x ? globalThis.open(href, '_blank') : null)
                    .catch(e => console.error(e))
            else {
                let internalHref = href
                // Reflowable adapters resolve this synchronously. A PDF destination
                // is asynchronous and is resolved once by the navigation request.
                if (!book.getPDFAnnotationRects && !book.resolveHref(href)) {
                    const hashIndex = href_.indexOf('#')
                    if (hashIndex >= 0) {
                        const hash = href_.slice(hashIndex)
                        internalHref = section?.resolveHref?.(hash) ?? href
                    }
                }
                Promise.resolve(this.#emit('link', { a, href: internalHref }, true))
                    .then(x => x && renderer === this.renderer ? this.goTo(internalHref) : null)
                    .catch(e => console.error(e))
            }
        })
    }
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        if (isSearchValue(value)) {
            const active = value.startsWith(SEARCH_ACTIVE_PREFIX)
            const cfi = value.replace(active ? SEARCH_ACTIVE_PREFIX : SEARCH_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                if (range) overlayer.add(value, range, drawSearchMatch(active))
            }
            return
        } else if (value.startsWith(NOTE_PREFIX)) {
            const cfi = value.replace(NOTE_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                if (range) {
                    const draw = (func, opts) => overlayer.add(value, range, func, opts)
                    this.#emit('draw-annotation', { draw, annotation, doc, range })
                }
            }
            return
        }
        const targets = annotation.pdfRanges ?? [value]
        if (annotation.pdfRanges !== undefined && (!Array.isArray(targets)
            || targets.length < 2 || targets.length > 24 || targets[0] !== value
            || targets.some(x => typeof x !== 'string' || !CFI.isCFI.test(x))))
            throw new Error('pdf_annotation_unresolved')
        let firstIndex
        for (const target of targets) {
            const { index, anchor } = await this.resolveNavigation(target)
            firstIndex ??= index
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                overlayer.remove(value)
                if (!remove) {
                    const range = doc ? anchor(doc) : anchor
                    if (range) {
                        const draw = (func, opts) => overlayer.add(value, range, func, opts)
                        this.#emit('draw-annotation', { draw, annotation, doc, range })
                    }
                }
            }
        }
        const label = getChapterIndex(this.book)
            .locate(locatorForCFI(this.book, targets[0], firstIndex)).node?.item.label ?? ''
        return { index: firstIndex, label }
    }
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }
    #getOverlayer(index) {
        return this.renderer.getContents()
            .find(x => x.index === index && x.overlayer)
    }
    #createOverlayer({ doc, index }) {
        const overlayer = new Overlayer(doc)
        doc.addEventListener('click', e => {
            const [value, range, rect] = overlayer.hitTest(e)
            if (value && !isSearchValue(value)) {
                this.#emit('show-annotation', { value, index, range, rect })
            }
        }, false)

        let lastHitTestTime = 0
        const THROTTLE_MS = 200
        const isAndroid = /Android/i.test(navigator.userAgent)

        doc.addEventListener('mousemove', (e) => {
            if (isAndroid) return
            const now = performance.now()
            if (now - lastHitTestTime < THROTTLE_MS) return
            lastHitTestTime = now
            const [value] = overlayer.hitTest(e)
            if (value && !isSearchValue(value)) {
                doc.body.style.cursor = 'pointer'
            } else {
                doc.body.style.cursor = ''
            }
        })

        const list = this.#searchResults.get(index)
        if (list) for (const item of list) this.addAnnotation(item)
        if (this.#activeSearchCFI)
            this.addAnnotation({ value: SEARCH_ACTIVE_PREFIX + this.#activeSearchCFI })

        this.#emit('create-overlay', { index })
        return overlayer
    }
    async showAnnotation(annotation) {
        const { value } = annotation
        const resolved = await this.goTo(value)
        if (resolved) {
            const { index, anchor } = resolved
            const { doc } =  this.#getOverlayer(index)
            const range = anchor(doc)
            this.#emit('show-annotation', { value, index, range })
        }
    }
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }
    resolveNavigation(target, current) {
        try {
            if (typeof target === 'number') return { index: target }
            if (typeof target?.resourceIndex === 'number') {
                const reference = locatorForCFI(this.book, undefined, target.resourceIndex)
                if (!reference || compareReaderLocators(reference, target) == null) return
                if (!target.cfi) return { index: target.resourceIndex }
                const resolved = this.resolveCFI(target.cfi)
                return resolved?.index === target.resourceIndex ? resolved : undefined
            }
            if (typeof target?.fraction === 'number') {
                const [index, anchor] = this.#sectionProgress.getSection(target.fraction)
                return { index, anchor }
            }
            if (CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref(target, current)
        } catch (e) {
            console.error(e)
            console.error(`Could not resolve target ${target}`)
        }
    }
    #visible(resolved, location) {
        if (!location) return false
        const { index, anchor } = resolved
        const doc = this.renderer.getContents?.().find(content => content.index === index)?.doc
        const iframe = doc?.defaultView?.frameElement
        if (!iframe) return !anchor && location.index === index
        const frame = iframe.getBoundingClientRect()
        const host = this.renderer.getBoundingClientRect()
        if (frame.bottom <= host.top || frame.top >= host.bottom
            || frame.right <= host.left || frame.left >= host.right) return false
        let target
        try { target = typeof anchor === 'function' ? anchor(doc) : anchor }
        catch { return false }
        if (anchor && target == null) return false
        if (!target || typeof target === 'number') {
            // Foliate settles progress fractions to the closest column/spread.
            // The renderer confirms that snap; the resource must intersect
            // the viewport but the raw unsnapped fraction need not be visible.
            return true
        }
        const scale = frame.width / (doc.documentElement?.clientWidth || frame.width) || 1
        const first = Array.from(target.getClientRects?.() ?? [])
            .find(rect => rect.width > 0 && rect.height > 0)
        const rect = first ?? target.getBoundingClientRect()
        const x = frame.left + scale * rect.left, y = frame.top + scale * rect.top
        return x >= host.left - 1 && x <= host.right + 1 && y >= host.top - 1 && y <= host.bottom + 1
    }
    async navigate(target, options) {
        const session = this.#navigationSession
        if (session.pending++ === 0) this.#emit('navigate-start')
        try { return await this.#navigate(target, options) }
        finally {
            if (--session.pending === 0 && session === this.#navigationSession)
                this.#emit('navigate-end')
        }
    }
    cancelNavigation() { this.#navigator.cancel() }
    async #navigate(target, { signal, nodeId, history = true, commitHistory, select = false } = {}) {
        const book = this.book, renderer = this.renderer
        let resolved
        const status = await this.#navigator.run(async current => {
            const valid = () => current() && book === this.book && renderer === this.renderer
                && !!this.#sectionProgress
            if (!valid()) return false
            const chapters = getChapterIndex(book)
            const node = nodeId ? chapters.node(nodeId) : chapters.byHref(target)
            if (nodeId && !node) return false
            const destination = node?.item.href ?? target
            resolved = await this.resolveNavigation(destination, valid)
            if (!valid() || !book.sections[resolved?.index]) return false
            if (!this.isFixedLayout && typeof destination === 'string'
                && !CFI.isCFI.test(destination) && resolved.anchor
                && book.splitTOCHref?.(destination)?.[1]
                && this.#observed
                && !chapters.range(node?.id)?.start) {
                const doc = renderer.getContents().find(content => content.index === resolved.index)?.doc
                    ?? await book.sections[resolved.index].createDocument?.()
                if (!valid() || (doc && resolved.anchor(doc) == null)) return false
            }
            this.#intent = null
            this.#pdfSelection?.clear({ native: true })
            const move = this.#moving = {}
            const sequence = this.#observedSequence
            try {
                const completed = await renderer.goTo({ ...resolved, select, current: valid })
                if (!valid()) return false
                const observed = this.#observed
                if (completed === false || !this.#visible(resolved, observed)) {
                    if (this.#observedSequence !== sequence) this.#publishLocation(observed, 'layout')
                    return false
                }
                const anchor = chapters.range(node?.id)?.start
                    ?? (typeof target === 'string' && CFI.isCFI.test(target)
                        ? locatorForCFI(book, target, resolved.index) : null)
                this.#intent = node || anchor ? { nodeId: node?.id, locator: anchor, resolved } : null
                if (commitHistory) commitHistory()
                else if (history) this.history.pushState(target, node?.id)
                this.#publishLocation(observed, 'navigation')
                return true
            } finally { if (this.#moving === move) this.#moving = false }
        }, { signal })
        return { status, resolved: status === 'arrived' ? resolved : undefined }
    }
    async goTo(target) {
        return (await this.navigate(target)).resolved
    }
    async goToFraction(fraction) {
        return this.goTo({ fraction })
    }
    async select(target) {
        return this.navigate(target, { select: true })
    }
    deselect() {
        this.#pdfSelection?.clear({ native: true })
        for (const { doc } of this.renderer.getContents())
            doc?.defaultView?.getSelection()?.removeAllRanges()
    }
    getPDFSelection() { return this.#pdfSelection?.ranges ?? null }
    startPDFSelectionHandle(cfis, side) { return this.#pdfSelection?.startHandle(cfis, side) ?? Promise.resolve(false) }
    extendPDFSelectionHandle(direction) { return this.#pdfSelection?.extendHandle(direction) ?? Promise.resolve(false) }
    movePDFSelectionHandle(point) { this.#pdfSelection?.moveHandle(point) }
    stopPDFSelectionHandle() { this.#pdfSelection?.stopHandle() }
    getSectionFractions() {
        return (this.#sectionProgress?.sectionFractions ?? [])
            .map(x => x + Number.EPSILON)
    }
    getProgressOf(index, range) {
        const cfi = this.book.sections[index] ? this.getCFI(index, range) : undefined
        const tocItem = getChapterIndex(this.book)
            .locate(locatorForCFI(this.book, cfi, index)).node?.item
        const pageItem = this.#pageProgress?.getProgress(index, range)
        return { tocItem, pageItem }
    }
    async getCFIProgress(cfi) {
        const progress = await this.#cfiProgress?.getProgress(cfi)
        if (!progress || progress.index === -1) return null
        return this.#sectionProgress?.getProgress(progress.index, progress.fraction)
    }
    async getTOCItemOf(target) {
        const resolved = await this.resolveNavigation(target)
        if (!resolved) return
        const chapters = getChapterIndex(this.book)
        return chapters.byHref(target)?.item
            ?? chapters.locate(locatorForCFI(this.book, target, resolved.index)).node?.item
    }
    async #turn(direction, distance) {
        const renderer = this.renderer
        return this.#navigator.run(async current => {
            if (!current() || renderer !== this.renderer || !this.#sectionProgress) return false
            this.#intent = null
            this.#pdfSelection?.clear({ native: true })
            const sequence = this.#observedSequence
            await renderer[direction](distance)
            if (!current() || renderer !== this.renderer || sequence === this.#observedSequence)
                return false
            this.history.replaceState(this.#observed.cfi)
            return true
        }, { relative: true })
    }
    async prev(distance) { await this.#turn('prev', distance) }
    async next(distance) { await this.#turn('next', distance) }
    async stepResource(direction) {
        const method = direction === 1 ? 'nextSection' : 'prevSection'
        if (this.renderer?.[method]) await this.#turn(method)
        else await this.#turn(direction === 1 ? 'next' : 'prev')
    }
    async pan(dx, dy) {
        this.#interruptAbsoluteNavigation()
        await this.renderer?.pan(dx, dy)
    }
    isOverflowX() {
        return this.renderer.isOverflowX
    }
    isOverflowY() {
        return this.renderer.isOverflowY
    }
    goLeft() {
        return this.book.dir === 'rtl' ? this.next() : this.prev()
    }
    goRight() {
        return this.book.dir === 'rtl' ? this.prev() : this.next()
    }
    // A matcher result carries a primary `range` (nav/excerpt anchor) and, for
    // nearby-words, per-word `subRanges` to highlight each matched word.
    #toSearchMatch(index, { range, excerpt, subRanges }) {
        const cfi = this.getCFI(index, range)
        if (subRanges?.length)
            return { cfi, cfis: subRanges.map(r => this.getCFI(index, r)), excerpt }
        return { cfi, excerpt }
    }
    async * #searchSection(matcher, query, index) {
        const doc = await this.book.sections[index].createDocument()
        for (const match of matcher(doc, query))
            yield this.#toSearchMatch(index, match)
    }
    async * #searchBook(matcher, query) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (!createDocument) continue
            const doc = await createDocument()
            const subitems = Array.from(matcher(doc, query), match => this.#toSearchMatch(index, match))
            const progress = (index + 1) / sections.length
            yield { progress }
            if (subitems.length) yield { index, subitems }
        }
    }
    async * search(opts) {
        this.clearSearch()
        const { searchMatcher } = await import('./search.js')
        const { sections } = this.book
        const { query, index, results } = opts
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language, ...opts })

        const iter = results?.length
            ? (async function* () {
                for (const result of results) {
                    if (result.subitems) {
                        const progress = (result.index + 1) / sections.length
                        yield { progress }
                        yield { index: result.index, subitems: result.subitems }
                    } else {
                        yield { cfi: result.cfi, cfis: result.cfis, excerpt: result.excerpt }
                    }
                }
            })()
            : index != null
                ? this.#searchSection(matcher, query, index)
                : this.#searchBook(matcher, query)

        const list = []
        const seen = new Set()
        const seenByResource = new Map()
        this.#searchResults.set(index, list)
        // Add one annotation per unique CFI (a nearby-words match carries several
        // via `cfis`); dedupe so overlapping CFIs don't collide in #searchResults.
        const addHighlights = (cfis, sink, sinkSeen) => {
            for (const cfi of cfis) {
                if (sinkSeen.has(cfi)) continue
                sinkSeen.add(cfi)
                const item = { value: SEARCH_PREFIX + cfi }
                sink.push(item)
                this.addAnnotation(item)
            }
        }

        for await (const result of iter) {
            if (result.subitems){
                for (const item of result.subitems) {
                    const resource = locatorForCFI(this.book, item.cfi)?.resourceIndex ?? result.index
                    const sectionList = this.#searchResults.get(resource) ?? []
                    let sectionSeen = seenByResource.get(resource)
                    if (!sectionSeen) seenByResource.set(resource, sectionSeen = new Set())
                    addHighlights(item.cfis ?? [item.cfi], sectionList, sectionSeen)
                    this.#searchResults.set(resource, sectionList)
                }
                yield {
                    index: result.index,
                    label: getChapterIndex(this.book).locate(locatorForCFI(
                        this.book, result.subitems[0]?.cfi, result.index)).node?.item.label ?? '',
                    subitems: result.subitems,
                }
            }
            else {
                if (result.cfi) addHighlights(result.cfis ?? [result.cfi], list, seen)
                yield result
            }
        }
        yield 'done'
    }
    // Highlight `cfi` as the current search match (pass null to clear).
    // The active match is drawn under a separate key so switching is just a
    // redraw of the old and new CFIs; it is not part of #searchResults.
    async setSearchMatchActive(cfi) {
        if (this.#activeSearchCFI === cfi) return
        const prev = this.#activeSearchCFI
        this.#activeSearchCFI = cfi
        if (prev) await this.addAnnotation({ value: SEARCH_PREFIX + prev })
        if (cfi) await this.addAnnotation({ value: SEARCH_ACTIVE_PREFIX + cfi })
    }
    clearSearch() {
        if (this.#activeSearchCFI) {
            const active = this.#activeSearchCFI
            this.#activeSearchCFI = null
            this.deleteAnnotation({ value: SEARCH_ACTIVE_PREFIX + active })
        }
        for (const list of this.#searchResults.values())
            for (const item of list) this.deleteAnnotation(item)
        this.#searchResults.clear()
    }
    async initTTS(granularity = 'word', nodeFilter, highlighter) {
        const contents = this.renderer.getContents()
        const primaryIndex = this.renderer.primaryIndex
        const primary = contents.find(x => x.index === primaryIndex) ?? contents[0]
        const doc = primary?.doc
        if (!doc) return
        if (this.tts && this.tts.doc === doc) return
        const { TTS } = await import('./tts.js')
        this.tts = new TTS(doc, textWalker, nodeFilter, highlighter || (range =>
            this.renderer.scrollToAnchor(range, true)), granularity)
    }
    startMediaOverlay() {
        const contents = this.renderer.getContents()
        const primaryIndex = this.renderer.primaryIndex
        const primary = contents.find(x => x.index === primaryIndex) ?? contents[0]
        const { index } = primary ?? {}
        return this.mediaOverlay.start(index)
    }
}

customElements.define('foliate-view', View)
