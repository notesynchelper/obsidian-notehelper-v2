/**
 * 图床接力运行器
 *
 * 对本次 sync 本地化写盘完的一批笔记，逐个：
 *   1. 跳过无本地图片的笔记
 *   2. openFile 让其成为 active MarkdownView（第三方插件需要）
 *   3. executeCommandById 触发第三方上传命令
 *   4. 轮询笔记内容直到本地 wiki 归零 / 超时
 *   5. 结束后尝试恢复用户原来的 activeLeaf
 *
 * 任一文件失败不抛，只记录并继续。上层 `syncOmnivore` 不感知异常。
 */
import { App, Notice, TFile, WorkspaceLeaf } from 'obsidian'
import { log, logError } from '../logger'
import { ImageUploadRelay } from '../settings'
import { getRelayTarget, RelayTarget } from './targets'
import { checkRelayReady, describeRelayReason, RelayReadyResult } from './readiness'
import {
  hasLocalImages,
  extractFreshLocalizedLinks,
  waitForRelayDone,
  waitForRenameDone,
  WaitForRelayResult,
  WaitForRenameResult,
  buildScopedLocalImageRegex,
  isPurelyTemplatedFolder,
} from './contentProbe'

export interface RelayRunnerOptions {
  /**
   * 本插件 imageAttachmentFolder 设置（含 `{{...}}` 模板变量的原始字符串）。
   * 构造运行时会提取静态前缀，决定哪些本地 wiki 链接算本插件产物。
   * 避免把用户自己在笔记里加的 `![[assets/diagram.png]]` 误当成接力目标。
   */
  imageAttachmentFolder: string
  /**
   * 单文件总超时基线（毫秒），默认 Math.max(6000, imageCount * 4000)。
   * 调用方一般不需要覆盖；测试里注入小值加速。
   */
  computeTimeoutMs?: (imageCount: number) => number
  /** 文件之间的轮询间隔，透传给 waitForRelayDone */
  pollMs?: number
  /**
   * 仅 kind='rename'：内容连续多少次不变即认定改名收敛（透传 waitForRenameDone.stableReads）。
   */
  renameStableReads?: number
  /**
   * 仅 kind='rename'：openFile 后、触发改名命令前的等待毫秒数，给 metadataCache 一个 beat
   * （改名插件靠 metadataCache.embeds 找图）。默认 300；测试注入 0。
   */
  renameSettleMs?: number
  /** 测试注入 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RelayRunHooks {
  /** 进入 relay 阶段（已过滤无图笔记）时触发一次，total = 需要处理的笔记数 */
  onPhaseStart?: (total: number) => void
  /** 每处理完一个笔记（无论成功/失败/跳过）触发一次 */
  onProgress?: (processed: number, total: number) => void
  /** relay 阶段结束，ok=false 表示至少一个文件超时 */
  onPhaseDone?: (ok: boolean) => void
}

export interface RelayFileReport {
  path: string
  status: 'ok' | 'timeout' | 'skipped' | 'not_ready' | 'command_failed' | 'error'
  remainingLocal: number
  elapsedMs: number
  /** 错误原因，status !== 'ok' 时可能有值 */
  detail?: string
}

export interface RelayRunSummary {
  total: number
  ok: number
  failed: number
  reports: RelayFileReport[]
}

interface InternalCommandRegistry {
  executeCommandById?: (id: string) => boolean
}

/**
 * 计数笔记中当前的本地 wiki 图片数量（供 timeout 估算）。
 * 使用 scopedRegex + global 标志，只计本插件本地化产物，避免 regex lastIndex 副作用。
 */
function countLocalImages(content: string, scopedRegex: RegExp): number {
  const matches = content.match(new RegExp(scopedRegex.source, 'gi'))
  return matches ? matches.length : 0
}

export class RelayRunner {
  private readonly target: RelayTarget
  private readonly scopedRegex: RegExp
  constructor(
    private readonly app: App,
    // 上传接力传 ImageUploadRelay 枚举（内部解析成 target）；改名接力直接传 RelayTarget。
    modeOrTarget: ImageUploadRelay | RelayTarget,
    private readonly options: RelayRunnerOptions,
  ) {
    const t = typeof modeOrTarget === 'string' ? getRelayTarget(modeOrTarget) : modeOrTarget
    if (!t) {
      throw new Error(`RelayRunner 不应以 ImageUploadRelay.NONE 模式实例化: ${String(modeOrTarget)}`)
    }
    this.target = t
    this.scopedRegex = buildScopedLocalImageRegex(options.imageAttachmentFolder)
    if (isPurelyTemplatedFolder(options.imageAttachmentFolder)) {
      // 无静态段可锚定，只能用宽松正则兜底；可能把用户手写的其他本地图片也
      // 算进来。提醒用户至少在 imageAttachmentFolder 里放一段 literal。
      logError(
        '🚚 imageAttachmentFolder 完全由模板变量组成，图床接力无法精确限定范围，可能意外上传用户其他本地图片。建议设置里保留至少一段静态路径（如 `笔记同步助手/{{{date}}}`）。',
        { imageAttachmentFolder: options.imageAttachmentFolder },
      )
    }
  }

  /**
   * 对一批笔记顺序执行接力。出错不抛。
   * @returns 处理摘要；所有超时/失败也计入 failed，供调用方报 Notice
   */
  async runOn(files: TFile[], hooks: RelayRunHooks = {}): Promise<RelayRunSummary> {
    const reports: RelayFileReport[] = []

    // 前置：整体检查一次第三方插件可用性
    const ready = checkRelayReady(this.app, this.target)
    if (!ready.ok) {
      const detail = describeRelayReason(this.target, ready.reason!)
      new Notice(`🚚 图床接力已跳过：${detail}`)
      log(`🚚 图床接力 preflight 失败: ${ready.reason}`, { target: this.target.pluginId })
      hooks.onPhaseDone?.(false)
      return { total: 0, ok: 0, failed: 0, reports }
    }

    // 先一次性扫描需要处理的文件；避免在已处理文件上反复 openFile 抢焦点
    const pending: TFile[] = []
    for (const file of files) {
      try {
        if (await hasLocalImages(this.app, file, this.scopedRegex)) pending.push(file)
      } catch (error) {
        logError('🚚 relay hasLocalImages 失败，跳过:', { path: file.path, error })
      }
    }

    if (pending.length === 0) {
      log('🚚 没有需要接力的笔记（全部无本地图片）')
      hooks.onPhaseDone?.(true)
      return { total: 0, ok: 0, failed: 0, reports }
    }

    hooks.onPhaseStart?.(pending.length)
    log(`🚚 开始图床接力: target=${this.target.pluginId}, files=${pending.length}`)

    // 关键：不复用用户当前 leaf
    //
    // 原因：单 pane workspace 里 getLeaf(false)/getMostRecentLeaf() 都会拿到用户
    // 正在看的 leaf，openFile 会覆盖掉他的当前视图，而 setActiveLeaf(savedLeaf)
    // 对「同一个 leaf 已被覆盖」完全无效。改为建一个专用 relay leaf：
    //   - 全部文件跑完后 detach() 掉，相当于关闭临时 tab；
    //   - 用户原来看的 leaf 不会被碰到，自动保留原样。
    //
    // 失败回退：getLeaf('tab') 在老版本 Obsidian 签名不支持时会 throw，
    // 这里退回 getLeaf(true)（新建 split leaf）；两者都不行就没办法了，
    // 整个 relay 跳过并提示用户。
    const relayLeaf = this.openRelayLeaf()
    if (!relayLeaf) {
      new Notice('🚚 图床接力已跳过：无法创建专用 workspace leaf')
      logError('🚚 无法创建 relay leaf，跳过本轮接力')
      hooks.onPhaseDone?.(false)
      return { total: 0, ok: 0, failed: 0, reports }
    }

    let processed = 0
    try {
      for (const file of pending) {
        const report = await this.runOnFile(file, relayLeaf)
        reports.push(report)
        processed += 1
        hooks.onProgress?.(processed, pending.length)
      }
    } finally {
      // 无论成功失败都关闭 relay leaf；放在 finally 避免异常路径留孤儿 tab
      try {
        relayLeaf.detach()
      } catch (error) {
        logError('🚚 detach relay leaf 失败（不影响接力结果）:', error)
      }
    }

    const failed = reports.filter((r) => r.status !== 'ok' && r.status !== 'skipped').length
    const ok = reports.filter((r) => r.status === 'ok').length
    const summary: RelayRunSummary = {
      total: pending.length,
      ok,
      failed,
      reports,
    }
    log(`🚚 图床接力完成: total=${summary.total}, ok=${summary.ok}, failed=${summary.failed}`)
    hooks.onPhaseDone?.(failed === 0)
    return summary
  }

  /**
   * 开一个专用 relay leaf；老版本 Obsidian 不支持 'tab' 参数时回退到 split。
   */
  private openRelayLeaf(): WorkspaceLeaf | null {
    const ws = this.app.workspace as unknown as {
      getLeaf: (arg: unknown) => WorkspaceLeaf
    }
    try {
      return ws.getLeaf('tab')
    } catch {
      try {
        return ws.getLeaf(true)
      } catch (error) {
        logError('🚚 getLeaf(tab) 与 getLeaf(true) 均失败:', error)
        return null
      }
    }
  }

  private async runOnFile(file: TFile, relayLeaf: WorkspaceLeaf): Promise<RelayFileReport> {
    // 每个文件触发前再检查一次：用户可能在 sync 期间关了第三方插件
    const ready: RelayReadyResult = checkRelayReady(this.app, this.target)
    if (!ready.ok) {
      const detail = describeRelayReason(this.target, ready.reason!)
      return { path: file.path, status: 'not_ready', remainingLocal: -1, elapsedMs: 0, detail }
    }

    let initialContent: string
    try {
      initialContent = await this.app.vault.cachedRead(file)
    } catch (error) {
      return {
        path: file.path,
        status: 'error',
        remainingLocal: -1,
        elapsedMs: 0,
        detail: `读取文件失败: ${String(error)}`,
      }
    }
    const imageCount = countLocalImages(initialContent, this.scopedRegex)
    if (imageCount === 0) {
      return { path: file.path, status: 'skipped', remainingLocal: 0, elapsedMs: 0 }
    }

    // 改名接力：只针对「本次本地化刚落下、尚未改名」的 `_MD5` 哈希名图片。
    // 若该笔记里 scoped 图片都已改过名（无 _MD5 标记）→ 跳过，绝不重复触发 batch 命令，
    // 否则插件对当前文件去重会让文件名在 `标题.png` ↔ `标题-1.png` 之间来回抖动。
    // 完成判据也用这批原始链接是否都消失。上传接力用不到，留空。
    let originalLinks: string[] = []
    let workCount = imageCount
    if (this.target.kind === 'rename') {
      originalLinks = extractFreshLocalizedLinks(initialContent, this.scopedRegex)
      if (originalLinks.length === 0) {
        return { path: file.path, status: 'skipped', remainingLocal: 0, elapsedMs: 0 }
      }
      workCount = originalLinks.length
    }

    const timeoutMs = (this.options.computeTimeoutMs ?? defaultTimeoutMs)(workCount)

    try {
      // 在专用 relay leaf 里打开目标文件；第三方插件的 checkCallback 要求
      // 当前 active MarkdownView 就是该文件。用户原来的 leaf 不会被触碰。
      await relayLeaf.openFile(file, { active: true })
    } catch (error) {
      logError('🚚 openFile 失败:', { path: file.path, error })
      return {
        path: file.path,
        status: 'error',
        remainingLocal: imageCount,
        elapsedMs: 0,
        detail: `openFile 失败: ${String(error)}`,
      }
    }

    // 改名插件靠 metadataCache.embeds 找图；openFile 后给缓存一个 beat 再触发，
    // 免得缓存没就绪导致命令空转（无数据丢失，仅本轮改名不生效，下轮同步会再试）。
    if (this.target.kind === 'rename') {
      const settleMs = this.options.renameSettleMs ?? 300
      if (settleMs > 0) {
        const sleep =
          this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        await sleep(settleMs)
      }
    }

    const commands = (this.app as unknown as { commands?: InternalCommandRegistry }).commands
    const ok = commands?.executeCommandById?.(this.target.commandId) ?? false
    if (!ok) {
      // 命令拒绝执行（例如 checkCallback 未通过）：让用户看到一条 Notice，继续下一文件
      return {
        path: file.path,
        status: 'command_failed',
        remainingLocal: imageCount,
        elapsedMs: 0,
        detail: `命令 ${this.target.commandId} 拒绝执行`,
      }
    }

    return this.target.kind === 'rename'
      ? this.waitRenameOnFile(file, originalLinks, timeoutMs, workCount)
      : this.waitUploadOnFile(file, timeoutMs, imageCount)
  }

  /** 上传接力：等待本地 wiki 链接被改写成 `![](url)`（归零） */
  private async waitUploadOnFile(
    file: TFile,
    timeoutMs: number,
    imageCount: number,
  ): Promise<RelayFileReport> {
    let waitResult: WaitForRelayResult
    try {
      waitResult = await waitForRelayDone(this.app, file, {
        timeoutMs,
        scopedRegex: this.scopedRegex,
        pollMs: this.options.pollMs,
        now: this.options.now,
        sleep: this.options.sleep,
      })
    } catch (error) {
      logError('🚚 waitForRelayDone 异常:', { path: file.path, error })
      return {
        path: file.path,
        status: 'error',
        remainingLocal: imageCount,
        elapsedMs: 0,
        detail: String(error),
      }
    }

    if (!waitResult.ok) {
      log('🚚 接力超时，保留本地链接:', {
        path: file.path,
        remaining: waitResult.remainingLocal,
        elapsedMs: waitResult.elapsedMs,
      })
      return {
        path: file.path,
        status: 'timeout',
        remainingLocal: waitResult.remainingLocal,
        elapsedMs: waitResult.elapsedMs,
      }
    }

    return {
      path: file.path,
      status: 'ok',
      remainingLocal: waitResult.remainingLocal,
      elapsedMs: waitResult.elapsedMs,
    }
  }

  /** 改名接力：等待触发前记录的那批原始链接从内容里消失（被改成新名字） */
  private async waitRenameOnFile(
    file: TFile,
    originalLinks: string[],
    timeoutMs: number,
    imageCount: number,
  ): Promise<RelayFileReport> {
    let waitResult: WaitForRenameResult
    try {
      waitResult = await waitForRenameDone(this.app, file, {
        timeoutMs,
        originalLinks,
        pollMs: this.options.pollMs,
        stableReads: this.options.renameStableReads,
        now: this.options.now,
        sleep: this.options.sleep,
      })
    } catch (error) {
      logError('🚚 waitForRenameDone 异常:', { path: file.path, error })
      return {
        path: file.path,
        status: 'error',
        remainingLocal: imageCount,
        elapsedMs: 0,
        detail: String(error),
      }
    }

    if (!waitResult.ok) {
      log('🚚 改名接力超时:', {
        path: file.path,
        remaining: waitResult.remainingOriginal,
        elapsedMs: waitResult.elapsedMs,
      })
      return {
        path: file.path,
        status: 'timeout',
        remainingLocal: waitResult.remainingOriginal,
        elapsedMs: waitResult.elapsedMs,
      }
    }

    return {
      path: file.path,
      status: 'ok',
      remainingLocal: waitResult.remainingOriginal,
      elapsedMs: waitResult.elapsedMs,
    }
  }
}

/** 默认 timeout 公式：至少 6s，每张图再给 4s */
export function defaultTimeoutMs(imageCount: number): number {
  return Math.max(6000, imageCount * 4000)
}
