export interface ReaderLocator {
    readonly document: symbol | undefined
    readonly resourceIndex: number
    readonly cfi?: string
}
export interface ChapterNode<T> {
    readonly id: string
    readonly item: T
    readonly depth: number
    readonly parent: ChapterNode<T> | null
    readonly fragment?: string
    readonly resourceIndex?: number
}
export interface ChapterIndex<T> {
    readonly usable: boolean
    byItem(item: T | null | undefined): ChapterNode<T> | null
    byHref(href: string): ChapterNode<T> | null
    node(id: string): ChapterNode<T> | null
    path(id: string): ChapterNode<T>[]
    range(id: string): {
        start: ReaderLocator
        end?: ReaderLocator
        endNode?: ChapterNode<T>
        quality: 'exact' | 'resource'
    } | null
    locate(locator: ReaderLocator | null): {
        node: ChapterNode<T> | null
        quality: 'exact' | 'resource' | 'unknown'
    }
    adjacent(id: string, direction: -1 | 1): ChapterNode<T> | null
    prepareResource(resourceIndex: number, doc: Document): boolean
}
export function getChapterIndex<T, B extends { toc?: T[] }>(book: B & { toc?: T[] }, toc?: T[]): ChapterIndex<T>
export function getStandaloneChapterIndex<T>(toc: T[]): ChapterIndex<T>
export function publishChapterIndex<T>(book: { toc?: T[] }, toc: T[], contents?: { index: number; doc: Document }[]): ChapterIndex<T>
export function retainChapterIndex(book: object): () => void
export function locatorForCFI<B extends object>(book: B | undefined, cfi?: string, resourceIndex?: number): ReaderLocator | null
export function compareReaderLocators(a: ReaderLocator, b: ReaderLocator): number | null
