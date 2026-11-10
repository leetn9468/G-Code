/** Serializes replacement starts without delaying cancellation of a running start. */
export class SessionCancelledError extends Error {
  constructor() { super('Session startup cancelled'); this.name = 'SessionCancelledError' }
}

export class SessionLifecycle {
  private revision = 0
  private launch: Promise<void> | null = null
  private cleanup: Promise<void> = Promise.resolve()
  private actions = new Set<Promise<void>>()
  private active = false

  get starting(): boolean { return this.launch !== null }
  get running(): boolean { return this.active }

  /** Includes durable-history restoration after Stop, before another prompt is added. */
  settled(): Promise<void> { return this.cleanup }

  private check(revision: number): void {
    if (revision !== this.revision) throw new SessionCancelledError()
  }

  async ensure(start: () => Promise<void>, ready: Promise<void> = Promise.resolve()): Promise<void> {
    const revision = this.revision
    await this.cleanup
    await ready
    this.check(revision)
    if (this.active) return
    if (this.launch) {
      await this.launch
      this.check(revision)
      if (!this.active) throw new SessionCancelledError()
      return
    }
    // Invoke now, before yielding, so cancel() can invalidate this backend start.
    const launch = start()
    this.launch = launch
    try {
      await launch
      this.check(revision)
      this.active = true
    } finally { if (this.launch === launch) this.launch = null }
  }

  async run(start: () => Promise<void>, action: () => Promise<void>, ready: Promise<void> = Promise.resolve()): Promise<void> {
    const revision = this.revision
    await this.ensure(start, ready)
    this.check(revision)
    const pending = action()
    this.actions.add(pending)
    try { await pending } finally { this.actions.delete(pending) }
  }

  cancel(stop: () => Promise<void>, afterStop?: () => Promise<void>): Promise<void> {
    this.revision++
    this.active = false
    const previousCleanup = this.cleanup
    const launch = this.launch
    // Do not await launch here: the backend must receive cancellation while
    // GGUF loading still owns its lifecycle lock.
    let cancellation: Promise<void>
    try { cancellation = stop() } catch (error) { cancellation = Promise.reject(error) }
    const pending = Promise.allSettled([previousCleanup, launch, cancellation, ...this.actions]).then(async (results) => {
      const stopped = results[2]
      if (stopped.status === 'rejected') throw stopped.reason
      await afterStop?.()
    })
    // A replacement start waits for BOTH the old launch and its stop request.
    // There is no delayed stop callback left that could kill the replacement.
    this.cleanup = pending
    void pending.catch(() => {})
    return pending
  }

  exited(): void { this.revision++; this.active = false }
}
