/**
 * 死图（404/410）有界预算 —— 2026-08-26 doc-bridge R2 生命周期事故的客户端收敛。
 *
 * 事故形态：doc-bridge 的 R2 桶被一条 48h 生命周期规则把本该永久存在的
 * `img/<job>/<idx>` 一起删了，某用户云空间里 591 个图片链接全部 404。
 * 下载层其实早就把 404 分类成 not-found，但这个分类在 processImage 里退化成
 * `string | null`，上层无从区分「永久死」与「图床暂时没好」，于是 drainQueue
 * 那条「绝不丢弃」的规则把死图也当瞬态永久重试 —— 每次同步都要把 591 张死图
 * 重打一遍（且整个图片阶段是被 await 的），整体同步被一直拖住。
 *
 * 本文件钉住修复后的三条语义：
 *   1. 分类不再丢失：downloadImage → processImage → localizeFile → drainQueue 全链路透传；
 *   2. 死图走【有界】预算：连续 NOT_FOUND_ROUND_BUDGET 轮只剩死图 → 退休（清续传记录），
 *      且正文里的原始远程链接【原样保留】（数据永不丢）；
 *   3. 瞬态维持现状：永久重试、绝不丢弃（Defect B），并且任何一次瞬态失败都会把
 *      死图预算清零 —— 瞬态永远不消耗死图预算。
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
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))

import { requestUrl, TFile } from 'obsidian'
import {
  downloadImage,
  MAX_IMAGE_DOWNLOAD_RETRIES,
} from '../src/imageLocalizer/imageDownloader'
import {
  ImageLocalizer,
  NOT_FOUND_ROUND_BUDGET,
} from '../src/imageLocalizer/imageLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { emptyFileLocalizeOutcome } from '../src/imageLocalizer/types'

const mockRequestUrl = requestUrl as jest.Mock

/** 事故里真实的形状：doc-bridge 是权威源站，没有任何备用线路。 */
const DEAD_URL = 'https://doc.clipfx.app/doc-img/job-1/0'
/** 有备用线路的形状：relay 族。 */
const RELAY_URL = 'https://relay-1.bijitongbu.site/p/deadbeef.png'

function pngResponse() {
  // 完整 1x1 PNG（含 IEND），否则会被完整性校验判成截断。
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    ),
    (c) => c.charCodeAt(0),
  )
  return {
    status: 200,
    text: '',
    headers: { 'content-type': 'image/png' },
    arrayBuffer: bytes.buffer,
  }
}

function statusResponse(status: number) {
  return {
    status,
    text: 'nope',
    headers: { 'content-type': 'text/plain' },
    arrayBuffer: new ArrayBuffer(0),
  }
}

// ============================================================
// 1. 下载层：failureKind 分类
// ============================================================
describe('downloadImage 的 failureKind 分类', () => {
  beforeEach(() => jest.clearAllMocks())

  test('权威源站 404 → not-found，且不浪费重试预算', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const r = await downloadImage(DEAD_URL, MAX_IMAGE_DOWNLOAD_RETRIES, 0)
    expect(r.success).toBe(false)
    expect(r.failureKind).toBe('not-found')
    // 无备用线路 + 权威源站 → 一次就定案，不该把 5 次重试烧完
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('410 与 404 同等对待', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(410))
    await expect(downloadImage(DEAD_URL, 1, 0)).resolves.toMatchObject({
      failureKind: 'not-found',
    })
  })

  test('5xx / 超时 / 坏包一律 transient（绝不误判死刑）', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(503))
    await expect(downloadImage(DEAD_URL, 1, 0)).resolves.toMatchObject({
      failureKind: 'transient',
    })

    jest.clearAllMocks()
    mockRequestUrl.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'))
    await expect(downloadImage(DEAD_URL, 1, 0)).resolves.toMatchObject({
      failureKind: 'transient',
    })

    jest.clearAllMocks()
    // HTTP 200 但 body 是图床 warming 占位 HTML —— 这是「图床暂时没好」，
    // 必须是 transient，否则 image-relay-not-ready-resync 那条链路会被误杀。
    mockRequestUrl.mockResolvedValue({
      status: 200,
      text: '',
      headers: { 'content-type': 'text/html' },
      arrayBuffer: Uint8Array.from('<!DOCTYPE html><html>warming', (c) =>
        c.charCodeAt(0),
      ).buffer,
    })
    await expect(downloadImage(DEAD_URL, 1, 0)).resolves.toMatchObject({
      failureKind: 'transient',
    })
  })

  test('单个 relay 404 但别的节点有货 → 成功（不判 not-found）', async () => {
    mockRequestUrl.mockImplementation(async ({ url }: { url: string }) =>
      url.includes('relay-1') ? statusResponse(404) : pngResponse(),
    )
    const r = await downloadImage(RELAY_URL, 2, 0)
    expect(r.success).toBe(true)
    expect(r.failureKind).toBeUndefined()
  })

  test('所有线路都 404 才判 not-found；有一路是瞬态失败则保持 transient', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    await expect(downloadImage(RELAY_URL, 1, 0)).resolves.toMatchObject({
      failureKind: 'not-found',
    })

    jest.clearAllMocks()
    mockRequestUrl.mockImplementation(async ({ url }: { url: string }) =>
      url.includes('relay-1') ? statusResponse(404) : statusResponse(500),
    )
    await expect(
      downloadImage(RELAY_URL, MAX_IMAGE_DOWNLOAD_RETRIES, 0),
    ).resolves.toMatchObject({ failureKind: 'transient' })
  })
})

// ============================================================
// 2. 本地化层：分类透传 + 有界预算
// ============================================================
describe('死图有界预算（drainQueue）', () => {
  const NOTE = 'Synced/dead.md'
  const BODY = `# t\n\n![a](${DEAD_URL})\n`

  function makeFile(path = NOTE): TFile {
    const f = new TFile()
    f.path = path
    f.basename = path.replace(/\.md$/, '').split('/').pop() || ''
    return f
  }

  function build(body = BODY) {
    const store = new PendingLocalizeStore()
    const written: string[] = []
    const vault = {
      read: jest.fn().mockResolvedValue(body),
      modify: jest.fn(async (_f: unknown, data: string) => {
        written.push(data)
      }),
      process: jest.fn(async (f: unknown, fn: (c: string) => string) => {
        const out = fn(await vault.read(f))
        written.push(out)
        return out
      }),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(),
      createFolder: jest.fn(),
    }
    const localizer = new ImageLocalizer(
      { vault } as any,
      {
        enablePngToJpeg: false,
        jpegQuality: 85,
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 1,
        retryDelay: 0,
      },
      undefined,
      store,
    )
    return { localizer, store, vault, written }
  }

  /** 跑一轮完整的「重挂续传 → drain」，等价于用户的一次同步。 */
  async function runRound(localizer: ImageLocalizer, file: TFile) {
    await localizer.enqueuePendingRecords((p) => (p === file.path ? file : null), 0)
    return localizer.processQueue()
  }

  beforeEach(() => jest.clearAllMocks())

  test('localizeFile 把 not-found 分类回填给上层（不再退化成 null）', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer } = build()
    const outcome = emptyFileLocalizeOutcome()

    const ok = await localizer.localizeFile(makeFile(), undefined, outcome)

    expect(ok).toBe(false)
    expect(outcome.hasNotFound).toBe(true)
    expect(outcome.hasTransient).toBe(false)
    expect(outcome.notFoundUrls).toEqual([DEAD_URL])
  })

  test('瞬态失败回填 transient（预算不该被它消耗）', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(503))
    const { localizer } = build()
    const outcome = emptyFileLocalizeOutcome()

    await localizer.localizeFile(makeFile(), undefined, outcome)

    expect(outcome.hasTransient).toBe(true)
    expect(outcome.hasNotFound).toBe(false)
  })

  test(`连续 ${NOT_FOUND_ROUND_BUDGET} 轮全是死图 → 退休：前几轮保留续传，最后一轮清除`, async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer, store, written } = build()
    const file = makeFile()

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 第 1 轮必须仍在续传清单里、且【已结算】(retryCount>=1 + lastAttemptAt)
    // —— image-dead-object-blocks-queue 真机用例钉的就是这条。
    expect(store.get(NOTE)).toMatchObject({ retryCount: 1, notFoundRounds: 1 })
    expect(Number.isFinite(store.get(NOTE)?.lastAttemptAt)).toBe(true)

    for (let round = 2; round < NOT_FOUND_ROUND_BUDGET; round++) {
      await runRound(localizer, file)
      expect(store.get(NOTE)).toMatchObject({ notFoundRounds: round })
    }

    // 最后一轮：预算耗尽 → 退休
    const result = await runRound(localizer, file)
    expect(store.get(NOTE)).toBeUndefined()
    // 退休 ≠ 谎报成功：仍如实计入 failed，右键入口的提示不会说假话
    expect(result.failedFiles).toContain(NOTE)
    expect(result.succeeded).toBe(0)
    // 正文里的原始远程链接必须原样保留（数据永不丢）
    for (const out of written) expect(out).toContain(DEAD_URL)
  })

  test('退休后不再自动重挂 —— 整体同步不会再被死图拖住', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer, store } = build()
    const file = makeFile()

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    for (let round = 2; round <= NOT_FOUND_ROUND_BUDGET; round++) {
      await runRound(localizer, file)
    }
    expect(store.get(NOTE)).toBeUndefined()

    const callsBefore = mockRequestUrl.mock.calls.length
    const after = await runRound(localizer, file)

    expect(after.total).toBe(0)
    expect(mockRequestUrl.mock.calls.length).toBe(callsBefore)
  })

  test('用户右键「重新本地化」给全新预算：源站补回来了能自愈', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer, store, written } = build()
    const file = makeFile()

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    for (let round = 2; round <= NOT_FOUND_ROUND_BUDGET; round++) {
      await runRound(localizer, file)
    }
    expect(store.get(NOTE)).toBeUndefined()

    // 图补回来了 + 用户显式右键重新本地化
    mockRequestUrl.mockResolvedValue(pngResponse())
    localizer.clearProcessedMark(NOTE)
    await localizer.enqueueFile(file)
    const result = await localizer.processQueue()

    expect(result.succeeded).toBe(1)
    expect(written[written.length - 1]).not.toContain(DEAD_URL)
  })

  test('瞬态失败永久重试且把死图预算清零（Defect B 一字未动）', async () => {
    const { localizer, store } = build()
    const file = makeFile()

    // 前 N-1 轮全是死图，预算快耗尽
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    await localizer.enqueueFile(file)
    await localizer.processQueue()
    for (let round = 2; round < NOT_FOUND_ROUND_BUDGET; round++) {
      await runRound(localizer, file)
    }
    expect(store.get(NOTE)?.notFoundRounds).toBe(NOT_FOUND_ROUND_BUDGET - 1)

    // 这一轮变成瞬态失败（图床抽风）→ 预算清零
    mockRequestUrl.mockResolvedValue(statusResponse(503))
    await runRound(localizer, file)
    expect(store.get(NOTE)?.notFoundRounds).toBe(0)

    // 之后无论多少轮瞬态失败，都【绝不】退休
    for (let i = 0; i < NOT_FOUND_ROUND_BUDGET * 2; i++) {
      await runRound(localizer, file)
    }
    expect(store.get(NOTE)).toBeDefined()
  })

  test('同篇里死图 + 瞬态图并存 → 不消耗预算（有救得回的图就得继续等）', async () => {
    const transientUrl = 'https://doc.clipfx.app/doc-img/job-2/0'
    mockRequestUrl.mockImplementation(async ({ url }: { url: string }) =>
      url === DEAD_URL ? statusResponse(404) : statusResponse(500),
    )
    const { localizer, store } = build(
      `![a](${DEAD_URL})\n\n![b](${transientUrl})\n`,
    )
    const file = makeFile()

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    for (let i = 0; i < NOT_FOUND_ROUND_BUDGET * 2; i++) {
      await runRound(localizer, file)
    }

    expect(store.get(NOTE)).toBeDefined()
    expect(store.get(NOTE)?.notFoundRounds).toBe(0)
  })

  test('同一张死图在一轮内只验证一次，但每轮都重新验证', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer } = build(
      `![a](${DEAD_URL})\n\n![b](${DEAD_URL})\n\n![c](${DEAD_URL})\n`,
    )
    const file = makeFile()

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)

    // 下一轮必须重新发一次真实请求 —— 否则「图床暂时 404、稍后就绪」的图
    // 会在预算耗尽前一次都得不到验证。
    await runRound(localizer, file)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)
  })

  test('同步每轮重写同一篇笔记也不该无限重置预算（否则 wedge 原样复活）', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer, store } = build()
    const file = makeFile()

    // 每轮都走同步写盘那条入口（enqueueFile，传 initialNotFoundRounds=0），
    // 而不是续传重挂 —— 预算必须照样往上涨。
    for (let round = 1; round <= NOT_FOUND_ROUND_BUDGET; round++) {
      localizer.clearProcessedMark(NOTE)
      await localizer.enqueueFile(file)
      await localizer.processQueue()
    }

    expect(store.get(NOTE)).toBeUndefined()
  })

  test('续传记录的 notFoundRounds 跨重启保留（不会白白重来）', async () => {
    mockRequestUrl.mockResolvedValue(statusResponse(404))
    const { localizer, store } = build()
    const file = makeFile()
    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 模拟重启：新 store 从上一份快照恢复
    const revived = new PendingLocalizeStore({
      load: async () => store.snapshot(),
      save: async () => undefined,
    })
    await revived.load()
    expect(revived.get(NOTE)?.notFoundRounds).toBe(1)
  })
})
