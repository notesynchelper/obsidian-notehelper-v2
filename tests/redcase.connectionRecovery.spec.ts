import { requestUrl } from 'obsidian'
import { downloadImage } from '../src/imageLocalizer/imageDownloader'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { transferPool, TransferPool, TransferCooldownError } from '../src/common/transfer/transferPool'
import { nextLocalizationAttempt } from '../src/common/localizationRetryScheduler'

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const request = requestUrl as jest.Mock
const START = Date.parse('2026-10-07T00:00:00Z')
beforeEach(() => { transferPool.clear(); request.mockReset(); jest.useFakeTimers({ now: START }) })
afterEach(() => { transferPool.clear(); jest.useRealTimers() })

const downloaders = [
  ['image', () => downloadImage('https://offline.example/file.png', 0, 0)],
  ['attachment', () => downloadAttachment('https://offline.example/file.pdf', 0, 0)],
] as const

test('R7: repeated failed connections keep a four-second recovery deadline while ordinary failures retain exponential backoff', () => {
  expect(nextLocalizationAttempt('note.md', 6, START, 0, true)).toBe(START + 4000)
  expect(nextLocalizationAttempt('note.md', 6, START)).toBeGreaterThanOrEqual(START + 720000)
})

test('R7/U8: fast connectivity retry still waits until a server permits it', () => {
  expect(nextLocalizationAttempt('note.md', 6, START, START + 30000, true)).toBe(START + 30000)
})

test.each(downloaders)('R7: %s reports a failed connection separately from an HTTP or content failure', async (_kind, download) => {
  request.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
  expect(await download()).toMatchObject({ success: false, connectionUnavailable: true })
  expect(request).toHaveBeenCalledTimes(1)
})

test.each(downloaders)('R7 Android: %s recognizes the native ConnectException captured in the real device experiment', async (_kind, download) => {
  request.mockRejectedValue(new Error('Request Failed. ConnectException Failed to connect to /127.0.0.1:32857'))
  expect(await download()).toMatchObject({ success: false, connectionUnavailable: true })
  expect(request).toHaveBeenCalledTimes(1)
})

test.each(downloaders)('R7 Android: %s native body timeouts keep ordinary backoff', async (_kind, download) => {
  request.mockRejectedValue(new Error('Request Failed. SocketTimeoutException Read timed out'))
  expect(await download()).not.toHaveProperty('connectionUnavailable', true)
})

test('R7: failed connections permit one host probe every four seconds, not one request per queued object', async () => {
  const pool = new TransferPool()
  request.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
  pool.acquire('https://offline.example/first.png', 'image')
  await jest.advanceTimersByTimeAsync(1)
  let blocked: unknown
  try { pool.acquire('https://offline.example/second.pdf', 'attachment') } catch (error) { blocked = error }
  await jest.advanceTimersByTimeAsync(1)
  expect(blocked).toBeInstanceOf(TransferCooldownError)
  expect(request).toHaveBeenCalledTimes(1)
  expect(pool.retryAt('https://offline.example/file')).toBe(START + 4000)
  await jest.advanceTimersByTimeAsync(3998)
  pool.acquire('https://offline.example/recovery.pdf', 'attachment')
  await jest.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(2)
  pool.clear()
})

test.each(downloaders)('R7: %s HTTP 503 must retain normal backoff instead of becoming a fast connection retry', async (_kind, download) => {
  request.mockResolvedValue({ status: 503, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) })
  expect(await download()).not.toHaveProperty('connectionUnavailable', true)
})

test.each(downloaders)('R7: %s TLS failures are not treated as a disconnected network', async (_kind, download) => {
  request.mockRejectedValue(new Error('net::ERR_CERT_AUTHORITY_INVALID'))
  expect(await download()).not.toHaveProperty('connectionUnavailable', true)
})

test('R7/U8: a concurrent connection failure never shortens a server Retry-After cooldown', async () => {
  const pool = new TransferPool()
  request.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    .mockResolvedValueOnce({ status: 429, text: '', headers: { 'Retry-After': '30' }, arrayBuffer: new ArrayBuffer(0) })
  pool.acquire('https://offline.example/connection.png', 'image')
  pool.acquire('https://offline.example/rate-limit.png', 'image')
  await jest.advanceTimersByTimeAsync(1)
  expect(pool.retryAt('https://offline.example/file')).toBe(START + 30000)
  expect(() => pool.acquire('https://offline.example/next.png', 'image')).toThrow(TransferCooldownError)
  expect(request).toHaveBeenCalledTimes(2)
  pool.clear()
})

test('R7: an older request settling cannot release a different in-flight connectivity probe', async () => {
  const pool = new TransferPool()
  let finishOlder!: (value: unknown) => void
  let finishProbe!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve }))
    .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    .mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve }))
  pool.acquire('https://offline.example/older.png', 'image')
  pool.acquire('https://offline.example/refused.png', 'image')
  await jest.advanceTimersByTimeAsync(4000)
  const probe = pool.acquire('https://offline.example/probe.png', 'image')
  await jest.advanceTimersByTimeAsync(1)
  const ok = { status: 200, headers: {}, arrayBuffer: new Uint8Array([1]).buffer }
  finishOlder(ok)
  await jest.advanceTimersByTimeAsync(1)
  expect(pool.hostProbe('https://offline.example/next.pdf')).toBe(probe)
  expect(() => pool.acquire('https://offline.example/next.pdf', 'attachment')).toThrow(TransferCooldownError)
  expect(request).toHaveBeenCalledTimes(3)
  finishProbe(ok)
  await jest.advanceTimersByTimeAsync(1)
  expect(pool.retryAt('https://offline.example/next.pdf')).toBeUndefined()
  pool.clear()
})
