import { requestUrl, TFile } from 'obsidian'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
jest.mock('../src/settings/template', () => ({ render: () => 'attachments' }))
const now = Date.parse('2026-10-07T00:00:00Z')
const url = 'https://example.com/wecom4/file'
const request = requestUrl as jest.Mock
beforeEach(() => {
  request.mockReset().mockResolvedValue({ status: 404, text: '<Code>NoSuchKey</Code>', headers: {}, arrayBuffer: new ArrayBuffer(0) })
  jest.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => jest.restoreAllMocks())

test.each([undefined, new Date(now - 120_000).toISOString()])('R3: missing recent/unknown object retains retryability (%s)', async savedAt => {
  const result = await downloadAttachment(url, 0, 0, { savedAt } as any)
  expect(result).toMatchObject({ success: false, notReady: true })
  expect(result.expired).not.toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
})

test('R3: four-day-old attachment with authoritative 404 is expired', async () => {
  expect(await downloadAttachment(url, 0, 0, { savedAt: new Date(now - 4 * 86400_000).toISOString() } as any))
    .toMatchObject({ success: false, expired: true })
})

test('R3: unknown age can expire only after repeated 404s plus wall clock floor', async () => {
  expect(await downloadAttachment(url, 0, 0, {
    firstNotFoundAt: now - 2 * 3600_000, notFoundRounds: 5,
  } as any)).toMatchObject({ expired: true })
})

test('R3: localizer persists missing history, never marks a new object expired, then recovers', async () => {
  let body = `📎 [file.pdf](${url})`
  const file = Object.assign(new TFile(), { path: 'note.md', basename: 'note' })
  const vault = {
    read: async () => body,
    process: async (_f: TFile, fn: (s: string) => string) => { body = fn(body) },
    getAbstractFileByPath: () => null, createFolder: async () => {}, createBinary: jest.fn(),
  }
  const store = new PendingLocalizeStore()
  const localizer = new AttachmentLocalizer({ vault } as any, {
    attachmentFolder: 'attachments', folderDateFormat: 'yyyy', maxRetries: 0, retryDelay: 0,
  }, store)
  await localizer.enqueueFile(file)
  await localizer.processQueue()
  expect(body).not.toContain('⚠️')
  expect(store.get(file.path)).toMatchObject({ missingAttachments: {
    [url]: { firstNotFoundAt: now, notFoundRounds: 1 },
  } })
  request.mockResolvedValue({ status: 200, text: '', headers: {}, arrayBuffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer })
  await localizer.processQueue()
  expect(body).toContain('[[attachments/file.pdf|file.pdf]]')
  expect(store.get(file.path)).toBeUndefined()
})

function maturePending() {
  let body = `📎 [file.pdf](${url})`
  const file = Object.assign(new TFile(), { path: 'manual.md', basename: 'manual' })
  const store = new PendingLocalizeStore()
  store.upsert({ filePath: file.path, createdAt: now - 3 * 3600_000, retryCount: 5,
    nextAttemptAt: now + 3600_000,
    missingAttachments: { [url]: { firstNotFoundAt: now - 3 * 3600_000, notFoundRounds: 5 } } })
  const vault = { read: async () => body,
    process: async (_f: TFile, fn: (s: string) => string) => { body = fn(body) } }
  const localizer = new AttachmentLocalizer({ vault } as any, {
    attachmentFolder: 'attachments', folderDateFormat: 'yyyy', maxRetries: 0, retryDelay: 0,
  }, store)
  return { file, store, localizer, body: () => body }
}

test.each([false, true])('R3: explicit retry resets persisted and queued missing history (queued=%s)', async queued => {
  const h = maturePending()
  if (queued) await h.localizer.enqueueFile(h.file)
  await h.localizer.enqueueFile(h.file, undefined, { resetNotFoundBudget: true })
  expect(h.store.get(h.file.path)?.nextAttemptAt).toBeUndefined()
  await h.localizer.processQueue()
  expect(h.body()).not.toContain('⚠️')
  expect(h.store.get(h.file.path)?.missingAttachments?.[url]).toEqual({ firstNotFoundAt: now, notFoundRounds: 1 })
})

test('R3: ordinary sync preserves mature missing history', async () => {
  const h = maturePending()
  await h.localizer.enqueueFile(h.file)
  await h.localizer.processQueue()
  expect(h.body()).toContain('⚠️已过期')
  expect(h.store.get(h.file.path)).toBeUndefined()
})

test('R3: explicit retry during an active old 404 cannot inherit its terminal verdict', async () => {
  const h = maturePending()
  let release!: (response: any) => void
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await h.localizer.enqueueFile(h.file)
  const draining = h.localizer.processQueue()
  while (!release) await Promise.resolve()
  await h.localizer.enqueueFile(h.file, undefined, { resetNotFoundBudget: true })
  release({ status: 404, text: '<Code>NoSuchKey</Code>', headers: {}, arrayBuffer: new ArrayBuffer(0) })
  await draining
  expect(h.body()).not.toContain('⚠️')
  expect(h.store.get(h.file.path)?.missingAttachments?.[url]).toEqual({ firstNotFoundAt: now, notFoundRounds: 1 })
})
