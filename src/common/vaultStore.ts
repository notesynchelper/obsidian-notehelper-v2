import { Vault, normalizePath, TAbstractFile, TFolder } from 'obsidian'
import { log, logError } from '../logger'
// 仅引入 core（提供 lib.WordArray）+ lib-typedarrays + md5 子模块，避免把整个
// crypto-js（~230KB）打进包。lib-typedarrays 不能省：它给 WordArray.create 装上
// 对 Uint8Array 的类型化数组识别，整包 crypto-js 默认带它；省掉会让传 Uint8Array
// 的哈希结果变化 → 改变图片本地化文件名 → 破坏跨版本去重。
import { md5 } from 'js-md5'

export function calculateHexMD5(data: Uint8Array): string {
  return md5(data)
}

function arrayBuffersEqual(first: ArrayBuffer, second: ArrayBuffer): boolean {
  if (first.byteLength !== second.byteLength) return false

  // 先按 32 位分组比较，减少大图严格比对时的 JS 循环次数；两个视图从同一
  // 字节偏移（0）按本机相同端序解释，所以 word 相等与对应 4 字节逐一相等
  // 完全等价。不足 4 字节的尾部仍逐字节收尾，不做采样或概率判断。
  const wordLength = Math.floor(first.byteLength / Uint32Array.BYTES_PER_ELEMENT)
  const firstWords = new Uint32Array(first, 0, wordLength)
  const secondWords = new Uint32Array(second, 0, wordLength)
  for (let index = 0; index < wordLength; index++) {
    if (firstWords[index] !== secondWords[index]) return false
  }

  const firstBytes = new Uint8Array(first)
  const secondBytes = new Uint8Array(second)
  for (
    let index = wordLength * Uint32Array.BYTES_PER_ELEMENT;
    index < firstBytes.length;
    index++
  ) {
    if (firstBytes[index] !== secondBytes[index]) return false
  }
  return true
}

/**
 * 读出某个路径已有的字节，并与待写入内容比较。
 *
 * 专供「createBinary 因路径已存在而失败」这条竞态路径：同一篇笔记里两张【内容相同】
 * 的图会算出同一个文件名，在有界并发下会同时落盘。此时不能只查
 * `getAbstractFileByPath` —— Obsidian 的 metadata cache 未必已经收录刚刚由另一路
 * 并发写出的文件，返回 null 会让我们误判成「不是竞态」而把错误抛上去，那张图就
 * 白白本地化失败了（2026-07-26 实测：image-localization 用例偶发红，单跑必绿）。
 * 所以这里优先走 adapter（不经 metadata cache 的真实文件系统读），
 * 不可用时再退回 Vault API。
 */
type RacedPathState = 'same' | 'different' | 'unreadable'

async function inspectRacedPath(
  vault: Vault,
  filePath: string,
  data: ArrayBuffer,
): Promise<RacedPathState> {
  const adapter = (vault as unknown as {
    adapter?: { readBinary?: (p: string) => Promise<ArrayBuffer> }
  }).adapter
  if (adapter && typeof adapter.readBinary === 'function') {
    try {
      const existing = await adapter.readBinary(filePath)
      return arrayBuffersEqual(existing, data) ? 'same' : 'different'
    } catch {
      // adapter 读不到 → 再给 Vault API 一次机会（轻量替身 / 旧宿主）
    }
  }
  const file = vault.getAbstractFileByPath(filePath)
  if (!file) return 'unreadable'
  return (await fileHasSameContent(vault, file, data)) ? 'same' : 'different'
}

async function fileHasSameContent(
  vault: Vault,
  file: TAbstractFile,
  data: ArrayBuffer,
): Promise<boolean> {
  let existingData: ArrayBuffer
  const readBinary = vault.readBinary.bind(vault) as (target: TAbstractFile | string) => Promise<ArrayBuffer>
  try {
    // 对同名条目直接尝试移动端安全的 Vault API；若它实际是文件夹或已损坏，
    // readBinary 会失败并按“不同内容”处理，不能误复用。
    existingData = await readBinary(file)
  } catch (error) {
    try {
      // 兼容只实现了路径参数的轻量 Vault 替身；真实 Obsidian 使用上面的 TFile。
      existingData = await readBinary(file.path)
    } catch {
      logError(`读取已有图片失败，按文件名碰撞处理: ${file.path}`, error)
      return false
    }
  }
  return arrayBuffersEqual(existingData, data)
}

/**
 * createFolder 失败后判断「目录其实已经可用」。
 * 优先信 adapter（真实文件系统，不经 metadata cache），其次看 Vault API，
 * 最后兜底认「already exists」文案 —— 三者都不成立才认为是真失败。
 */
async function folderUsable(
  vault: Vault,
  folderPath: string,
  error: unknown,
): Promise<boolean> {
  const adapter = (vault as unknown as {
    adapter?: { exists?: (p: string) => Promise<boolean> }
  }).adapter
  if (adapter && typeof adapter.exists === 'function') {
    try {
      if (await adapter.exists(folderPath)) return true
    } catch {
      // adapter 不可用 → 往下退
    }
  }
  if (vault.getAbstractFileByPath(folderPath) instanceof TFolder) return true
  const message = error instanceof Error ? error.message : String(error)
  return /already exists/i.test(message)
}

/**
 * 确保目录存在，且对**并发创建**免疫。
 *
 * 先查后建之间，另一路（同篇图片有界并发、或附件阶段）可能已经把目录建好，
 * 而 metadata cache 未必已收录 → createFolder 抛「Folder already exists」。
 * 这不是错误：吞掉它继续写文件，否则整张图/附件会白白本地化失败
 * （2026-07-26 实测：image-localization 偶发只改写一半，pending retryCount=1）。
 */
export async function ensureFolderExists(
  vault: Vault,
  normalizedFolder: string,
): Promise<void> {
  if (vault.getAbstractFileByPath(normalizedFolder) instanceof TFolder) return
  log(`创建文件夹: ${normalizedFolder}`)
  try {
    await vault.createFolder(normalizedFolder)
  } catch (error) {
    if (!(await folderUsable(vault, normalizedFolder, error))) throw error
    log(`文件夹已由并发路径创建，继续: ${normalizedFolder}`)
  }
}

function appendFileNameSuffix(fileName: string, suffix: string): string {
  const extensionIndex = fileName.lastIndexOf('.')
  if (extensionIndex <= 0) return `${fileName}${suffix}`
  return `${fileName.slice(0, extensionIndex)}${suffix}${fileName.slice(extensionIndex)}`
}

const commitLocks = new WeakMap<Vault, Map<string, Promise<unknown>>>()

/** Coordinate final paths across buffered images and streamed attachments,
 * including a collision suffix that is another download's original filename. */
export async function withVaultPathLock<T>(vault: Vault, path: string, action: () => Promise<T>): Promise<T> {
  const key = normalizePath(path)
  const locks = commitLocks.get(vault) ?? new Map<string, Promise<unknown>>()
  commitLocks.set(vault, locks)
  const previous = locks.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(action)
  locks.set(key, operation)
  try { return await operation } finally { if (locks.get(key) === operation) locks.delete(key) }
}

export async function saveContentAddressed(
  vault: Vault,
  folderPath: string,
  fileName: string,
  data: ArrayBuffer
): Promise<string> {
  const folder = normalizePath(folderPath)
  await ensureFolderExists(vault, folder)
  let fingerprint: string | undefined
  for (let sequence = -1; ; sequence++) {
    if (sequence >= 0) fingerprint ??= calculateHexMD5(new Uint8Array(data))
    const name = sequence < 0 ? fileName : appendFileNameSuffix(fileName, `-${fingerprint}${sequence > 0 ? `-${sequence}` : ''}`)
    const path = normalizePath(`${folder}/${name}`)
    const saved = await withVaultPathLock(vault, path, async () => {
      const existing = vault.getAbstractFileByPath(path)
      if (existing) return await fileHasSameContent(vault, existing, data) ? path : undefined
      try {
        await vault.createBinary(path, data)
        return path
      } catch (error) {
        const raced = await inspectRacedPath(vault, path, data)
        if (raced === 'same') return path
        if (raced === 'unreadable') throw error
        return undefined
      }
    })
    if (saved) return saved
  }
}
