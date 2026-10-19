import { requestUrl } from 'obsidian'
import { downloadImage } from '../src/imageLocalizer/imageDownloader'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { transferPool } from '../src/common/transfer/transferPool'
jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const request = requestUrl as jest.Mock
const START = Date.parse('2026-10-07T00:00:00Z')
beforeEach(() => { transferPool.clear(); request.mockReset(); jest.useFakeTimers({ now: START }) })
afterEach(() => jest.useRealTimers())

test.each([429, 503])('U8: %i Retry-After prevents all same-host image and attachment retries', async status => {
  request.mockResolvedValue({ status, text: '', headers: { 'Retry-After': '30' }, arrayBuffer: new ArrayBuffer(0) })
  const image = downloadImage('https://limited.example/a.png', 5, 0)
  await jest.advanceTimersByTimeAsync(100)
  expect((await image).success).toBe(false)
  const attachment = downloadAttachment('https://limited.example/b.pdf', 5, 0)
  await jest.advanceTimersByTimeAsync(100)
  expect((await attachment).success).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
  jest.setSystemTime(START + 29999)
  await downloadImage('https://limited.example/c.png', 5, 0)
  expect(request).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(1)
  request.mockResolvedValue({ status: 200, text: '', headers: {}, arrayBuffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer })
  expect((await downloadAttachment('https://limited.example/b.pdf', 0, 0)).success).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
})

test('U8: HTTP-date Retry-After also cools the host while other hosts remain usable', async () => {
  request.mockResolvedValueOnce({ status: 429, text: '', headers: { 'retry-after': new Date(START + 30000).toUTCString() }, arrayBuffer: new ArrayBuffer(0) })
    .mockResolvedValue({ status: 200, text: '', headers: {}, arrayBuffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer })
  await downloadAttachment('https://limited.example/a.pdf', 0, 0)
  expect((await downloadAttachment('https://healthy.example/a.pdf', 0, 0)).success).toBe(true)
  expect((await downloadAttachment('https://limited.example/b.pdf', 0, 0)).success).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)
  expect(jest.getTimerCount()).toBe(0)
})
