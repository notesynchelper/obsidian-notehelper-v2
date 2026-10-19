import { requestUrl, TFile, TFolder } from 'obsidian'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { transferPool } from '../src/common/transfer/transferPool'
import { cancelDownloads, downloadResource } from '../src/common/transfer/downloadResource'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import crypto from 'crypto'

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const native = requestUrl as jest.Mock
const originalFetch = global.fetch
let directory: string, vault: any, network: jest.Mock
const data = Buffer.alloc(512 * 1024 + 17, 0x71)
function response(body = data, headers: Record<string, string> = {}, status = 200) {
  let offset = 0
  const result = new Response(new ReadableStream({ pull(controller) {
    if (offset >= body.length) { controller.close(); return }
    const end = Math.min(offset + 333333, body.length)
    controller.enqueue(new Uint8Array(body.subarray(offset, end))); offset = end
  } }), { status, headers })
  result.arrayBuffer = jest.fn(() => { throw new Error('whole response buffering forbidden') })
  result.text = jest.fn(() => { throw new Error('whole response text forbidden') })
  return result
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notehelper-stream-test-'))
  const disk = (name: string) => path.join(directory, name)
  const exists = (name: string) => fs.existsSync(disk(name))
  vault = {
    configDir: '.obsidian',
    getAbstractFileByPath: (name: string) => !exists(name) ? null : Object.assign(fs.statSync(disk(name)).isDirectory() ? new TFolder() : new TFile(), { path: name }),
    createFolder: async (name: string) => { fs.mkdirSync(disk(name), { recursive: true }) },
    adapter: {
      exists: async (name: string) => exists(name),
      mkdir: async (name: string) => { fs.mkdirSync(disk(name), { recursive: true }) },
      stat: async (name: string) => exists(name) ? { size: fs.statSync(disk(name)).size, type: fs.statSync(disk(name)).isDirectory() ? 'folder' : 'file' } : null,
      writeBinary: jest.fn(async (name: string, bytes: ArrayBuffer) => { fs.writeFileSync(disk(name), new Uint8Array(bytes)) }),
      appendBinary: jest.fn(async (name: string, bytes: ArrayBuffer) => { fs.appendFileSync(disk(name), new Uint8Array(bytes)) }),
      rename: jest.fn(async (from: string, to: string) => { if (exists(to)) throw new Error('refuse overwrite'); fs.renameSync(disk(from), disk(to)) }),
      remove: async (name: string) => { fs.unlinkSync(disk(name)) },
      getResourcePath: (name: string) => 'local://' + name,
      readBinary: jest.fn(() => { throw new Error('whole file read forbidden') }),
    },
    readBinary: jest.fn(() => { throw new Error('whole vault read forbidden') }),
  }
  network = jest.fn(async () => response())
  global.fetch = jest.fn(async (url: any, options?: any) => String(url).startsWith('local://')
    ? new Response(Readable.toWeb(fs.createReadStream(disk(String(url).slice(8)), { highWaterMark: 13579 })) as any)
    : network(url, options)) as any
  native.mockReset().mockResolvedValue({ status: 200, text: '', headers: {}, arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
  transferPool.clear()
})
afterEach(() => { global.fetch = originalFetch; transferPool.clear(); fs.rmSync(directory, { recursive: true, force: true }) })
function download(name = 'file.bin', options: any = {}, url = 'https://example.com/file.bin') {
  return downloadAttachment(url, 0, 0, { ...options, streamTarget: { vault, folder: 'Attachments', fileName: name } } as any)
}
const files = () => fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, String(name))).isFile()).map(String)

test('mobile destination streams to disk with bounded writes and no native or full-body buffering', async () => {
  const result = await download()
  expect(result).toMatchObject({ success: true, localPath: 'Attachments/file.bin' })
  expect(result.data).toBeUndefined()
  expect(native).not.toHaveBeenCalled()
  expect(vault.adapter.appendBinary.mock.calls.length).toBeGreaterThan(1)
  expect(vault.adapter.appendBinary.mock.calls.every((call: any[]) => call[1].byteLength <= 256 * 1024)).toBe(true)
  expect(fs.readFileSync(path.join(directory, result.localPath!))).toEqual(data)
  expect(files()).toEqual(['Attachments/file.bin'])
})

test('same name A/B/B preserves A and reuses B by streaming exact comparison', async () => {
  const a = await download()
  const other = Buffer.from(new Uint8Array(data)); other[333334] ^= 1
  network.mockImplementation(async () => response(other))
  const b = await download(), again = await download()
  expect(a.localPath).toBe('Attachments/file.bin')
  expect(b.localPath).toBe(`Attachments/file-${crypto.createHash('md5').update(new Uint8Array(other)).digest('hex')}.bin`)
  expect(again.localPath).toBe(b.localPath)
  expect(fs.readFileSync(path.join(directory, a.localPath!))).toEqual(data)
  expect(fs.readFileSync(path.join(directory, b.localPath!))).toEqual(other)
  expect(files()).toHaveLength(2)
  expect(vault.adapter.readBinary).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
})

test.each([
  ['truncated content length', () => response(data, { 'Content-Length': String(data.length + 1) })],
  ['incomplete PDF', () => response(Buffer.from('%PDF-1.4\ntruncated'))],
  ['incomplete ZIP', () => response(Buffer.from([0x50, 0x4b, 3, 4, 0]))],
  ['login page', () => response(Buffer.from('<html>login</html>'), { 'Content-Type': 'text/html' })],
  ['empty response', () => response(Buffer.alloc(0))],
] as const)('%s never commits a partial/incorrect attachment', async (_name, make) => {
  network.mockImplementation(async () => make())
  expect(await download()).toMatchObject({ success: false })
  expect(files()).toEqual([])
  expect(native).not.toHaveBeenCalled()
})

test('CORS failure and missing append API do not fall back to native full-body buffering', async () => {
  network.mockRejectedValue(new TypeError('Failed to fetch'))
  expect(await download()).toMatchObject({ success: false })
  delete vault.adapter.appendBinary
  network.mockClear()
  expect(await download()).toMatchObject({ success: false })
  expect(network).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
  expect(files()).toEqual([])
})

test('streaming preserves not-ready and Retry-After classifications', async () => {
  network.mockImplementation(async () => response(Buffer.from('<Error><Code>NoSuchKey</Code></Error>'), {}, 404))
  expect(await download()).toMatchObject({ success: false, notReady: true })
  network.mockImplementation(async () => response(Buffer.from('busy'), { 'Retry-After': '30' }, 503))
  const result = await download()
  expect(result.success).toBe(false)
  expect(result.retryAt).toBeGreaterThan(Date.now() + 28000)
  expect(files()).toEqual([])
})

test('overlapping downloads to the same destination share one request and file commit', async () => {
  const [a, b] = await Promise.all([download(), download()])
  expect(a).toMatchObject({ success: true, localPath: 'Attachments/file.bin' })
  expect(b.localPath).toBe(a.localPath)
  expect(network).toHaveBeenCalledTimes(1)
  expect(files()).toEqual(['Attachments/file.bin'])
})

test('same URL with different destinations never adopts another folder result', async () => {
  const a = await download('a.bin'), b = await download('b.bin')
  expect(a.localPath).toBe('Attachments/a.bin')
  expect(b.localPath).toBe('Attachments/b.bin')
})

test('unload cancellation stops an in-progress stream and removes its partial file', async () => {
  const append = vault.adapter.appendBinary.getMockImplementation()
  vault.adapter.appendBinary.mockImplementation(async (...args: any[]) => { await append(...args); cancelDownloads(vault) })
  expect(await download()).toMatchObject({ success: false })
  expect(files()).toEqual([])
  expect(native).not.toHaveBeenCalled()
})

test('disk corruption is rejected before committing or replacing links', async () => {
  const append = vault.adapter.appendBinary.getMockImplementation()
  vault.adapter.appendBinary.mockImplementation(async (name: string, bytes: ArrayBuffer) => {
    const corrupted = bytes.slice(0); new Uint8Array(corrupted)[0] ^= 1
    await append(name, corrupted)
  })
  expect(await download()).toMatchObject({ success: false })
  expect(files()).toEqual([])
})

test('a disposed localizer cannot restart downloads in its remaining retry rounds', async () => {
  const lifetime = new AbortController(), append = vault.adapter.appendBinary.getMockImplementation()
  vault.adapter.appendBinary.mockImplementation(async (...args: any[]) => { await append(...args); lifetime.abort() })
  const result = await downloadAttachment('https://example.com/dispose.bin', 3, 0, {
    streamTarget: { vault, folder: 'Attachments', fileName: 'dispose.bin', signal: lifetime.signal },
  } as any)
  expect(result.success).toBe(false)
  expect(network).toHaveBeenCalledTimes(1)
  expect(files()).toEqual([])
})

test('incremental verification yields to UI timers instead of monopolizing the microtask queue', async () => {
  network.mockImplementation(async () => response(Buffer.alloc(8 * 1024 * 1024, 0x71)))
  let responsive = false
  const timer = setTimeout(() => { responsive = true }, 0)
  try {
    const result = await downloadResource({ url: 'https://example.com/verification.bin', stream: true })
    expect(result.bodySummary?.bytes).toBe(8 * 1024 * 1024)
    expect(responsive).toBe(true)
  } finally { clearTimeout(timer) }
})

test('a collision suffix competing with another original filename cannot overwrite either download', async () => {
  fs.mkdirSync(path.join(directory, 'Attachments'))
  fs.writeFileSync(path.join(directory, 'Attachments/file.bin'), new Uint8Array([1]))
  const other = Buffer.alloc(data.length, 0x72)
  const collisionName = `file-${crypto.createHash('md5').update(new Uint8Array(data)).digest('hex')}.bin`
  const contested = 'Attachments/' + collisionName
  const stat = vault.adapter.stat
  vault.adapter.stat = async (name: string) => {
    const observed = await stat(name)
    if (name === contested && !observed) await new Promise(resolve => setTimeout(resolve, 200))
    return observed
  }
  // Model filesystem rename semantics, where a preexisting destination can be
  // replaced: correctness must come from our commit coordination.
  vault.adapter.rename.mockImplementation(async (from: string, to: string) => fs.renameSync(path.join(directory, from), path.join(directory, to)))
  network.mockImplementation(async (url: string) => response(url.endsWith('/other.bin') ? other : data))
  const [first, second] = await Promise.all([
    download('file.bin', {}, 'https://example.com/first.bin'),
    download(collisionName, {}, 'https://example.com/other.bin'),
  ])
  expect(first.success && second.success).toBe(true)
  expect(first.localPath).not.toBe(second.localPath)
  expect(fs.readFileSync(path.join(directory, first.localPath!))).toEqual(data)
  expect(fs.readFileSync(path.join(directory, second.localPath!))).toEqual(other)
})
