import { canRetireNotFound } from '../common/notFoundPolicy'
/**
 * 附件下载器
 * 负责从网络下载附件，支持重试机制、过期文件检测、以及 relay/源站备用线路
 */

import { DownloadResponse, StreamTarget, streamTargetKey } from '../common/transfer/downloadResource'
import { transferPool, TransferSession, TransferTimeoutError, TransferCapacityError, TransferCooldownError, isConnectionUnavailable } from '../common/transfer/transferPool'
import { log, logError } from '../logger'
import { AttachmentDownloadResult } from './types'
import { isCompleteAttachment, isCompleteAttachmentSamples } from '../common/transferIntegrity'
import { getFallbackUrls, isOriginHost } from '../common/imageRelay'

/** 单个备用节点最大重试次数（主线路失败后的每个 fallback 节点） */
const FALLBACK_MAX_RETRIES = 1
const ATTACHMENT_RETRY_DELAY_CAP_MS = 2_000
const MAX_ATTACHMENT_DOWNLOAD_RETRIES = 5

/**
 * 单请求超时按附件大小算：附件动辄十几 MB，照搬图片侧的 5s 会让大文件永远下不完
 * （requestUrl 不能 abort，超时后请求照样在后台下完、结果却被丢弃）。
 * 超时只是黑洞节点的兜底，所以按一个很保守的吞吐下限估算。
 * 上限要覆盖最大 300MB 的附件：300MB ÷ 64KiB/s ≈ 80 分钟。
 */
const ATTACHMENT_TIMEOUT_FLOOR_MS = 30_000
const ATTACHMENT_TIMEOUT_CAP_MS = 90 * 60_000
const ATTACHMENT_TIMEOUT_UNKNOWN_SIZE_MS = 60_000
const ATTACHMENT_TIMEOUT_HEADROOM_MS = 15_000
const ATTACHMENT_MIN_THROUGHPUT_BYTES_PER_SEC = 64 * 1024

export interface AttachmentDownloadOptions {
  streamTarget?: StreamTarget
  /** 附件行里 `(17.37MB)` 解析出的字节数，用来放宽单请求超时 */
  expectedBytes?: number
  savedAt?: string
  firstNotFoundAt?: number
  notFoundRounds?: number
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
}

/** 解析附件行末尾的大小文本（如 `17.37MB`），无法解析返回 undefined。 */
export function parseAttachmentSizeBytes(text: string | undefined): number | undefined {
  const m = text?.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?B)$/i)
  if (!m) return undefined
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[m[2].toUpperCase()])
}

export function attachmentRequestTimeoutMs(expectedBytes?: number): number {
  if (!expectedBytes || !Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    return ATTACHMENT_TIMEOUT_UNKNOWN_SIZE_MS
  }
  const ms =
    ATTACHMENT_TIMEOUT_HEADROOM_MS +
    (expectedBytes / ATTACHMENT_MIN_THROUGHPUT_BYTES_PER_SEC) * 1000
  return Math.min(ATTACHMENT_TIMEOUT_CAP_MS, Math.max(ATTACHMENT_TIMEOUT_FLOOR_MS, Math.ceil(ms)))
}

/**
 * 延迟函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 检查响应是否为XML错误（文件过期）
 * @param text 响应文本
 * @returns 是否为NoSuchKey错误
 */
function isExpiredFileError(text: string): boolean {
  // 检查是否包含 NoSuchKey 错误的XML标记
  return text.includes('<Code>NoSuchKey</Code>') ||
         text.includes('<Message>The specified key does not exist.</Message>')
}

function getHeaderCI(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ''
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] || ''
  }
  return ''
}

function isNotFoundStatus(status: number): boolean {
  return status === 404 || status === 410
}

function errorHasNotFoundStatus(error: Error): boolean {
  return /(?:status|HTTP)\s*(?:404|410)\b/i.test(error.message)
}

/** HTML attachments are valid, but a network authentication form is not the requested document. */
function isNetworkLoginPage(source: string): boolean {
  // Ignore examples and non-rendered markup; a report mentioning login is still a document.
  const html = source.replace(/<!--[\s\S]*?-->|<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || ''
  const network = /\b(?:wi[\s-]?fi|hotspot|captive\s+portal|network)\b|无线网络|上网认证/i
  const login = /\b(?:log\s*in|sign\s*in|authenticat\w*)\b|登录|认证/i
  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form\s*>/gi)) {
    const form = match[1]
    if (!/<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password(?=[\s/>]))/i.test(form)) continue
    const visible = `${title} ${form.replace(/<[^>]*>/g, ' ')}`
    if (network.test(visible) && login.test(visible)) return true
  }
  return false
}

/** 拦截 CDN 登录页、人机校验页和 JSON 错误页，避免按原扩展名落盘。 */
function isPlaceholderResponse(
  data: ArrayBuffer | undefined,
  text: string,
  contentType: string,
  expectsHtml = false,
): boolean {
  const ct = contentType.trim().toLowerCase()
  let head = text.slice(0, 256).trimStart().toLowerCase()
  if (!head && data && data.byteLength > 0) {
    try {
      head = new TextDecoder('utf-8')
        .decode(new Uint8Array(data).slice(0, 256))
        .trimStart()
        .toLowerCase()
    } catch {
      head = ''
    }
  }
  if (!expectsHtml && (ct.startsWith('text/html') || ct.startsWith('application/xhtml'))) return true
  if (expectsHtml) {
    const sample = text ? text.slice(0, 65536) : data
      ? new TextDecoder('utf-8').decode(new Uint8Array(data, 0, Math.min(data.byteLength, 65536)))
      : ''
    if (isNetworkLoginPage(sample)) return true
  }
  if (
    !expectsHtml && (head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body'))
  ) {
    return true
  }
  return (
    (ct.startsWith('application/json') || ct.startsWith('application/ld+json')) &&
    (head.startsWith('{') || head.startsWith('['))
  )
}

const EXPIRED_RESULT: AttachmentDownloadResult = {
  success: false,
  error: '文件已过期，无法下载',
  expired: true,
}

/** 把一次 HTTP 响应判成 成功 / 过期 / 可重试失败（error）。 */
function evaluateResponse(response: DownloadResponse, url: string, options: AttachmentDownloadOptions): AttachmentDownloadResult {
  if (response.status !== 200) {
    const responseText = response.text || ''
    if (isNotFoundStatus(response.status) || isExpiredFileError(responseText)) {
      log(`附件已过期（NoSuchKey）: ${url}`)
      return EXPIRED_RESULT
    }
    return { success: false, error: `HTTP ${response.status}: ${responseText}` }
  }

  // 有些服务器可能返回200但内容是XML错误
  const contentType = getHeaderCI(response.headers, 'content-type')
  if (contentType.includes('xml') || contentType.includes('text')) {
    if (isExpiredFileError(response.text || '')) {
      log(`附件已过期（NoSuchKey）: ${url}`)
      return EXPIRED_RESULT
    }
  }
  // 邮件可以附带真正的 HTML 报告。仅当请求路径明确为 HTML 文档时接受；
  // PDF/DOCX 等附件收到登录页或网关占位 HTML 仍然拒收。查询参数不算扩展名。
  let expectsHtml = false
  try {
    expectsHtml = /\.(?:html?|xhtml)$/i.test(new URL(url).pathname)
  } catch { /* 无法识别的路径继续使用严格检查。 */ }
  if (isPlaceholderResponse(response.arrayBuffer, response.text || '', contentType, expectsHtml)) {
    return {
      success: false,
      error: `响应体是占位/登录页（HTTP 200, content-type=${contentType || 'n/a'}）`,
    }
  }

  const summary = response.bodySummary
  const complete = summary
    ? isCompleteAttachmentSamples(summary.bytes, summary.head, summary.tail, response.headers, url, options.expectedBytes)
    : isCompleteAttachment(response.arrayBuffer, response.headers, url, options.expectedBytes)
  if (!complete) {
    return { success: false, error: '附件响应不完整' }
  }

  log(`附件下载成功: ${url}`)
  return summary ? { success: true, localPath: response.localPath } : { success: true, data: response.arrayBuffer }
}

/**
 * 单线路下载（带重试，指数退避）
 *
 * 三种返回值：
 * - success: true                          → 下载成功（也可能是之前超时放弃的请求晚到的成功）
 * - success: false, expired: true          → 服务端返回 NoSuchKey（真过期，不应继续尝试其他节点）
 * - success: false, expired: undefined     → 网络/HTTP 错误，调用方可走 fallback
 *
 * 超时不在同一地址重试：原请求还在后台下载，再打一次只会重复占带宽
 * （或在浏览器缓存锁上排队干等）。直接轮转到下一条线路，原请求交给 abandoned。
 */
async function attemptDownload(
  url: string,
  maxRetries: number,
  retryDelay: number,
  timeoutMs: number,
  session: TransferSession<AttachmentDownloadResult>,
  options: AttachmentDownloadOptions,
): Promise<AttachmentDownloadResult> {
  let lastError: Error | null = null
  let connectionOnly = true
  const retries = Math.min(
    MAX_ATTACHMENT_DOWNLOAD_RETRIES,
    Math.max(0, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : 0),
  )

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.streamTarget?.signal?.aborted) return { success: false, error: '下载已取消' }
    try {
      log(`尝试下载附件 (${attempt + 1}/${retries + 1}): ${url}`)

      const result = await session.request(url, 'attachment', timeoutMs)
      if (result.success || result.expired) return result
      connectionOnly = connectionOnly && result.connectionUnavailable === true
      throw new Error(result.error)
    } catch (error: unknown) {
      connectionOnly = connectionOnly && isConnectionUnavailable(error)
      if (error instanceof TransferTimeoutError || error instanceof TransferCapacityError || error instanceof TransferCooldownError) {
        logError(`下载附件超时，改走下一条线路: ${url}`, error)
        return { success: false, error: error.message, retryAt: transferPool.retryAt(url), connectionUnavailable: connectionOnly }
      }
      lastError = error instanceof Error ? error : new Error(String(error))

      // 真·过期短路：任一节点返回 NoSuchKey 都等同于全网过期
      const errorMsg = lastError.message || ''
      if (
        errorHasNotFoundStatus(lastError) ||
        errorMsg.includes('NoSuchKey') ||
        errorMsg.includes('does not exist')
      ) {
        log(`附件已过期: ${url}`)
        return EXPIRED_RESULT
      }

      logError(`下载附件失败 (${attempt + 1}/${retries + 1}): ${url}`, error)

      if (attempt < retries) {
        const delay = Math.min(
          ATTACHMENT_RETRY_DELAY_CAP_MS,
          Math.max(0, retryDelay) * Math.pow(2, attempt),
        )
        log(`${delay}ms 后重试...`)
        await sleep(delay)
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || '下载失败',
    retryAt: transferPool.retryAt(url),
    connectionUnavailable: connectionOnly,
  }
}

/** 没有备用线路可交叉验证的地址（源站或普通第三方地址），它的 404 就是定论。 */
function isAuthoritativeExpiry(url: string): boolean {
  return isOriginUrl(url) || getFallbackUrls(url).length === 0
}

/** 判断 URL 的 hostname 是否为权威源站（NoSuchKey 可直接信为真过期）。 */
function isOriginUrl(url: string): boolean {
  try {
    return isOriginHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * 下载附件（带重试、relay/源站 fallback、过期检测）
 *
 * 流程：
 * 1. 主线路尝试 maxRetries+1 次（指数退避）；任一 attempt 成功即返。
 * 2. 主线路 NoSuchKey 的处理分两种：
 *    - 主线路是权威源站（pic/media/media30d/镜像/sync）→ 直接返回 expired，不再 fallback
 *      （源站的 404 就是真相，不需要跨节点再次验证）
 *    - 主线路是 relay 反向代理 → 不短路，继续按 fallback 跨节点交叉验证
 *      （relay 可能因单点 cache/重写故障返 404，不能单凭一个节点断定对象真的不存在）
 * 3. 主线路非 expired 失败后按 getFallbackUrls 顺序切换每个备用节点，每节点最多 FALLBACK_MAX_RETRIES+1 次尝试。
 * 4. 某条线路超时 → 不重试同一地址，直接换下一条；超时的请求继续在后台跑，
 *    之后任一时刻它先下完就直接采用；所有线路都走完后再给它们一个超时窗口收尾。
 * 5. 所有节点都走完：
 *    - 全部 attempt 都 expired → expired
 *    - 混合失败（部分 NoSuchKey + 部分网络错）→ 纯 failure，避免 relay 单点 NoSuchKey
 *      污染上游"已过期"标记逻辑
 *
 * @param url 附件URL
 * @param maxRetries 主线路最大重试次数
 * @param retryDelay 重试延迟（毫秒）
 * @param options expectedBytes 用来按附件大小放宽单请求超时
 * @returns 下载结果
 */
async function downloadAttachmentAttempt(
  url: string,
  maxRetries: number = 3,
  retryDelay: number = 1000,
  options: AttachmentDownloadOptions = {},
): Promise<AttachmentDownloadResult> {
  const attempts: AttachmentDownloadResult[] = []
  const timeoutMs = attachmentRequestTimeoutMs(options.expectedBytes)
  const transport = options.streamTarget ? {
    key: streamTargetKey(options.streamTarget) + ':' + String(options.expectedBytes),
    options: { target: options.streamTarget, signal: options.streamTarget.signal, idleTimeoutMs: timeoutMs,
      validate: (response: DownloadResponse) => evaluateResponse(response, url, options).success },
  } : undefined
  const session = new TransferSession<AttachmentDownloadResult>(flight => {
    if (flight.error) {
      const error = flight.error
      return errorHasNotFoundStatus(error) || error.message.includes('NoSuchKey') || error.message.includes('does not exist')
        ? EXPIRED_RESULT : { success: false, error: error.message, connectionUnavailable: isConnectionUnavailable(error) }
    }
    const result = evaluateResponse(flight.response!, flight.url, options)
    if (result.success) transferPool.recordSuccess(flight)
    return result
  }, (result, route) => result.success || (!!result.expired && isAuthoritativeExpiry(route)), transferPool, transport)
  try {

  const routes = transferPool.hostHealth.order([url, ...getFallbackUrls(url)])
  for (const route of routes) {
    const r = await attemptDownload(route, route === url ? maxRetries : FALLBACK_MAX_RETRIES, retryDelay, timeoutMs, session, options)
    if (r.success) return r
    if (session.result) return session.result
    if (r.expired && isOriginUrl(route)) return r
    attempts.push(r)
  }

  const late = await session.waitForOutcome(timeoutMs)
  if (late) return late.connectionUnavailable
    ? { ...late, connectionUnavailable: attempts.every(a => a.connectionUnavailable === true) }
    : late

  // 全部节点都明确返回 NoSuchKey → 认定真过期；否则返回"最后一次失败"
  // 并抹掉 expired 字段，避免单节点 NoSuchKey 污染上游判定
  if (attempts.every((a) => a.expired)) {
    return attempts[0]
  }
  const last = attempts[attempts.length - 1]
  return { success: false, error: last.error, retryAt: last.retryAt, connectionUnavailable: attempts.every(a => a.connectionUnavailable === true) }
  } finally { session.dispose() }
}

/** Only a mature negative observation is terminal; newly published objects may not exist yet. */
export async function downloadAttachment(
  url: string,
  maxRetries = 3,
  retryDelay = 1000,
  options: AttachmentDownloadOptions = {},
): Promise<AttachmentDownloadResult> {
  const result = await downloadAttachmentAttempt(url, maxRetries, retryDelay, options)
  if (!result.expired) return result
  const now = Date.now()
  const saved = options.savedAt ? Date.parse(options.savedAt) : NaN
  const oldAttachment = Number.isFinite(saved) && now - saved >= 72 * 60 * 60_000
  const observed = {
    firstNotFoundAt: options.firstNotFoundAt ?? now,
    notFoundRounds: (options.notFoundRounds ?? 0) + 1,
  }
  if (oldAttachment || canRetireNotFound(observed, now, options.savedAt)) return result
  return { success: false, notReady: true, error: '附件尚未就绪，稍后重试' }
}

/**
 * 检查 URL 是否为远程附件
 * @param url 附件URL
 * @returns 是否为远程附件
 */
export function isRemoteAttachment(url: string): boolean {
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
