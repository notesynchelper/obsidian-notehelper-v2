import { transferPool } from '../src/common/transfer/transferPool'
/**
 * 工单（2026-09-24）：企微聊天记录里的 17.37MB PDF「AIDSO爱搜——生成式引擎优化（GEO）白皮书」
 * 同步完没有下载到本地，隔天右键「重新本地化」才成功。
 *
 * nginx 日志：relay-1 用 13s 把 18,216,083 字节完整发给了插件（MISS，urt=13.158），
 * relay-2 又完整发了一遍，但插件把两次都当成失败——附件单请求超时是照搬图片侧的 5s，
 * 大文件不可能 5s 下完；requestUrl 不能 abort，超时后请求照样在后台下完、结果被丢弃。
 * 失败任务只在内存队列里，重启 Obsidian 后就再也不会自动重试。
 * 次日重新本地化只拿到一个 304（浏览器缓存里早有完整文件）。
 */

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  requestUrl: jest.fn(),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { requestUrl } from 'obsidian'
import {
  downloadAttachment as downloadAttachmentActual,
  parseAttachmentSizeBytes,
} from '../src/attachmentLocalizer/attachmentDownloader'

// Routing/late-response fixtures represent mature objects. New and unknown
// objects have separate not-ready regression coverage.
const downloadAttachment: typeof downloadAttachmentActual = (url, retries, delay, options = {}) =>
  downloadAttachmentActual(url, retries, delay, {
    savedAt: new Date(Date.now() - 4 * 86400_000).toISOString(), ...options,
  })

const mockRequestUrl = requestUrl as jest.Mock

const PDF_URL =
  'https://media30d.clipfx.app/wecom4/2026/09/CiBmNzBkZDI0M2Q4Zjc2NGFj'
const PDF_BYTES = 18_216_083

function ok(bytes = 64) {
  const body = new Uint8Array(bytes)
  body.set(new TextEncoder().encode('%PDF-1.4\n'))
  body.set(new TextEncoder().encode('%%EOF\n'), bytes - 6)
  return {
    status: 200,
    text: '',
    headers: { 'content-type': 'application/pdf' },
    arrayBuffer: body.buffer,
  }
}

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

const never = () => new Promise<never>(() => {})

describe('parseAttachmentSizeBytes：附件行里的 (大小) 文本', () => {
  test.each([
    ['17.37MB', Math.round(17.37 * 1024 * 1024)],
    ['0.24MB', Math.round(0.24 * 1024 * 1024)],
    ['512KB', 512 * 1024],
    ['1.5 GB', Math.round(1.5 * 1024 * 1024 * 1024)],
    ['900B', 900],
  ])('%s → %d', (text, bytes) => {
    expect(parseAttachmentSizeBytes(text)).toBe(bytes)
  })

  test.each([undefined, '', '未知', 'MB'])('无法解析 %p → undefined', (text) => {
    expect(parseAttachmentSizeBytes(text)).toBeUndefined()
  })
})

describe('大附件下载超时', () => {
  beforeEach(() => {
    transferPool.clear()
    mockRequestUrl.mockReset()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  test('17.37MB 附件 13s 下完 → 成功，且只请求一次', async () => {
    mockRequestUrl.mockImplementationOnce(() => resolveAfter(13_000, ok(PDF_BYTES)))

    const p = downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: PDF_BYTES })
    await jest.advanceTimersByTimeAsync(14_000)

    await expect(p).resolves.toMatchObject({ success: true })
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('300MB 附件以 ~73KB/s 慢速 70 分钟下完 → 仍成功，只请求一次', async () => {
    mockRequestUrl.mockImplementationOnce(() => resolveAfter(70 * 60_000, ok(300 * 1024 * 1024)))

    const p = downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: 300 * 1024 * 1024 })
    await jest.advanceTimersByTimeAsync(71 * 60_000)

    await expect(p).resolves.toMatchObject({ success: true })
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('大小未知的附件也不能用 5s 的图片超时', async () => {
    mockRequestUrl.mockImplementationOnce(() => resolveAfter(13_000, ok()))

    const p = downloadAttachment(PDF_URL, 5, 1000)
    await jest.advanceTimersByTimeAsync(14_000)

    await expect(p).resolves.toMatchObject({ success: true })
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('超时后不重复请求同一地址；被放弃的请求晚到的成功要被采纳', async () => {
    // 小文件 → 超时下限；主线路超时后仍在后台下载，备用线路黑洞
    mockRequestUrl
      .mockImplementationOnce(() => resolveAfter(45_000, ok(1000)))
      .mockImplementation(never)

    const p = downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: 1000 })
    await jest.advanceTimersByTimeAsync(46_000)

    await expect(p).resolves.toMatchObject({ success: true })
    const primaryCalls = mockRequestUrl.mock.calls.filter((c) => c[0].url === PDF_URL)
    expect(primaryCalls).toHaveLength(1)
  })

  test('所有线路都黑洞 → 有界时间内失败返回，不永久挂起', async () => {
    mockRequestUrl.mockImplementation(never)

    let settled: unknown = null
    void downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: 1000 }).then((r) => {
      settled = r
    })
    await jest.advanceTimersByTimeAsync(10 * 60_000)

    expect(settled).toMatchObject({ success: false })
    expect(settled).not.toHaveProperty('expired', true)
  })

  test('源站超时后才返回 404 → 仍判真过期（不能因超时丢掉定论）', async () => {
    mockRequestUrl.mockImplementation((req: { url: string }) =>
      req.url === PDF_URL
        ? resolveAfter(31_000, { status: 404, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) })
        : Promise.resolve({ status: 404, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) }),
    )

    const p = downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: 1000 })
    await jest.advanceTimersByTimeAsync(32_000)

    await expect(p).resolves.toMatchObject({ success: false, expired: true })
  })

  test('源站超时后才以 reject(status 404) 返回 → 同样判真过期', async () => {
    mockRequestUrl.mockImplementation((req: { url: string }) =>
      req.url === PDF_URL
        ? new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request failed, status 404')), 31_000),
          )
        : Promise.resolve({ status: 404, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) }),
    )

    const p = downloadAttachment(PDF_URL, 5, 1000, { expectedBytes: 1000 })
    await jest.advanceTimersByTimeAsync(32_000)

    await expect(p).resolves.toMatchObject({ success: false, expired: true })
  })

  test('没有备用线路的普通地址超时后才返回 404 → 判真过期', async () => {
    const url = 'https://files.example.com/a.pdf'
    mockRequestUrl.mockImplementation(() =>
      resolveAfter(31_000, { status: 404, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) }),
    )

    const p = downloadAttachment(url, 5, 1000, { expectedBytes: 1000 })
    await jest.advanceTimersByTimeAsync(32_000)

    await expect(p).resolves.toMatchObject({ success: false, expired: true })
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })
})
