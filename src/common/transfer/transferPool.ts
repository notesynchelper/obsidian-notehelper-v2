import { HostHealth } from './hostHealth'
import { downloadResource, DownloadResponse, DownloadOptions } from './downloadResource'

export interface TransferTransport { key: string; options: Omit<DownloadOptions, 'url'> }
import { getFallbackUrls } from '../imageRelay'
import { headerValue } from '../transferIntegrity'
import { CONNECTION_RETRY_MS, isFailedConnection } from './connectionFailure'

export type TransferKind = 'image' | 'attachment'
export const MAX_TRANSFERS_PER_HOST = 4
const MAX_TRANSFERS = 12
const CACHE_BYTES = 32 * 1024 * 1024
const CACHE_ENTRIES = 32
const CACHE_AGE_MS = 120_000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

export interface TransferFlight {
  url: string
  kind: TransferKind
  objectKey: string
  host: string
  startedAt: number
  finishedAt?: number
  downloadScope?: string
  response?: DownloadResponse
  error?: Error
  timedOut?: boolean
  settled: boolean
  listeners: Set<() => void>
}

export class TransferCapacityError extends Error {
  constructor() { super('下载在途容量已满，保留任务稍后重试') }
}
export class TransferCooldownError extends Error {
  constructor(readonly retryAt: number, readonly connectionUnavailable = false) { super(connectionUnavailable ? '连接暂不可用，稍后重连' : '服务端要求稍后重试（Retry-After）') }
}
/** Only an explicit failure to establish connectivity permits a short retry.
 * TLS errors, resets during a body, timeouts and HTTP failures keep backoff. */
export function isConnectionUnavailable(error: unknown): boolean {
  if (error instanceof TransferCooldownError) return error.connectionUnavailable
  return isFailedConnection(error)
}
export class TransferTimeoutError extends Error {
  constructor(readonly flight: TransferFlight, ms: number) { super(`请求等待超时（${ms}ms），底层请求仍可复用`) }
}

function objectKey(url: string): string {
  return [url, ...getFallbackUrls(url)].sort().join('\n')
}

/** A timeout never releases an actual network slot. Only settlement does. */
export class TransferPool {
  readonly hostHealth = new HostHealth()
  private cooldowns = new Map<string, number>()
  private connectionCooldowns = new Map<string, number>()
  private connectionProbes = new Map<string, TransferFlight>()
  private flights = new Map<string, TransferFlight>()
  private observations = new Map<string, { bytes: number; bytesPerSecond: number }>()

  related(url: string, transport?: TransferTransport): TransferFlight[] {
    this.prune()
    const key = objectKey(url)
    return [...this.flights.values()].filter(f => f.objectKey === key && f.downloadScope === transport?.key)
  }

  acquire(url: string, kind: TransferKind, transport?: TransferTransport): TransferFlight {
    this.prune()
    const poolKey = JSON.stringify([url, transport?.key])
    const previous = this.flights.get(poolKey)
    if (previous) return previous
    const host = new URL(url).origin
    const key = objectKey(url)
    const active = [...this.flights.values()].filter(f => !f.settled)
    if (active.length >= MAX_TRANSFERS || active.filter(f => f.host === host).length >= MAX_TRANSFERS_PER_HOST ||
        active.filter(f => f.objectKey === key).length >= (kind === 'attachment' || active.some(f => f.objectKey === key && f.kind === 'attachment') ? 1 : 2)) {
      throw new TransferCapacityError()
    }
    const retryAt = this.retryAt(url)
    if (retryAt) throw new TransferCooldownError(retryAt, this.connectionCooldowns.has(host))
    if (!this.hostHealth.canStart(host)) throw new TransferCooldownError(this.hostHealth.retryAt(host) ?? Date.now() + 60000)
    const flight: TransferFlight = { downloadScope: transport?.key, url, kind, host, objectKey: key, startedAt: Date.now(), settled: false, listeners: new Set() }
    if (this.connectionCooldowns.has(host)) this.connectionProbes.set(host, flight)
    this.flights.set(poolKey, flight)
    // One network callback regardless of how many rounds/callers wait on it.
    void Promise.resolve().then(() => downloadResource({ ...(transport ? transport.options : { headers: { 'User-Agent': USER_AGENT } }), url }))
      .then(response => { flight.response = response }, error => { flight.error = error instanceof Error ? error : new Error(String(error)) })
      .then(() => {
        flight.settled = true
        flight.finishedAt = Date.now()
        this.observeRetryAfter(flight)
        const failed = !!flight.error || (flight.response?.status ?? 0) >= 500
        // Another request started before the outage may settle while this
        // host's probe is pending. Only that probe can release its own slot.
        if (this.connectionProbes.get(host) === flight) this.connectionProbes.delete(host)
        if (flight.error && isConnectionUnavailable(flight.error)) {
          this.connectionCooldowns.set(host, Date.now() + CONNECTION_RETRY_MS)
          if (this.connectionCooldowns.size > 256) {
            const oldest = this.connectionCooldowns.keys().next()
            if (!oldest.done) this.connectionCooldowns.delete(oldest.value)
          }
          // A server circuit already in half-open state must still settle its
          // probe. Otherwise new calls would wait forever on its probe flag.
          if (this.hostHealth.isProbing(host)) this.hostHealth.observe(host, true)
        } else {
          if (!this.connectionProbes.has(host)) this.connectionCooldowns.delete(host)
          if (!flight.timedOut || !failed) this.hostHealth.observe(host, failed)
        }
        for (const listener of [...flight.listeners]) listener()
        this.prune()
      })
    return flight
  }

  hostProbe(url: string): TransferFlight | undefined {
    const host = new URL(url).origin
    const connectionProbe = this.connectionProbes.get(host)
    if (connectionProbe) return connectionProbe
    if (!this.hostHealth.isProbing(host)) return undefined
    return [...this.flights.values()].find(flight => flight.host === host && !flight.settled)
  }

  async waitForProbe(flight: TransferFlight, timeoutMs: number): Promise<void> {
    if (flight.settled) return
    await new Promise<void>((resolve, reject) => {
      const done = () => { window.clearTimeout(timer); flight.listeners.delete(done); resolve() }
      const timer = window.setTimeout(() => {
        flight.listeners.delete(done)
        reject(new TransferCooldownError(this.retryAt(flight.url) ?? Date.now() + 60000))
      }, timeoutMs)
      flight.listeners.add(done)
      if (flight.settled) done()
    })
  }

  /** Wait for a real slot release, without adopting another object's body. */
  async waitForCapacity(timeoutMs: number): Promise<void> {
    const active = [...this.flights.values()].filter(flight => !flight.settled)
    if (!active.length) return
    await new Promise<void>((resolve, reject) => {
      const detach = () => {
        window.clearTimeout(timer)
        for (const flight of active) flight.listeners.delete(done)
      }
      const done = () => { detach(); resolve() }
      const timer = window.setTimeout(() => { detach(); reject(new TransferCapacityError()) }, Math.max(0, timeoutMs))
      for (const flight of active) flight.listeners.add(done)
      if (active.some(flight => flight.settled)) done()
    })
  }

  subscribe(flight: TransferFlight, listener: () => void): () => void {
    flight.listeners.add(listener)
    if (flight.settled) listener()
    return () => flight.listeners.delete(listener)
  }

  consume(flight: TransferFlight): void {
    if (flight.settled && this.flights.get(JSON.stringify([flight.url, flight.downloadScope])) === flight) this.flights.delete(JSON.stringify([flight.url, flight.downloadScope]))
  }

  recordSuccess(flight: TransferFlight): void {
    const bytes = flight.response?.bodySummary?.bytes ?? flight.response?.arrayBuffer.byteLength ?? 0
    if (!bytes) return
    const elapsed = Math.max(1, (flight.finishedAt ?? Date.now()) - flight.startedAt)
    const speed = bytes * 1000 / elapsed
    const prior = this.observations.get(flight.host)
    this.observations.set(flight.host, {
      bytes: prior ? prior.bytes * 0.75 + bytes * 0.25 : bytes,
      bytesPerSecond: prior ? prior.bytesPerSecond * 0.75 + speed * 0.25 : speed,
    })
    if (this.observations.size > 128) {
      const oldest = this.observations.keys().next()
      if (!oldest.done) this.observations.delete(oldest.value)
    }
  }

  imageTimeout(url: string, expectedBytes?: number): number {
    const seen = this.observations.get(new URL(url).origin)
    const bytes = expectedBytes && Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : seen?.bytes
    if (!bytes) return 25_000
    const speed = Math.min(64 * 1024, seen?.bytesPerSecond ?? 64 * 1024)
    return Math.min(60_000, Math.max(25_000, Math.ceil(10_000 + bytes * 1000 / Math.max(1, speed))))
  }

  retryAt(url: string): number | undefined {
    const host = new URL(url).origin
    const until = this.cooldowns.get(host)
    if (until && until <= Date.now()) this.cooldowns.delete(host)
    const connectionUntil = this.connectionProbes.has(host) ? Date.now() + CONNECTION_RETRY_MS : this.connectionCooldowns.get(host) ?? 0
    const latest = Math.max(until ?? 0, this.hostHealth.retryAt(host) ?? 0, connectionUntil)
    return latest > Date.now() ? latest : undefined
  }

  recordTimeout(flight: TransferFlight): void {
    if (flight.timedOut || flight.settled) return
    flight.timedOut = true
    this.hostHealth.observe(flight.host, true, true)
  }

  private observeRetryAfter(flight: TransferFlight): void {
    const response = flight.response
    if (!response || (response.status !== 429 && response.status !== 503)) return
    const value = headerValue(response.headers, 'retry-after')
    let until = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value)
    if (!Number.isFinite(until)) {
      if (response.status !== 429) return
      until = Date.now() + 30_000
    }
    if (until <= Date.now()) return
    this.cooldowns.set(flight.host, Math.max(until, this.cooldowns.get(flight.host) ?? 0))
    // Opportunistic cleanup instead of an idle interval.
    for (const [host, deadline] of this.cooldowns) if (deadline <= Date.now()) this.cooldowns.delete(host)
  }

  /** Explicit lifecycle reset; tests use a fresh pool between isolated hosts. */
  clear(): void {
    for (const flight of this.flights.values()) flight.listeners.clear()
    this.flights.clear()
    this.observations.clear()
    this.cooldowns.clear()
    this.connectionCooldowns.clear()
    this.connectionProbes.clear()
    this.hostHealth.clear()
  }

  private prune(): void {
    const completed = [...this.flights.values()].filter(f => f.settled)
    let bytes = completed.reduce((sum, f) => sum + (f.response?.arrayBuffer.byteLength ?? 0), 0)
    let count = completed.length
    // No idle timers: unclaimed late responses are bounded in bytes and count,
    // and expire on access. Active flights are never evicted as if cancelled.
    for (const flight of completed) {
      if (bytes <= CACHE_BYTES && count <= CACHE_ENTRIES && Date.now() - (flight.finishedAt ?? Date.now()) < CACHE_AGE_MS) continue
      this.flights.delete(JSON.stringify([flight.url, flight.downloadScope]))
      bytes -= flight.response?.arrayBuffer.byteLength ?? 0
      count--
    }
  }
}

export const transferPool = new TransferPool()

/** Shared late-result adoption with detachable observers and bounded waits. */
export class TransferSession<T> {
  private watched = new Map<TransferFlight, { outcome?: T; unsubscribe: () => void }>()
  private listeners = new Set<() => void>()
  private decisive: T | undefined

  constructor(
    private readonly evaluate: (flight: TransferFlight) => T,
    private readonly isDecisive: (outcome: T, url: string) => boolean,
    private readonly pool = transferPool,
    private readonly transport?: TransferTransport,
  ) {}

  get result(): T | undefined { return this.decisive }

  private watch(flight: TransferFlight): void {
    if (this.watched.has(flight)) return
    const entry: { outcome?: T; unsubscribe: () => void } = { unsubscribe: () => {} }
    this.watched.set(flight, entry)
    entry.unsubscribe = this.pool.subscribe(flight, () => {
      if (entry.outcome !== undefined) return
      entry.outcome = this.evaluate(flight)
      this.pool.consume(flight)
      if (this.decisive === undefined && this.isDecisive(entry.outcome, flight.url)) this.decisive = entry.outcome
      for (const notify of [...this.listeners]) notify()
    })
  }

  async request(url: string, kind: TransferKind, timeoutMs: number): Promise<T> {
    for (const flight of this.pool.related(url, this.transport)) this.watch(flight)
    if (this.decisive !== undefined) return this.decisive
    const probe = this.pool.hostProbe(url)
    if (probe && probe.url !== url) {
      const started = Date.now()
      await this.pool.waitForProbe(probe, timeoutMs)
      timeoutMs = Math.max(1, timeoutMs - (Date.now() - started))
    }
    const deadline = Date.now() + timeoutMs
    // Short responses frequently occupy the last host slot for only a few ms.
    // Give them up to 1s to settle; a genuinely stuck host still fails over.
    const capacityDeadline = Math.min(deadline, Date.now() + 1000)
    let flight: TransferFlight
    for (;;) {
      if (this.decisive !== undefined) return this.decisive
      try { flight = this.pool.acquire(url, kind, this.transport); break }
      catch (error) {
        if (!(error instanceof TransferCapacityError) || Date.now() >= capacityDeadline) throw error
        await this.pool.waitForCapacity(capacityDeadline - Date.now())
      }
    }
    timeoutMs = Math.max(1, deadline - Date.now())
    this.watch(flight)
    return new Promise<T>((resolve, reject) => {
      const finish = () => { window.clearTimeout(timer); this.listeners.delete(check) }
      const check = () => {
        const result = this.decisive ?? this.watched.get(flight)?.outcome
        if (result !== undefined) { finish(); resolve(result) }
      }
      const timer = window.setTimeout(() => { finish(); this.pool.recordTimeout(flight); reject(new TransferTimeoutError(flight, timeoutMs)) }, timeoutMs)
      this.listeners.add(check)
      check()
    })
  }

  async waitForOutcome(ms: number): Promise<T | undefined> {
    return new Promise(resolve => {
      const finish = () => { window.clearTimeout(timer); this.listeners.delete(check); resolve(this.decisive) }
      const check = () => {
        if (this.decisive !== undefined || [...this.watched.keys()].every(f => f.settled)) finish()
      }
      const timer = window.setTimeout(finish, Math.max(0, ms))
      this.listeners.add(check)
      check()
    })
  }

  dispose(): void {
    for (const entry of this.watched.values()) entry.unsubscribe()
    this.watched.clear()
    this.listeners.clear()
  }
}
