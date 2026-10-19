import { TFile } from 'obsidian'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('../src/attachmentLocalizer/attachmentDownloader', () => ({
  downloadAttachment: jest.fn(),
  isRemoteAttachment: (url: string) => /^https?:/.test(url),
  parseAttachmentSizeBytes: () => undefined,
}))
jest.mock('../src/settings/template', () => ({ render: () => 'attachments' }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const download = downloadAttachment as jest.Mock

function harness() {
  const bodies = new Map<string, string>()
  const files = new Map<string, TFile>()
  const binaries = new Map<string, ArrayBuffer>()
  const store = { get: jest.fn(), upsert: jest.fn(), remove: jest.fn() }
  const vault = {
    read: async (f: TFile) => bodies.get(f.path)!,
    process: async (f: TFile, fn: (body: string) => string) => {
      bodies.set(f.path, fn(bodies.get(f.path)!))
    },
    getAbstractFileByPath: (p: string) => files.get(p) ?? null,
    createFolder: async () => {},
    readBinary: async (f: TFile) => binaries.get(f.path)!,
    createBinary: jest.fn(async (p: string, data: ArrayBuffer) => {
      if (files.has(p)) throw new Error('already exists')
      files.set(p, Object.assign(new TFile(), { path: p }))
      binaries.set(p, data)
    }),
  }
  const localizer = new AttachmentLocalizer({ vault } as any, {
    attachmentFolder: 'attachments', folderDateFormat: 'yyyy-MM-dd', maxRetries: 0, retryDelay: 0,
  }, store as any)
  const note = (p: string, url: string) => {
    const f = Object.assign(new TFile(), { path: p, basename: p.replace('.md', '') })
    bodies.set(p, `📎 [合同.pdf](${url})`)
    return f
  }
  return { localizer, bodies, binaries, vault, store, note }
}
const data = (value: number) => new Uint8Array([value, 2, 3]).buffer
beforeEach(() => download.mockReset())

test.each(['merge', 'overwrite'])('R2: %s path can receive a new attachment after success', async (mode) => {
  const h = harness()
  const file = h.note('same.md', 'https://example.com/first')
  download.mockResolvedValue({ success: true, data: data(1) })
  await h.localizer.enqueueFile(file)
  await h.localizer.processQueue()
  h.bodies.set(file.path, `${mode === 'merge' ? h.bodies.get(file.path) + '\n' : ''}📎 [新.pdf](https://example.com/second)`)
  expect(await h.localizer.enqueueFile(file)).toBe('enqueued')
  expect(h.store.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: file.path }))
  expect(await h.localizer.processQueue()).toMatchObject({ total: 1, succeeded: 1 })
  expect(h.bodies.get(file.path)).not.toContain('https://')
  expect(download).toHaveBeenCalledTimes(2)
})

test('R5: same filename uses exact bytes; identical content reuses the saved file', async () => {
  const h = harness()
  for (const [name, value] of [['a', 1], ['b', 4], ['c', 4]] as const) {
    download.mockResolvedValueOnce({ success: true, data: data(value) })
    await h.localizer.enqueueFile(h.note(`${name}.md`, `https://example.com/${name}`))
    expect(await h.localizer.processQueue()).toMatchObject({ succeeded: 1 })
    const target = h.bodies.get(`${name}.md`)!.match(/\[\[([^|]+)\|/)![1]
    expect(new Uint8Array(h.binaries.get(target)!)).toEqual(new Uint8Array(data(value)))
  }
  expect(h.binaries.size).toBe(2)
})

test('R9: a concurrent drain waits for the failed attachment and reports its real result', async () => {
  const h = harness()
  let release!: (value: any) => void
  download.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  download.mockResolvedValueOnce({ success: false, error: 'HTTP 503' })
  await h.localizer.enqueueFile(h.note('slow.md', 'https://example.com/slow'))
  const first = h.localizer.processQueue()
  while (!release) await Promise.resolve()
  await h.localizer.enqueueFile(h.note('failed.md', 'https://example.com/fail'))
  let settled = false
  const second = h.localizer.processQueue().then(result => { settled = true; return result })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  release({ success: true, data: data(1) })
  const result = await second
  expect(result).toEqual(await first)
  expect(result.failedFiles).toContain('failed.md')
  expect(download).toHaveBeenCalledTimes(2)
})

test('R2: both copies in dual-write mode accept a later attachment', async () => {
  const h = harness()
  download.mockResolvedValue({ success: true, data: data(1) })
  const files = [h.note('daily.md', 'https://example.com/first'), h.note('single.md', 'https://example.com/first')]
  for (const file of files) await h.localizer.enqueueFile(file)
  await h.localizer.processQueue()
  for (const file of files) {
    h.bodies.set(file.path, `${h.bodies.get(file.path)}\n📎 [new.pdf](https://example.com/second)`)
    expect(await h.localizer.enqueueFile(file)).toBe('enqueued')
  }
  expect(await h.localizer.processQueue()).toMatchObject({ total: 2, succeeded: 2 })
  for (const file of files) expect(h.bodies.get(file.path)).not.toContain('https://')
})

test('R9: work added as the previous drain finishes is included in the caller result', async () => {
  const h = harness()
  download.mockResolvedValueOnce({ success: true, data: data(1) })
  download.mockResolvedValue({ success: false, error: 'HTTP 503' })
  await h.localizer.enqueueFile(h.note('first.md', 'https://example.com/first'))
  let second: Promise<any> | undefined
  await h.localizer.processQueue(() => {
    if (second) return
    second = h.localizer.enqueueFile(h.note('late.md', 'https://example.com/late'))
      .then(() => h.localizer.processQueue())
  })
  expect((await second!).failedFiles).toContain('late.md')
  expect(download).toHaveBeenCalledTimes(2)
})
