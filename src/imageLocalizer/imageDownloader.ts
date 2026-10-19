import { hasCompleteLength } from '../common/transferIntegrity'
/**
 * 图片下载器
 * 负责从网络下载图片，支持重试机制和备用线路
 */

import { transferPool, TransferFlight, TransferSession, isConnectionUnavailable } from '../common/transfer/transferPool'
import { log, logError } from '../logger'
import { DownloadResult } from './types'
import { getFallbackUrls, isOriginHost } from '../common/imageRelay'

export { getFallbackUrls }

/** 设置与运行时共同使用的重试硬上限（首次 + 5 次重试 = 最多 6 次常规机会）。 */
export const MAX_IMAGE_DOWNLOAD_RETRIES = 5
/** Chromium/Capacitor 的 requestUrl 不支持 abort，只能在调用外层做超时竞争。 */
export const IMAGE_REQUEST_TIMEOUT_MS = 25_000
/** 指数退避封顶，避免高 retry 配置把单篇笔记卡住数天。 */
export const IMAGE_RETRY_DELAY_CAP_MS = 2_000
/** 单轮图片墙钟预算；超时后底层请求仍由共享传输池持有，后续轮次可继续复用。 */
export const IMAGE_DOWNLOAD_TIME_BUDGET_MS = 90_000

/** 对 data.json 老值、UI 输入和调用方参数做同一套防御性归一化。 */
export function clampImageDownloadRetries(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_IMAGE_DOWNLOAD_RETRIES, Math.max(0, Math.floor(value)))
}

/**
 * 延迟函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 判定下载回来的响应体是否是一张「真图片」。
 *
 * 背景（钉红：tests/relayImageNotReady.repro.spec.ts）：图床 relay / CDN 在源站
 * （R2）尚未就绪时，可能返回 HTTP 200 但 body 并不是真图片 —— nginx warming 占位、
 * HTML 错误页、甚至 0 字节。若把这类响应当成图片保存，就会出现「本地是坏文件 +
 * 原始图床链接也被替换成本地链接」的【不可逆】坏态（真图和原链接双双丢失）。
 * 所以下载层必须在「宣布成功」前先确认拿到的确实是图片；不是则视为失败，触发
 * 重试 / 备用线路兜底，最终交给上层保留远程链接 + 续传。
 *
 * 采用「否定式」判定（reject known-bad），而非「魔数白名单」，避免误伤 avif / bmp /
 * ico 等未列入魔数表的合法格式。判定顺序（顺序本身很重要）：
 *   1. 空 body → 非图片
 *   2. 命中已知图片魔数（PNG/JPEG/GIF/WebP/BMP/ICO/AVIF/HEIC/根级 SVG）→ 是图片
 *   3. body 开头像 HTML / XML / JSON / 数组文本 → 非图片（占位 / 错误页）。⚠️ 这一步
 *      必须【早于】信任 Content-Type：有些 warming/错误页会谎报 `Content-Type: image/*`，
 *      仅凭头信任会把 HTML 占位当图片存下（codex 阻断#1）。
 *   4. Content-Type 明确 `image/*` → 信任（覆盖魔数表外的 exotic 合法格式）
 *   5. Content-Type 明确是文本类（text/* / json / xml / xhtml / javascript）→ 非图片
 *   6. 其余非空二进制（无魔数、无文本特征、无可辨识 content-type）→ 放行（不误杀）
 */
export function isLikelyImageResponse(
  data: ArrayBuffer | undefined,
  contentType: string,
): boolean {
  if (!data || data.byteLength === 0) return false
  const bytes = new Uint8Array(data)
  if (matchesImageMagic(bytes)) return true
  if (looksLikeTextPage(bytes)) return false
  const ct = contentType.trim().toLowerCase()
  if (ct.startsWith('image/')) return true
  if (isTextualContentType(ct)) return false
  return true
}

/** content-type 是否明确是「文本类」（占位 / 错误页常见），非图片。 */
function isTextualContentType(ct: string): boolean {
  return (
    ct.startsWith('text/') ||
    ct.startsWith('application/json') ||
    ct.startsWith('application/ld+json') ||
    ct.startsWith('application/xml') ||
    ct.startsWith('application/xhtml') ||
    ct.startsWith('application/javascript') ||
    ct.startsWith('application/ecmascript')
  )
}

/** HTTP 响应头大小写不敏感取值（Obsidian 底层可能回 `Content-Type`）。 */
function getHeaderCI(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ''
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] || ''
  }
  return ''
}

/** 在文件末尾窗口内查找完整字节序列（允许结束标志后有少量尾随数据）。 */
function hasSequenceInTail(
  bytes: Uint8Array,
  sequence: readonly number[],
  windowSize: number,
): boolean {
  const start = Math.max(0, bytes.length - windowSize)
  const lastStart = bytes.length - sequence.length
  for (let offset = start; offset <= lastStart; offset++) {
    let matches = true
    for (let index = 0; index < sequence.length; index++) {
      if (bytes[offset + index] !== sequence[index]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

/**
 * 校验已识别图片格式是否完整。
 *
 * HTTP 层只能发现 Content-Length 不匹配，发现不了合法 chunked 响应里的半张图片；
 * 因此对有可靠结束标志/长度字段的常见格式再做一次结构尾检。未知格式仍保持兼容，
 * 只在有 Content-Length 时做长度一致性检查。
 */
export function isCompleteImageResponse(
  data: ArrayBuffer | undefined,
  headers: Record<string, string> | undefined = undefined,
): boolean {
  if (!data || !hasCompleteLength(data, headers)) return false
  const bytes = new Uint8Array(data)

  // PNG：末尾 64 字节内须有长度 0 的 IEND + 固定 CRC。
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return hasSequenceInTail(
      bytes,
      [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
      64,
    )
  }

  // JPEG：末尾 64 字节内须有 EOI marker。
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return hasSequenceInTail(bytes, [0xff, 0xd9], 64)
  }

  // GIF：末尾 64 字节内须有文件终止符 ';'。
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return hasSequenceInTail(bytes, [0x3b], 64)
  }

  // WebP：RIFF size 字段是文件总长减 8，允许声明内容后有尾随填充。
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const riffSize =
      (
        bytes[4] |
        (bytes[5] << 8) |
        (bytes[6] << 16) |
        (bytes[7] << 24)
      ) >>> 0
    return riffSize >= 4 && riffSize + 8 <= bytes.length
  }

  // BMP：header 内声明的文件长度，允许声明内容后有尾随填充。
  if (bytes.length >= 6 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const declaredSize =
      (
        bytes[2] |
        (bytes[3] << 8) |
        (bytes[4] << 16) |
        (bytes[5] << 24)
      ) >>> 0
    return declaredSize > 0 && declaredSize <= bytes.length
  }

  // 根级 SVG 至少要有闭合根节点；只解码尾部，避免大 SVG 复制整份字符串。
  const head = new TextDecoder('utf-8')
    .decode(bytes.slice(0, Math.min(bytes.length, 256)))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    const tail = new TextDecoder('utf-8')
      .decode(bytes.slice(Math.max(0, bytes.length - 512)))
      .toLowerCase()
    return tail.includes('</svg>')
  }

  return true
}

/** 已知图片格式的文件头魔数判定（含文本型 svg 探测）。 */
function matchesImageMagic(b: Uint8Array): boolean {
  // PNG: 89 50 4E 47
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  // GIF: 47 49 46 38
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true
  // WebP: 52 49 46 46 .... 57 45 42 50
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return true
  // BMP: 42 4D
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return true
  // ICO: 00 00 01 00
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return true
  // AVIF / HEIC: ISO-BMFF `ftyp` box（bytes 4..8 == 'ftyp'）+ 图片 brand
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand === 'avif' || brand === 'avis' || brand.startsWith('hei') || brand.startsWith('mif')) {
      return true
    }
  }
  // SVG（文本）：要求根节点附近即是 `<svg>`（或 `<?xml … <svg>`），避免把内嵌
  // svg 图标的 HTML 错误页误判成真图（codex 阻断#2）。
  try {
    const t = new TextDecoder('utf-8')
      .decode(b.slice(0, 256))
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase()
    if (t.startsWith('<svg')) return true
    if (
      t.startsWith('<?xml') &&
      t.includes('<svg') &&
      !t.includes('<html') &&
      !t.includes('<!doctype')
    ) {
      return true
    }
  } catch {
    // 解码失败视为非文本
  }
  return false
}

/**
 * 判定 body 头部是否像「HTML/XML/JSON/数组 文本页」（占位页 / 错误页）。
 * 仅在既非已知图片魔数时才会走到这里（根级 svg 已在魔数判定里放行），所以任何
 * 残留的前导 `<` 都可安全认定为标记语言错误页；`{` / `[` 认定为 JSON。
 */
function looksLikeTextPage(b: Uint8Array): boolean {
  try {
    const head = new TextDecoder('utf-8')
      .decode(b.slice(0, 64))
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase()
    return head.startsWith('<') || head.startsWith('{') || head.startsWith('[')
  } catch {
    return false
  }
}

type AttemptKind = 'success' | 'not-found' | 'transient'

interface AttemptOutcome {
  kind: AttemptKind
  result: DownloadResult
}

class ImageDownloadError extends Error {
  readonly kind: Exclude<AttemptKind, 'success'>

  constructor(message: string, kind: Exclude<AttemptKind, 'success'> = 'transient') {
    super(message)
    this.name = 'ImageDownloadError'
    this.kind = kind
  }
}

function isNotFoundStatus(status: number): boolean {
  return status === 404 || status === 410
}

function errorKind(error: Error): Exclude<AttemptKind, 'success'> {
  if (error instanceof ImageDownloadError) return error.kind
  return /(?:status|HTTP)\s*(?:404|410)\b/i.test(error.message) ? 'not-found' : 'transient'
}

function isOriginUrl(url: string): boolean {
  try {
    return isOriginHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * 单次下载并分类。重试、线路轮转和总时间预算由 downloadImage 统一管理。
 */
function evaluateImageFlight(flight: TransferFlight): AttemptOutcome {
  const url = flight.url
  try {
    if (flight.error) throw flight.error
    const response = flight.response!
    if (response.status !== 200) {
      const message = `Request failed, status ${response.status}`
      throw new ImageDownloadError(
        message,
        isNotFoundStatus(response.status) ? 'not-found' : 'transient',
      )
    }

    const contentType = getHeaderCI(response.headers, 'content-type')
    if (!isLikelyImageResponse(response.arrayBuffer, contentType)) {
      throw new ImageDownloadError(
        `响应体不是有效图片（HTTP 200, content-type=${contentType || 'n/a'}, bytes=${response.arrayBuffer?.byteLength ?? 0}）`,
      )
    }
    if (!isCompleteImageResponse(response.arrayBuffer, response.headers)) {
      throw new ImageDownloadError(
        `图片响应不完整（HTTP 200, content-type=${contentType || 'n/a'}, bytes=${response.arrayBuffer?.byteLength ?? 0}）`,
      )
    }

    transferPool.recordSuccess(flight)
    log(`图片下载成功: ${url}`)
    return {
      kind: 'success',
      result: { success: true, data: response.arrayBuffer },
    }
  } catch (error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    logError(`下载图片失败: ${url}`, normalized)
    return {
      kind: errorKind(normalized),
      result: { success: false, error: normalized.message || '下载失败', retryAt: transferPool.retryAt(url), connectionUnavailable: isConnectionUnavailable(normalized) },
    }
  }
}

/**
 * 下载图片（带重试和备用线路）
 *
 * 流程：
 * 1. maxRetries 表示全线路共享的重试次数（首次 + N 次重试）。
 * 2. 每次瞬态失败后立即轮到下一线路，不在坏主节点上烧完整个预算。
 * 3. relay 的 404/410 要跨节点验证；权威源站的 404/410 直接结束。
 * 4. 单请求超时、退避封顶、单图总墙钟预算共同保证队列可收敛。
 * 5. 失败结果带 failureKind：`not-found` 仅在「权威源站 404/410」或「所有线路都
 *    404/410」、【且本次下载全程没有出现过任何瞬态失败】时给出，其余一律 `transient`
 *    （上层据此决定是永久重试还是走有界预算）。
 *
 * @param url 图片URL
 * @param maxRetries 主线路最大重试次数
 * @param retryDelay 重试延迟（毫秒）
 * @returns 下载结果
 */
export interface ImageDownloadOptions { expectedBytes?: number }

export function imageRequestTimeoutMs(expectedBytes?: number, url = 'https://unknown.invalid/image'): number {
  return transferPool.imageTimeout(url, expectedBytes)
}

export async function downloadImage(
  url: string,
  maxRetries = 3,
  retryDelay = 1000,
  options: ImageDownloadOptions = {},
): Promise<DownloadResult> {
  const session = new TransferSession(evaluateImageFlight, (outcome, route) =>
    outcome.kind === 'success' || (outcome.kind === 'not-found' && isOriginUrl(route)))
  try { return await downloadImageRound(url, maxRetries, retryDelay, options, session) }
  finally { session.dispose() }
}

async function downloadImageRound(
  url: string, maxRetries: number, retryDelay: number, options: ImageDownloadOptions,
  session: TransferSession<AttemptOutcome>,
): Promise<DownloadResult> {
  const retries = clampImageDownloadRetries(maxRetries)
  const normalAttempts = retries + 1
  const routes = transferPool.hostHealth.order([url, ...getFallbackUrls(url)])
  const maxLoggedAttempts = Math.max(normalAttempts, routes.length)
  const unavailable = new Set<string>()
  const deadline = Date.now() + IMAGE_DOWNLOAD_TIME_BUDGET_MS
  let routeCursor = 0
  let attempts = 0
  let transientAttempt = 0
  let sawNotFound = false
  let lastResult: DownloadResult = { success: false, error: '下载失败' }
  let connectionOnly = true
  // 本次下载只要出现过【任何一次】瞬态失败，最终就不许判成 not-found —— 哪怕后面
  // 每条线路都回 404。因为「先超时/5xx、后 404」完全可能是同一个抽风窗口的两种表现
  // （CDN 回源失败时先 5xx 后缓存一个 404 是常见形态），把它判成死刑会永久放弃一张
  // 其实救得回的图（codex 阻断#1）。宁可多重试，绝不误判死刑。
  let sawTransient = false

  while (attempts < normalAttempts || (sawNotFound && unavailable.size < routes.length)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return {
        success: false,
        error: `图片下载超过总时间预算（${IMAGE_DOWNLOAD_TIME_BUDGET_MS}ms）`,
        failureKind: 'transient',
      }
    }

    let route: string | undefined
    for (let checked = 0; checked < routes.length; checked++) {
      const candidate = routes[routeCursor % routes.length]
      routeCursor++
      if (!unavailable.has(candidate)) {
        route = candidate
        break
      }
    }
    if (!route) break
    if (attempts > 0) log(`切换下载线路: ${route}`)

    attempts++
    let outcome: AttemptOutcome
    try {
      log(`尝试下载图片 (${attempts}/${maxLoggedAttempts}): ${route}`)
      outcome = await session.request(route, 'image', Math.max(1, Math.min(imageRequestTimeoutMs(options.expectedBytes, route), remainingMs)))
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      outcome = { kind: errorKind(normalized), result: { success: false, error: normalized.message, retryAt: transferPool.retryAt(route), connectionUnavailable: isConnectionUnavailable(normalized) } }
    }
    lastResult = outcome.result
    if (outcome.kind === 'success') return outcome.result
    connectionOnly = connectionOnly && outcome.result.connectionUnavailable === true

    if (outcome.kind === 'not-found') {
      sawNotFound = true
      unavailable.add(route)
      if (isOriginUrl(route) || unavailable.size === routes.length) {
        return {
          ...outcome.result,
          failureKind: sawTransient ? 'transient' : 'not-found',
        }
      }
      // 永久失败不做退避，立即去其它节点交叉验证。
      continue
    }

    sawTransient = true
    transientAttempt++
    if (attempts >= normalAttempts) break
    const delay = Math.min(
      IMAGE_RETRY_DELAY_CAP_MS,
      Math.max(0, retryDelay) * Math.pow(2, transientAttempt - 1),
    )
    if (delay > 0) {
      const remainingAfterRequest = deadline - Date.now()
      if (remainingAfterRequest <= delay) break
      log(`${delay}ms 后重试...`)
      await sleep(delay)
    }
  }

  const late = await session.waitForOutcome(deadline - Date.now())
  if (late?.kind === 'success') return late.result
  if (late) return { ...late.result, connectionUnavailable: connectionOnly && late.result.connectionUnavailable === true, failureKind: sawTransient ? 'transient' : 'not-found' }

  // 只有「见过 404/410」且「全程没有任何瞬态」才敢收尾成 not-found。
  return {
    ...lastResult,
    connectionUnavailable: attempts > 0 && connectionOnly,
    failureKind: sawNotFound && !sawTransient ? 'not-found' : 'transient',
  }
}

/**
 * 批量下载图片
 * @param urls 图片URL列表
 * @param maxRetries 最大重试次数
 * @param retryDelay 重试延迟（毫秒）
 * @param concurrency 并发数
 * @returns 下载结果映射表
 */
export async function batchDownloadImages(
  urls: string[],
  maxRetries: number = 3,
  retryDelay: number = 1000,
  concurrency: number = 3
): Promise<Map<string, DownloadResult>> {
  const results = new Map<string, DownloadResult>()

  // 分批下载（控制并发）
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)

    log(`批量下载: ${i + 1}-${Math.min(i + concurrency, urls.length)}/${urls.length}`)

    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const result = await downloadImage(url, maxRetries, retryDelay)
        return { url, result }
      })
    )

    // 保存结果
    for (const { url, result } of batchResults) {
      results.set(url, result)
    }
  }

  return results
}

/**
 * 检查 URL 是否为网络图片
 * @param url 图片URL
 * @returns 是否为网络图片
 */
export function isRemoteImage(url: string): boolean {
  try {
    // 排除本地路径
    if (
      url.startsWith('/') ||
      url.startsWith('./') ||
      url.startsWith('../') ||
      url.startsWith('file:') ||
      url.startsWith('app:') ||
      url.startsWith('vault:')
    ) {
      return false
    }

    // 排除 data URI
    if (url.startsWith('data:')) {
      return false
    }

    // 检查是否为 HTTP/HTTPS URL
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    // URL 解析失败，不是有效的网络URL
    return false
  }
}
