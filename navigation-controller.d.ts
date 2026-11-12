export type NavigationStatus = 'arrived' | 'failed' | 'cancelled' | 'superseded'
export class NavigationController {
    cancel(): void
    cancelAbsolute(): void
    run(work: (current: () => boolean) => boolean | Promise<boolean>,
        options?: { relative?: boolean; signal?: AbortSignal }): Promise<NavigationStatus>
}
