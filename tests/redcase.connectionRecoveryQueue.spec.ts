import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { downloadImage } from '../src/imageLocalizer/imageDownloader'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('../src/imageLocalizer/imageDownloader', () => ({
  ...jest.requireActual('../src/imageLocalizer/imageDownloader'), downloadImage: jest.fn(),
}))
jest.mock('../src/attachmentLocalizer/attachmentDownloader', () => ({
  ...jest.requireActual('../src/attachmentLocalizer/attachmentDownloader'), downloadAttachment: jest.fn(),
}))
jest.mock('../src/settings/template', () => ({ render: () => 'assets' }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const START = Date.parse('2026-10-07T00:00:00Z')
beforeEach(() => { jest.useFakeTimers({ now: START }); jest.clearAllMocks() })
afterEach(() => jest.useRealTimers())

async function harness(kind: 'image' | 'attachment', count = 1) {
  const file = Object.assign(new TFile(), { path: 'note.md', basename: 'note' })
  const body = Array.from({ length: count }, (_, i) => kind === 'image'
    ? `![${i}](https://fixture.example/${i}.png)`
    : `📎 [${i}.pdf](https://fixture.example/${i}.pdf)`).join('\n')
  const vault = {
    getAbstractFileByPath: (path: string) => path === file.path ? file : null,
    read: jest.fn(async () => body),
    process: jest.fn(async (_file: TFile, fn: (s: string) => string) => fn(body)),
  }
  const store = new PendingLocalizeStore()
  const localizer = kind === 'image'
    ? new ImageLocalizer({ vault } as any, { attachmentFolder: 'assets', enablePngToJpeg: false } as any, undefined, store)
    : new AttachmentLocalizer({ vault } as any, { attachmentFolder: 'assets', folderDateFormat: 'yyyy-MM-dd', maxRetries: 0, retryDelay: 0 }, store)
  const download = (kind === 'image' ? downloadImage : downloadAttachment) as jest.Mock
  download.mockReset().mockResolvedValue({ success: false, connectionUnavailable: true })
  await localizer.enqueueFile(file)
  return { file, vault, store, localizer, download }
}

test.each(['image', 'attachment'] as const)('R7 %s: six connection failures still persist a four-second retry deadline', async kind => {
  const h = await harness(kind)
  for (let i = 1; i <= 6; i++) {
    if (i > 1 && h.localizer instanceof ImageLocalizer) await h.localizer.enqueuePendingRecords(() => h.file)
    expect(await h.localizer.processQueue()).toMatchObject({ failed: 1 })
    expect(h.store.get(h.file.path)).toMatchObject({ retryCount: i, nextAttemptAt: Date.now() + 4000 })
    await jest.advanceTimersByTimeAsync(4000)
  }
  expect(h.download).toHaveBeenCalledTimes(6)
})

test.each(['image', 'attachment'] as const)('R7 %s: mixed connection and HTTP failures keep normal backoff', async kind => {
  const h = await harness(kind, 2)
  h.download.mockResolvedValueOnce({ success: false, connectionUnavailable: true })
    .mockResolvedValueOnce({ success: false, error: 'HTTP 503' })
  await h.localizer.processQueue()
  expect(h.download).toHaveBeenCalledTimes(2)
  expect(h.store.get(h.file.path)!.nextAttemptAt).toBeGreaterThanOrEqual(START + 12000)
})

test.each(['image', 'attachment'] as const)('R7 %s: an unreadable note after a connection failure does not inherit fast retries', async kind => {
  const h = await harness(kind)
  await h.localizer.processQueue()
  if (h.localizer instanceof ImageLocalizer) await h.localizer.enqueuePendingRecords(() => h.file)
  h.vault.read.mockRejectedValue(new Error('disk unavailable'))
  await h.localizer.processQueue()
  expect(h.store.get(h.file.path)!.nextAttemptAt).toBeGreaterThanOrEqual(START + 24000)
  expect(h.download).toHaveBeenCalledTimes(1)
})

test.each(['image', 'attachment'] as const)('R7/U8 %s: a server retry deadline survives connection-only failure propagation', async kind => {
  const h = await harness(kind)
  h.download.mockResolvedValue({ success: false, connectionUnavailable: true, retryAt: START + 30000 })
  await h.localizer.processQueue()
  expect(h.store.get(h.file.path)!.nextAttemptAt).toBe(START + 30000)
})
