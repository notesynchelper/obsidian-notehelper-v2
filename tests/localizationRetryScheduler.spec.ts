import { LocalizationRetryScheduler, RetrySource } from '../src/common/localizationRetryScheduler'
import { PendingTaskRecord } from '../src/imageLocalizer/pendingQueueStore'
jest.mock('../src/logger', () => ({ logError: jest.fn(), log: jest.fn() }))
class Store implements RetrySource {
  records = new Map<string, PendingTaskRecord>()
  listeners = new Set<() => void>()
  list() { return [...this.records.values()] }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  upsert(r: PendingTaskRecord) { this.records.set(r.filePath, r); this.listeners.forEach(cb => cb()) }
  remove(p: string) { this.records.delete(p); this.listeners.forEach(cb => cb()) }
}
const rec = (filePath = 'note.md', nextAttemptAt = 1000) => ({ filePath, nextAttemptAt, createdAt: 0, retryCount: 1, lastAttemptAt: 0 })
beforeEach(() => jest.useFakeTimers({ now: 0 }))
afterEach(() => jest.useRealTimers())

test('R7: persisted deadline retries without any subsequent sync or event, then becomes idle', async () => {
  const store = new Store(); store.upsert(rec())
  const scheduler = new LocalizationRetryScheduler(0)
  const run = jest.fn(async () => store.remove('note.md'))
  scheduler.watch(store, run)
  await jest.advanceTimersByTimeAsync(999)
  expect(run).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
  scheduler.dispose()
})

test('R7: online/visible/startup kicks cannot burn through a persisted backoff', async () => {
  const store = new Store(); store.upsert(rec())
  const scheduler = new LocalizationRetryScheduler(0)
  const run = jest.fn(async () => { store.upsert({ ...rec(), retryCount: 2, lastAttemptAt: Date.now(), nextAttemptAt: 3000 }) })
  scheduler.watch(store, run)
  for (const event of ['startup', 'online', 'visible', 'sync']) scheduler.kick(event)
  await jest.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 10; i++) scheduler.kick('online')
  await jest.advanceTimersByTimeAsync(1999)
  expect(run).toHaveBeenCalledTimes(1)
  scheduler.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('R7: hidden apps have no scheduler timers; becoming visible retries overdue work once', async () => {
  const store = new Store(); store.upsert(rec())
  const scheduler = new LocalizationRetryScheduler(0)
  const run = jest.fn(async () => store.remove('note.md'))
  scheduler.watch(store, run)
  scheduler.setVisible(false)
  expect(jest.getTimerCount()).toBe(0)
  await jest.advanceTimersByTimeAsync(2000)
  expect(run).not.toHaveBeenCalled()
  scheduler.setVisible(true)
  await jest.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  scheduler.dispose()
  expect(store.listeners.size).toBe(0)
})

test('R7: one slow source does not hold back the other source retry deadline', async () => {
  const images = new Store(); images.upsert(rec('image.md', 0))
  const attachments = new Store(); attachments.upsert(rec('attachment.md', 1000))
  const scheduler = new LocalizationRetryScheduler(0)
  let resolve!: () => void
  const slow = jest.fn(() => new Promise<void>(done => { resolve = done }))
  const fast = jest.fn(async () => attachments.remove('attachment.md'))
  scheduler.watch(images, slow); scheduler.watch(attachments, fast)
  await jest.advanceTimersByTimeAsync(1001)
  expect(slow).toHaveBeenCalledTimes(1)
  expect(fast).toHaveBeenCalledTimes(1)
  images.remove('image.md'); resolve(); await Promise.resolve()
  scheduler.dispose()
})

test('R7: unexpected worker errors retain and postpone the task, never create a busy loop', async () => {
  const store = new Store(); store.upsert(rec('note.md', 0))
  const scheduler = new LocalizationRetryScheduler(0)
  const run = jest.fn(async () => { throw new Error('disk temporarily unavailable') })
  scheduler.watch(store, run)
  await jest.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(1)
  expect(store.list()[0].nextAttemptAt).toBeGreaterThanOrEqual(24000)
  scheduler.dispose()
})
