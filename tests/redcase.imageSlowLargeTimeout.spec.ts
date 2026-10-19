import { transferPool } from '../src/common/transfer/transferPool'
import { requestUrl } from 'obsidian'
import * as downloader from '../src/imageLocalizer/imageDownloader'
jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const request = requestUrl as jest.Mock
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80"/></svg>').buffer
const response = (data = svg) => ({ status: 200, text: '', headers: { 'content-type': 'image/svg+xml' }, arrayBuffer: data })
const later = (ms: number, result: any) => new Promise(resolve => setTimeout(() => resolve(result), ms))
beforeEach(() => { transferPool.clear(); request.mockReset(); jest.useFakeTimers() })
afterEach(() => { jest.useRealTimers() })

test('R1: a six-second valid image succeeds with one request', async () => {
  request.mockImplementation(() => later(6000, response()))
  const promise = downloader.downloadImage('https://slow.example.com/six.svg', 5, 0)
  await jest.advanceTimersByTimeAsync(90000)
  expect(await promise).toMatchObject({ success: true })
  expect(request).toHaveBeenCalledTimes(1)
})

test('R1: concurrent callers share the same physical URL request', async () => {
  request.mockImplementation(() => later(100, response()))
  const calls = [downloader.downloadImage('https://slow.example.com/shared.svg'), downloader.downloadImage('https://slow.example.com/shared.svg')]
  await jest.advanceTimersByTimeAsync(101)
  for (const result of await Promise.all(calls)) expect(result.success).toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
})

test('R1: an original response arriving while its fallback hangs is adopted', async () => {
  request.mockImplementationOnce(() => later(downloader.IMAGE_REQUEST_TIMEOUT_MS + 1000, response()))
    .mockImplementation(() => new Promise(() => {}))
  const result = downloader.downloadImage('https://pic.clipfx.app/late.svg', 5, 0)
  await jest.advanceTimersByTimeAsync(120000)
  expect(await result).toMatchObject({ success: true })
  expect(request.mock.calls.filter(([req]) => req.url === 'https://pic.clipfx.app/late.svg')).toHaveLength(1)
  expect(request.mock.calls.length).toBeLessThanOrEqual(2)
})

test('R1: known 3MiB image gets at least size/64KiBps plus 10s headroom', () => {
  const timeout = (downloader as any).imageRequestTimeoutMs?.(3 * 1024 * 1024)
  expect(timeout).toBeGreaterThanOrEqual(58000)
})

test('R1: incomplete late images never count as success', async () => {
  request.mockImplementationOnce(() => later(downloader.IMAGE_REQUEST_TIMEOUT_MS + 1000,
    response(new TextEncoder().encode('<svg>incomplete').buffer)))
    .mockImplementation(() => new Promise(() => {}))
  const result = downloader.downloadImage('https://pic.clipfx.app/corrupt-late.svg', 5, 0)
  await jest.advanceTimersByTimeAsync(120000)
  expect(await result).toMatchObject({ success: false, failureKind: 'transient' })
})

test('R1: a response arriving between retry rounds is reused without another download', async () => {
  request.mockImplementation(() => later(95000, response()))
  const first = downloader.downloadImage('https://slow.example.com/between.svg', 0, 0)
  await jest.advanceTimersByTimeAsync(90000)
  expect((await first).success).toBe(false)
  await jest.advanceTimersByTimeAsync(6000)
  expect(await downloader.downloadImage('https://slow.example.com/between.svg', 0, 0)).toMatchObject({ success: true })
  expect(request).toHaveBeenCalledTimes(1)
})
