import { requestUrl, RequestUrlResponse, Vault, normalizePath } from 'obsidian'
import { md5 as createMD5 } from 'js-md5'
import { sha256 as createSHA256 } from 'js-sha256'
import { ensureFolderExists, withVaultPathLock } from '../vaultStore'

const CHUNK_BYTES = 256 * 1024
const SAMPLE_BYTES = 65557
export interface BodySummary {
  bytes: number
  head: Uint8Array
  tail: Uint8Array
  md5: string
  sha256: string
}
export interface DownloadResponse extends RequestUrlResponse {
  bodySummary?: BodySummary
  localPath?: string
}
export interface StreamTarget { vault: Vault; folder: string; fileName: string; signal?: AbortSignal }
export interface DownloadOptions {
  url: string
  headers?: Record<string, string>
  /** Streaming is explicit: never silently fall back to whole-body native I/O. */
  stream?: boolean
  target?: StreamTarget
  validate?: (response: DownloadResponse) => boolean
  signal?: AbortSignal
  idleTimeoutMs?: number
  requireOk?: boolean
  retries?: number
  retryDelayMs?: number
  fallbackUrls?: string[]
  pollNotFoundUntil?: number
}
const active = new WeakMap<Vault, Set<AbortController>>()
const scopes = new WeakMap<Vault, number>()
let sequence = 0
export function streamTargetKey(target: StreamTarget): string {
  if (!scopes.has(target.vault)) scopes.set(target.vault, ++sequence)
  return JSON.stringify([scopes.get(target.vault), normalizePath(target.folder), target.fileName])
}
export function cancelDownloads(vault: Vault): void {
  for (const controller of active.get(vault) ?? []) controller.abort()
}

/** The sole file-download transport entry: images, attachments, content exports,
 * updater assets and local streamed verification all use this method. Domain
 * expiry/retry policy stays with the callers; raw network/file transport does not. */
export async function downloadResource(options: DownloadOptions): Promise<DownloadResponse> {
  let last: unknown
  const retries = Math.max(0, Math.min(5, options.retries ?? 0))
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const url of [options.url, ...(options.fallbackUrls ?? [])]) {
      try {
        let response: DownloadResponse
        do {
          if (options.signal?.aborted) throw new Error('下载已取消')
          response = options.stream || options.target
            ? await streamResponse({ ...options, url })
            : await requestUrl({ url, method: 'GET', throw: false, ...(options.headers ? { headers: options.headers } : {}) })
          if (response.status !== 404 || !options.pollNotFoundUntil || Date.now() >= options.pollNotFoundUntil) break
          await new Promise(resolve => window.setTimeout(resolve, 1000))
        } while (response.status === 404)
        if (options.requireOk && response.status !== 200) throw new Error(`HTTP ${response.status}`)
        return response
      } catch (error) { last = error }
    }
    if (attempt < retries) await new Promise(resolve => window.setTimeout(resolve, (options.retryDelayMs ?? 1000) * 2 ** attempt))
  }
  throw last
}

async function streamResponse(options: DownloadOptions): Promise<DownloadResponse> {
  const target = options.target, adapter = target?.vault.adapter
  if (target && typeof adapter?.appendBinary !== 'function') throw new Error('当前 Obsidian 不支持流式写入，请升级至 1.12.3 或更高版本')
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  if (target) {
    const pending = active.get(target.vault) ?? new Set<AbortController>()
    pending.add(controller); active.set(target.vault, pending)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let temp: string | undefined
  let idle: number
  const touch = () => { window.clearTimeout(idle); idle = window.setTimeout(abort, options.idleTimeoutMs ?? 60000) }
  const deadline = window.setTimeout(abort, 90 * 60000)
  touch()
  try {
    // Explicit browser transport: requestUrl cannot expose a bounded response stream.
    const response = await window.fetch(options.url, { signal: controller.signal, cache: 'no-store', headers: options.headers })
    if (!response.body) throw new Error('流式响应不可用')
    reader = response.body.getReader()
    const result: DownloadResponse = { status: response.status, headers: {}, text: '', json: null, arrayBuffer: new ArrayBuffer(0) }
    response.headers.forEach((value, key) => { result.headers[key] = value })
    if (target && response.status === 200) {
      await ensureFolderExists(target.vault, normalizePath(target.folder))
      // A unique hidden temporary file; only our own file is ever removed.
      temp = normalizePath(`${target.folder}/.notehelper-${Date.now()}-${++sequence}-${Math.random().toString(16).slice(2)}.part`)
      await adapter!.writeBinary(temp, new ArrayBuffer(0))
    }
    const md5 = createMD5.create(), sha256 = createSHA256.create()
    let bytes = 0, head = new Uint8Array(0), tail = new Uint8Array(0)
    let lastYield = Date.now()
    read: while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      touch()
      for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK_BYTES) {
        if (controller.signal.aborted) throw new Error('下载已取消')
        const value = chunk.value.subarray(offset, Math.min(offset + CHUNK_BYTES, chunk.value.byteLength))
        const prefix = value.subarray(0, Math.max(0, SAMPLE_BYTES - head.length))
        if (prefix.length) { const next = new Uint8Array(head.length + prefix.length); next.set(head); next.set(prefix, head.length); head = next }
        if (response.status !== 200) { bytes += value.length; if (head.length >= SAMPLE_BYTES) { await reader.cancel(); break read } continue }
        const suffix = value.subarray(Math.max(0, value.length - SAMPLE_BYTES))
        const old = tail.subarray(Math.max(0, tail.length + suffix.length - SAMPLE_BYTES))
        const next = new Uint8Array(old.length + suffix.length); next.set(old); next.set(suffix, old.length); tail = next
        md5.update(value); sha256.update(value)
        if (temp) await adapter!.appendBinary(temp, value.slice().buffer)
        bytes += value.length
        touch()
        // Local resource streams can resolve every read in the microtask queue.
        // Yield explicitly so large-file hashing cannot starve UI/native events.
        if (Date.now() - lastYield >= 8) {
          await new Promise(resolve => window.setTimeout(resolve, 0))
          lastYield = Date.now()
        }
      }
    }
    if (controller.signal.aborted) throw new Error('下载已取消')
    result.arrayBuffer = head.buffer
    result.text = new TextDecoder().decode(head)
    result.bodySummary = { bytes, head, tail, md5: md5.hex(), sha256: sha256.hex() }
    window.clearTimeout(idle!)
    if (target && temp && (!options.validate || options.validate(result))) {
      // Read the actual temporary file as a stream too: validate disk integrity
      // without reintroducing a whole-file readBinary/arrayBuffer allocation.
      const stored = await downloadResource({ url: adapter!.getResourcePath(temp), stream: true, signal: controller.signal })
      if (stored.status !== 200 || stored.bodySummary?.bytes !== bytes || stored.bodySummary.sha256 !== result.bodySummary.sha256) throw new Error('附件写入校验失败')
      result.localPath = await commitFile(target, temp, result.bodySummary, controller.signal)
    }
    return result
  } finally {
    window.clearTimeout(idle!); window.clearTimeout(deadline)
    controller.abort()
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    options.signal?.removeEventListener('abort', abort)
    if (temp && await adapter!.exists(temp)) await adapter!.remove(temp)
    if (target) active.get(target.vault)?.delete(controller)
  }
}

async function commitFile(target: StreamTarget, temp: string, body: BodySummary, signal: AbortSignal): Promise<string> {
  const { vault, folder, fileName } = target, adapter = vault.adapter
  for (let index = -1; ; index++) {
    if (signal.aborted) throw new Error('下载已取消')
    const extension = fileName.lastIndexOf('.')
    const suffix = `-${body.md5}${index > 0 ? `-${index}` : ''}`
    const name = index < 0 ? fileName : extension > 0 ? `${fileName.slice(0, extension)}${suffix}${fileName.slice(extension)}` : fileName + suffix
    const path = normalizePath(`${folder}/${name}`)
    const saved = await withVaultPathLock(vault, path, async () => {
      if (signal.aborted) throw new Error('下载已取消')
      const stat = await adapter.stat(path)
      if (!stat) {
        try { await adapter.rename(temp, path); return path }
        catch (error) { if (!await adapter.exists(path)) throw error; return undefined }
      }
      if (stat.type !== 'file' || stat.size !== body.bytes) return undefined
      const existing = await downloadResource({ url: adapter.getResourcePath(path), stream: true, signal })
      if (existing.status === 200 && existing.bodySummary?.bytes === body.bytes && existing.bodySummary.sha256 === body.sha256) return path
      return undefined
    })
    if (saved) return saved
  }
}
