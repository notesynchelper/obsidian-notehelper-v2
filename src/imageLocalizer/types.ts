/**
 * 图片本地化相关的类型定义
 */

import { TFile } from 'obsidian'
import { LocalizerItemMeta } from '../common/localizerItemMeta'

/**
 * 图片信息
 */
export interface ImageInfo {
  /** 原始URL */
  originalUrl: string
  /** 图片在笔记中的原始文本（包含markdown语法） */
  originalText: string
  /** alt文本或caption */
  alt?: string
  /** 图片尺寸信息（如果有） */
  size?: string
  /** 匹配的起始位置 */
  startIndex: number
  /** 匹配的结束位置 */
  endIndex: number
}

/**
 * 本地化任务
 */
export interface LocalizeTask {
  /** 笔记文件 */
  file: TFile
  /** 需要处理的图片列表 */
  images: ImageInfo[]
  /** 任务创建时间 */
  createdAt: number
  /** 重试次数 */
  retryCount: number
  /**
   * 笔记的 Item 上下文 snapshot；generateFolderPath 用它给 render() 喂真实
   * siteName/author/originalUrl/publishedAt 等模板变量。同文件二次 enqueue
   * 时会在已有 task 上直接覆盖此字段（last-write-wins），与历史
   * fileSavedAtMap 行为一致。
   */
  meta?: LocalizerItemMeta
  /**
   * 连续「本轮只剩永久死链（404/410），且没有任何瞬态失败」的轮次数。
   * 任一轮出现瞬态失败即清零；达到 NOT_FOUND_ROUND_BUDGET 即退休该任务
   * （见 imageLocalizer.drainQueue）。缺省视作 0。
   */
  notFoundRounds?: number
}

/**
 * 下载失败的原因分类 —— 上层据此区分「永久死链」与「瞬态失败」，两者的重试
 * 策略完全不同（见 imageLocalizer 的 NOT_FOUND_ROUND_BUDGET）：
 * - `not-found`：服务端明确回 404/410，且已在**所有可用备用线路**上交叉验证过
 *   （或命中权威源站）。这类图再重试多少次也回不来。
 * - `transient`：其它一切失败（超时 / 5xx / 断网 / 坏包 / 占位页 / 半截图）。
 *   按瞬态处理、永久重试，绝不丢弃（钉红：Defect B）。
 * 成功时不设置该字段。
 */
export type DownloadFailureKind = 'not-found' | 'transient'

/**
 * 图片下载结果
 */
export interface DownloadResult {
  /** 是否成功 */
  success: boolean
  /** 本地文件路径 */
  localPath?: string
  /** 错误信息 */
  error?: string
  /** 文件内容（ArrayBuffer） */
  data?: ArrayBuffer
  /** 失败原因分类；success=true 时不设置 */
  failureKind?: DownloadFailureKind
}

/**
 * 单个文件本轮本地化「未完成原因」的回填出参（sink）。
 *
 * localizeFile 的返回值仍是 boolean（历史契约，多处测试/调用方依赖），失败原因
 * 通过这个可选出参回填给 drainQueue，让它能区分：
 *   - 只剩服务端确认不存在的死图 → 计入有界预算，耗尽即退休；
 *   - 存在瞬态失败 → 永久重试，预算清零。
 * 不传 sink 时行为与历史完全一致（一律按瞬态处理）。
 */
export interface FileLocalizeOutcome {
  /** 本轮至少有一张图被服务端确认不存在（404/410，且跨可用线路交叉验证过） */
  hasNotFound: boolean
  /** 本轮至少有一次瞬态失败（下载/保存/读写/校验），含整文件级错误 */
  hasTransient: boolean
  /** 本轮判定为永久不存在的图片 URL（日志/诊断用，已去重） */
  notFoundUrls: string[]
}

export function emptyFileLocalizeOutcome(): FileLocalizeOutcome {
  return { hasNotFound: false, hasTransient: false, notFoundUrls: [] }
}

/**
 * 图片处理选项
 */
export interface ImageProcessOptions {
  /** 是否启用PNG转JPEG */
  enablePngToJpeg: boolean
  /** JPEG质量（0-100） */
  jpegQuality: number
  /** 图片存储文件夹模板 */
  attachmentFolder: string
  /** 文件夹日期格式 */
  folderDateFormat: string
  /** 下载重试次数 */
  maxRetries: number
  /** 重试延迟（毫秒） */
  retryDelay: number
}

/** detectRemoteImages 的可判别结果，读失败绝不伪装成“确实没有远程图”。 */
export type RemoteImageDetectionResult =
  | { status: 'ok'; images: ImageInfo[] }
  | { status: 'read-failed'; images: [] }

/** enqueueFile 的明确结果，右键入口据此区分无任务与扫描失败。 */
export type ImageEnqueueResult =
  | 'enqueued'
  | 'already-queued'
  | 'processing'
  | 'no-remote-images'
  | 'read-failed'
