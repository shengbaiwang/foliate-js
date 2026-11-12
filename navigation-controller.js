// The renderer may be awaiting an iframe that cannot be cancelled. Keep one
// writer per view, and pass a validity check through to its commit boundary.
export class NavigationController {
    #tail = Promise.resolve()
    #epoch = 0
    #absolute
    cancel() { this.#epoch++; this.#absolute = null }
    cancelAbsolute() { if (this.#absolute) this.#absolute.cancelled = true }
    run(work, { relative = false, signal } = {}) {
        if (signal?.aborted) return Promise.resolve('cancelled')
        this.#absolute = null
        const epoch = this.#epoch
        const ticket = {}
        if (!relative) this.#absolute = ticket
        const invalid = () => signal?.aborted || ticket.cancelled || epoch !== this.#epoch ? 'cancelled'
            : !relative && this.#absolute !== ticket ? 'superseded' : null
        const task = this.#tail.then(async () => {
            if (invalid()) return invalid()
            try {
                const arrived = await work(() => !invalid())
                return invalid() ?? (arrived ? 'arrived' : 'failed')
            } catch { return invalid() ?? 'failed' }
        })
        this.#tail = task
        return task
    }
}
