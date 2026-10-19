import { PendingTaskRecord } from '../imageLocalizer/pendingQueueStore'
import { logError } from '../logger'
import { CONNECTION_RETRY_MS } from './transfer/connectionFailure'

const BACKOFF_MS = [15, 30, 60, 120, 300, 900, 1800, 3600, 7200, 14400, 21600].map(s => s * 1000)

/** Stable per-task jitter avoids restart-dependent changes to a pending deadline. */
export function nextLocalizationAttempt(filePath: string, attempt: number, now = Date.now(), serverRetryAt = 0, connectionOnlyFailure = false): number {
  if (connectionOnlyFailure) return Math.max(now + CONNECTION_RETRY_MS, serverRetryAt)
  let hash = 0
  for (const ch of `${filePath}:${attempt}`) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0
  const base = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, attempt - 1))]
  const delay = Math.round(base * (0.8 + (hash % 401) / 1000))
  return Math.max(now + delay, serverRetryAt)
}

export interface RetrySource {
  list(): PendingTaskRecord[]
  upsert(record: PendingTaskRecord): void
  subscribe(listener: () => void): () => void
}
interface SourceState { store: RetrySource; run: () => Promise<unknown>; unsubscribe: () => void; running: boolean; enabled: () => boolean }

/** One earliest-deadline timer; source drains may proceed independently. */
export class LocalizationRetryScheduler {
  private sources = new Map<RetrySource, SourceState>()
  private timer: number | null = null
  private timerAt = 0
  private visible = true
  private disposed = false

  constructor(private readonly debounceMs = 2000) {}

  watch(store: RetrySource, run: () => Promise<unknown>, enabled = () => true): void {
    if (this.disposed || this.sources.has(store)) return
    const state: SourceState = { store, run, enabled, running: false, unsubscribe: () => {} }
    // Older records have lastAttemptAt but no deadline. Restore their backoff
    // rather than granting a new attempt on every cold start.
    for (const record of store.list()) {
      if (record.nextAttemptAt === undefined && record.lastAttemptAt !== undefined && record.retryCount > 0) {
        store.upsert({ ...record, nextAttemptAt: nextLocalizationAttempt(record.filePath, record.retryCount, record.lastAttemptAt) })
      }
    }
    this.sources.set(store, state)
    state.unsubscribe = store.subscribe(() => this.kick('store'))
    this.kick('startup')
  }

  kick(_reason = 'timer'): void {
    if (this.disposed || !this.visible) return
    const deadlines = [...this.sources.values()].filter(source => !source.running && source.enabled())
      .flatMap(source => source.store.list().map(record => record.nextAttemptAt ?? 0))
    if (!deadlines.length) { this.cancelTimer(); return }
    const now = Date.now()
    const earliest = Math.min(...deadlines)
    const target = earliest <= now ? now + this.debounceMs : earliest
    // Coalesce bursts without postponing already-due work indefinitely.
    if (this.timer && (this.timerAt === target || (earliest <= now && this.timerAt >= now && this.timerAt <= target))) return
    this.cancelTimer()
    this.timerAt = target
    this.timer = window.setTimeout(() => { this.timer = null; this.runDue() }, Math.min(0x7fffffff, Math.max(0, target - now)))
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) this.cancelTimer()
    else this.kick('visible')
  }

  private runDue(): void {
    if (this.disposed || !this.visible) return
    const now = Date.now()
    for (const source of this.sources.values()) {
      if (source.running || !source.enabled()) continue
      const due = source.store.list().filter(record => (record.nextAttemptAt ?? 0) <= now)
      if (!due.length) continue
      const before = new Map(due.map(r => [r.filePath, { ...r }]))
      source.running = true
      void Promise.resolve().then(source.run).catch(error => {
        logError('本地化后台重试失败，保留待办', error)
      }).finally(() => {
        if (this.disposed) return
        // Reads/enqueue can fail before the localizer gets a task. Persist a
        // backoff for untouched work too; otherwise an unreadable file spins.
        for (const current of source.store.list()) {
          const prior = before.get(current.filePath)
          if (!prior || current.retryCount !== prior.retryCount || current.lastAttemptAt !== prior.lastAttemptAt || current.nextAttemptAt !== prior.nextAttemptAt) continue
          const retryCount = current.retryCount + 1
          source.store.upsert({ ...current, retryCount, lastAttemptAt: Date.now(), nextAttemptAt: nextLocalizationAttempt(current.filePath, retryCount) })
        }
        source.running = false
        this.kick('finished')
      })
    }
    this.kick('draining')
  }

  private cancelTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    for (const source of this.sources.values()) source.unsubscribe()
    this.sources.clear()
  }
}
