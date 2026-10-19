export const LOCALIZATION_ROUND_MS = 90_000

export class LocalizationRoundExpired extends Error {
  constructor() { super('本轮本地化预算已用完，保留任务稍后续传') }
}

/** One wall-clock deadline shared by every note/object admitted to a drain. */
export class LocalizationRound {
  private listeners = new Set<() => void>()
  private timer: number
  readonly deadline: number
  constructor(durationMs = LOCALIZATION_ROUND_MS) {
    this.deadline = Date.now() + durationMs
    this.timer = window.setTimeout(() => { for (const listener of [...this.listeners]) listener() }, durationMs)
  }
  get expired(): boolean { return Date.now() >= this.deadline }
  subscribe(listener: () => void): () => void {
    if (this.expired) listener()
    else this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose(): void { window.clearTimeout(this.timer); this.listeners.clear() }
}

interface ObjectWork {
  note: object
  key?: string
  run: () => Promise<unknown>
  large: boolean
  started: boolean
  settled: boolean
  value?: unknown
  error?: unknown
  failed?: boolean
  waiters: Map<() => void, { round?: LocalizationRound; expire: () => void }>
}

/** Round-robin work across notes, with capacity reserved for a different note.
 * A round may stop waiting, but an active download/save retains its slot and
 * owner. The next round adopts that operation's small result (a saved path),
 * never starts a second writer or parks a large response in the byte cache.
 */
export class LocalizationWorkPool {
  private groups = new Map<object, ObjectWork[]>()
  private owned = new WeakMap<object, Map<string, ObjectWork>>()
  private active = new Map<object, number>()
  private count = 0
  private largeCount = 0
  private scheduled = false

  constructor(private readonly concurrency: number, private readonly perNote: number) {}

  run<T>(note: object, work: () => Promise<T>, expectedBytes = 0, options: { key?: string; round?: LocalizationRound; canReuse?: (value: T) => boolean } = {}): Promise<T> {
    if (options.round?.expired) return Promise.reject(new LocalizationRoundExpired())
    let job = options.key === undefined ? undefined : this.owned.get(note)?.get(options.key)
    if (job?.settled && !job.failed && options.canReuse && !options.canReuse(job.value as T)) {
      this.forget(job)
      job = undefined
    }
    if (!job) {
      job = { note, key: options.key, run: work, large: expectedBytes >= 20 * 1024 * 1024,
        started: false, settled: false, waiters: new Map() }
      if (options.key !== undefined) {
        const entries = this.owned.get(note) ?? new Map<string, ObjectWork>()
        entries.set(options.key, job)
        this.owned.set(note, entries)
      }
      const queue = this.groups.get(note) ?? []
      queue.push(job)
      this.groups.set(note, queue)
    }
    const owned = job
    return new Promise<T>((resolve, reject) => {
      let unsubscribe = () => {}
      const cleanup = () => { owned.waiters.delete(done); unsubscribe() }
      const expire = () => {
        cleanup()
        if (!owned.started && !owned.waiters.size) {
          const queue = this.groups.get(note)
          const index = queue?.indexOf(owned) ?? -1
          if (index >= 0) queue!.splice(index, 1)
          if (!queue?.length) this.groups.delete(note)
          this.forget(owned)
        }
        reject(new LocalizationRoundExpired())
      }
      const done = () => {
        if (options.round?.expired) { expire(); return }
        if (!owned.settled) return
        cleanup()
        this.forget(owned)
        if (owned.failed) reject(owned.error instanceof Error ? owned.error : new Error(String(owned.error)))
        else resolve(owned.value as T)
      }
      owned.waiters.set(done, { round: options.round, expire })
      if (options.round) unsubscribe = options.round.subscribe(expire)
      done()
      this.schedule()
    })
  }

  private forget(job: ObjectWork): void {
    if (job.key !== undefined && this.owned.get(job.note)?.get(job.key) === job) this.owned.get(job.note)!.delete(job.key)
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    void Promise.resolve().then(() => { this.scheduled = false; this.pump() })
  }

  private pump(): void {
    // After an OS background pause, the wall clock may expire before its
    // delayed timer fires. Do not start stale queued jobs in that window.
    for (const queue of [...this.groups.values()]) for (const job of [...queue]) {
      for (const waiter of [...job.waiters.values()]) if (waiter.round?.expired) waiter.expire()
    }
    while (this.count < this.concurrency) {
      const next = [...this.groups].find(([note, queue]) =>
        (this.active.get(note) ?? 0) < this.perNote && (!queue[0].large || this.largeCount === 0))
      if (!next) return
      const [note, queue] = next
      const job = queue.shift()!
      job.started = true
      this.groups.delete(note)
      // Move the remaining work to the tail for the next round.
      if (queue.length) this.groups.set(note, queue)
      this.count++
      if (job.large) this.largeCount++
      this.active.set(note, (this.active.get(note) ?? 0) + 1)
      void Promise.resolve().then(job.run).then(value => { job.value = value }, error => { job.error = error; job.failed = true }).then(() => {
        job.settled = true
        for (const done of [...job.waiters.keys()]) done()
      }).finally(() => {
        this.count--
        if (job.large) this.largeCount--
        const remaining = (this.active.get(note) ?? 1) - 1
        if (remaining) this.active.set(note, remaining)
        else this.active.delete(note)
        this.schedule()
      })
    }
  }
}

/** File reads/writes are independent; the shared object pool bounds downloads. */
export async function drainConcurrentNotes<T>(queue: {
  dequeue(): T | undefined
  subscribe(listener: () => void): () => void
}, process: (task: T) => Promise<void>): Promise<void> {
  const running = new Set<Promise<void>>()
  let wake: (() => void) | undefined
  const unsubscribe = queue.subscribe(() => wake?.())
  try {
    for (;;) {
      let task: T | undefined
      while ((task = queue.dequeue()) !== undefined) {
        const runningTask = process(task)
        running.add(runningTask)
        void runningTask.finally(() => running.delete(runningTask)).catch(() => {})
      }
      if (!running.size) return
      await Promise.race([...running, new Promise<void>(resolve => { wake = resolve })])
      wake = undefined
    }
  } finally { unsubscribe() }
}
