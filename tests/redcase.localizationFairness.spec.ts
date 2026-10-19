import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
function harness(kind: 'image' | 'attachment') {
  const bodies = new Map<string, string>()
  const vault = {
    getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
    read: async (f: TFile) => bodies.get(f.path)!,
    process: async (f: TFile, fn: (s: string) => string) => { const s = fn(bodies.get(f.path)!); bodies.set(f.path, s); return s },
  }
  const store = new PendingLocalizeStore()
  const localizer = kind === 'image'
    ? new ImageLocalizer({ vault } as any, { imageAttachmentFolder: 'images', enablePngToJpeg: false } as any, undefined, store)
    : new AttachmentLocalizer({ vault } as any, {} as any, store)
  let active = 0, peak = 0
  const releases: Array<() => void> = []
  jest.spyOn(localizer as any, kind === 'image' ? 'processImage' : 'processAttachment').mockImplementation(async (...args: any[]) => {
    const [object, file] = args
    active++; peak = Math.max(peak, active)
    if (file.path === 'slow.md') await new Promise<void>(resolve => releases.push(resolve))
    active--
    return kind === 'image' ? { status: 'ok', localPath: 'images/a.png' } : { replacement: `📎 [[attachments/${object.fileName}|${object.fileName}]]`, localized: true }
  })
  const add = async (name: string, count: number) => {
    const file = Object.assign(new TFile(), { path: name, basename: name })
    bodies.set(name, Array.from({ length: count }, (_, i) => kind === 'image'
      ? `![${i}](https://fixture.example/${name}/${i}.png)`
      : `📎 [${i}.pdf](https://fixture.example/${name}/${i}.pdf)`).join('\n'))
    await localizer.enqueueFile(file)
  }
  return { localizer, bodies, store, add, releases, peak: () => peak }
}

test.each(['image', 'attachment'] as const)('R8 %s: a healthy note completes while an older note is stalled, with global concurrency bounded', async kind => {
  const h = harness(kind)
  await h.add('slow.md', 6)
  const drain = h.localizer.processQueue()
  await flush()
  await h.add('healthy.md', 2)
  const joined = h.localizer.processQueue()
  await flush()
  const healthyCompleted = !h.bodies.get('healthy.md')!.includes('https:')
  for (let i = 0; i < 10; i++) { h.releases.splice(0).forEach(release => release()); await flush() }
  await drain; await joined
  expect(healthyCompleted).toBe(true)
  expect(h.peak()).toBeLessThanOrEqual(kind === 'image' ? 3 : 2)
  expect(h.store.list()).toHaveLength(0)
})

test('R8: a sync appending an image to an active note is revisited before its pending record is removed', async () => {
  const h = harness('image')
  await h.add('slow.md', 1)
  const task = (h.localizer as any).queue.getTasks()[0]
  const drain = h.localizer.processQueue()
  await flush()
  h.bodies.set('slow.md', h.bodies.get('slow.md') + '\n![new](https://fixture.example/new.png)')
  await h.localizer.enqueueFile(task.file)
  for (let i = 0; i < 10; i++) { h.releases.splice(0).forEach(release => release()); await flush() }
  await drain
  expect(h.bodies.get('slow.md')).not.toContain('https:')
  expect(h.store.list()).toHaveLength(0)
})

test('R8: appended images retain the newest sync metadata when the old operation succeeds', async () => {
  const h = harness('image')
  await h.add('slow.md', 1)
  const file = (h.localizer as any).queue.getTasks()[0].file
  await h.localizer.enqueueFile(file, { siteName: 'old source' })
  const drain = h.localizer.processQueue()
  await flush()
  h.bodies.set('slow.md', h.bodies.get('slow.md') + '\n![new](https://fixture.example/new.png)')
  await h.localizer.enqueueFile(file, { siteName: 'new source' })
  for (let i = 0; i < 10; i++) { h.releases.splice(0).forEach(release => release()); await flush() }
  await drain
  const calls = ((h.localizer as any).processImage as jest.Mock).mock.calls
  expect(calls.find(call => call[0].originalUrl === 'https://fixture.example/new.png')?.[2]).toMatchObject({ siteName: 'new source' })
  expect(h.store.list()).toHaveLength(0)
})

test.each(['image', 'attachment'] as const)('R8 %s: progress includes work arriving during the drain', async kind => {
  const h = harness(kind)
  const progress: Array<{ processed: number; total: number }> = []
  const unsubscribe = (h.localizer as any).subscribeProgress((value: { processed: number; total: number }) => progress.push(value))
  await h.add('slow.md', 6)
  const drain = h.localizer.processQueue()
  await flush()
  expect(progress.at(-1)).toEqual({ processed: 0, total: 6 })
  await h.add('healthy.md', 2)
  await flush()
  expect(progress.at(-1)).toEqual({ processed: 2, total: 8 })
  for (let i = 0; i < 10; i++) { h.releases.splice(0).forEach(release => release()); await flush() }
  await drain
  expect(progress.at(-1)).toEqual({ processed: 8, total: 8 })
  expect(progress.every(p => p.processed <= p.total)).toBe(true)
  unsubscribe()
})

test.each(['image', 'attachment'] as const)('R8 %s: the whole drain yields after 90s, and a late saved object is adopted without another download/write', async kind => {
  jest.useFakeTimers()
  try {
    const h = harness(kind)
    await h.add('slow.md', 1)
    const file = kind === 'image' ? (h.localizer as any).queue.getTasks()[0].file : (h.localizer as any).queue.listTasks()[0].file
    const processObject = (h.localizer as any)[kind === 'image' ? 'processImage' : 'processAttachment'] as jest.Mock
    let first: any, joined: any
    const a = h.localizer.processQueue().then(result => { first = result })
    const b = h.localizer.processQueue().then(result => { joined = result })
    await jest.advanceTimersByTimeAsync(90001)
    const yielded = first !== undefined && joined !== undefined
    const pendingAtDeadline = h.store.list().length
    // Finish the original operation after both callers have yielded. The
    // following round must adopt its saved path, including large attachments
    // whose bytes cannot be held in the transfer pool's small response cache.
    h.releases.splice(0).forEach(release => release())
    await flush()
    await a; await b
    await h.localizer.enqueueFile(file)
    const next = h.localizer.processQueue()
    await flush()
    h.releases.splice(0).forEach(release => release())
    await next
    expect(yielded).toBe(true)
    expect(pendingAtDeadline).toBe(1)
    expect(first).toMatchObject({ failed: 1, failedFiles: ['slow.md'] })
    expect(joined).toEqual(first)
    expect(processObject).toHaveBeenCalledTimes(1)
    expect(h.bodies.get('slow.md')).not.toContain('https:')
    expect(h.store.list()).toHaveLength(0)
  } finally { jest.useRealTimers() }
})

test.each(['image', 'attachment'] as const)('R8 %s: budget exhaustion does not report unvisited objects as processed', async kind => {
  jest.useFakeTimers()
  try {
    const h = harness(kind)
    let latest = { processed: 0, total: 0 }
    const unsubscribe = h.localizer.subscribeProgress(value => { latest = value })
    await h.add('slow.md', 20)
    const drain = h.localizer.processQueue()
    await jest.advanceTimersByTimeAsync(90001)
    await drain
    const atDeadline = { ...latest }
    h.releases.splice(0).forEach(release => release()); await flush()
    expect(atDeadline.total).toBe(20)
    expect(atDeadline.processed).toBeLessThanOrEqual(kind === 'image' ? 3 : 1)
    expect(h.store.list()).toHaveLength(1)
    unsubscribe()
  } finally { jest.useRealTimers() }
})
