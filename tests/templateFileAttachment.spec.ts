import { TFile, parseYaml } from 'obsidian'
import { prepareTemplateFileAttachment, withTemplateFileAttachment, scanTemplateFileAttachments } from '../src/common/templateFileAttachment'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { extractRemoteAttachmentUrls, hasLocalizationResidual } from '../src/sync/burnResidual'
import { ImageMode } from '../src/settings'
jest.mock('../src/attachmentLocalizer/attachmentDownloader', () => ({ downloadAttachment: jest.fn(), isRemoteAttachment: (url: string) => /^https?:/.test(url), parseAttachmentSizeBytes: () => undefined }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const source = 'https://files.example/file.pdf'
const reference = prepareTemplateFileAttachment({ url: source, folder: "Files/O'Brien & Sons", fileName: 'file.pdf', savedAt: '2026-10-07' }, 'revision-1')
const original = withTemplateFileAttachment(`---\nfile: ${reference.placeholder}\nuser: keep\n---\n![[${reference.placeholder}]]\nraw: ${reference.placeholder}`, reference)
function harness() {
  let content = original
  const files = new Map<string, TFile>(), bytes = new Map<string, ArrayBuffer>()
  const file = Object.assign(new TFile(), { path: 'file.md', basename: 'file' })
  const store = new PendingLocalizeStore()
  const vault = {
    read: async () => content,
    process: async (_f: TFile, change: (s: string) => string) => content = change(content),
    getAbstractFileByPath: (p: string) => files.get(p), createFolder: async () => {},
    createBinary: async (p: string, b: ArrayBuffer) => { files.set(p, Object.assign(new TFile(), { path: p })); bytes.set(p, b) },
    readBinary: async (f: TFile) => bytes.get(f.path),
  }
  const localizer = () => new AttachmentLocalizer({ vault } as any, { maxRetries: 0 } as any, store)
  return { file, store, bytes, localizer, read: () => content }
}
beforeEach(() => (downloadAttachment as jest.Mock).mockReset())
test('a FILE template survives a failed attempt and restart, then replaces every path only after verified download', async () => {
  const h = harness(), first = h.localizer()
  ;(downloadAttachment as jest.Mock).mockResolvedValue({ success: false, error: 'truncated' })
  expect(await first.enqueueFile(h.file)).toBe('enqueued')
  await first.processQueue()
  expect(h.read()).toBe(original)
  expect(h.bytes.size).toBe(0)
  expect(h.store.size).toBe(1)
  const next = h.localizer()
  next.resumePending(() => h.file)
  ;(downloadAttachment as jest.Mock).mockResolvedValue({ success: true, data: new Uint8Array([1, 2, 3]).buffer })
  expect(await next.processQueue()).toMatchObject({ succeeded: 1 })
  const target = [...h.bytes.keys()][0]
  expect(target).toBe("Files/O'Brien & Sons/file.pdf")
  expect(h.read()).not.toContain('notehelper-file:')
  expect(h.read()).not.toContain('notehelper-pending/')
  expect(h.read()).toContain(`![[${target}]]`)
  expect(h.read()).toContain(`raw: ${target}`)
  expect(parseYaml(h.read().split('---')[1])).toEqual({ file: target, user: 'keep' })
  expect(h.store.size).toBe(0)
})
test('burn-after-reading recognizes a pending FILE path even though its source is stored in an encoded descriptor', () => {
  const record = { originalImageUrls: [], originalAttachmentUrls: extractRemoteAttachmentUrls(original) }
  expect(hasLocalizationResidual(original, record, ImageMode.REMOTE)).toBe(true)
})
test('descriptors are durable, version-specific and cannot escape the vault', () => {
  expect(scanTemplateFileAttachments(original)).toHaveLength(1)
  expect(prepareTemplateFileAttachment({ ...reference, folder: '../outside' }, 'x').placeholder).not.toBe(reference.placeholder)
  const unsafe = withTemplateFileAttachment(original, { ...reference, folder: '../outside' })
  expect(scanTemplateFileAttachments(unsafe)).toHaveLength(1)
})
