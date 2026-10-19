import { MergeMode } from '../settings'

/**
 * 合并文件「一次性说明」：默认的「仅合并消息」会把当天所有消息写进同一篇
 * 《同步助手_日期》，新用户常常不知道为什么。第一次真的写出合并文件后：
 * 弹一条 Notice 说明 + 自动打开这篇合并笔记，之后永不再弹（mergeIntroShown）。
 *
 * 纯函数，副作用（Notice / openFile / 落盘）留在 main.ts。
 */

export interface MergeIntroInput {
  alreadyShown: boolean
  debugActive: boolean
  successCount: number
  mergeMode: MergeMode
  /** 本轮真正收到消息并落盘的合并文件路径（按处理顺序）。 */
  mergedPaths: string[]
  manualSync: boolean
}

export interface MergeIntroDecision {
  notify: boolean
  open: boolean
  path?: string
  /** 打开的标签是否抢焦点：手动同步 true；后台自动同步 false，不打断用户正在写的内容。 */
  activate: boolean
}

export function decideMergeIntro(input: MergeIntroInput): MergeIntroDecision {
  const mergesMessages =
    input.mergeMode === MergeMode.MESSAGES || input.mergeMode === MergeMode.DUAL
  const path = input.mergedPaths[0]
  if (
    input.alreadyShown ||
    input.debugActive ||
    input.successCount <= 0 ||
    !mergesMessages ||
    !path
  ) {
    return { notify: false, open: false, activate: false }
  }
  return { notify: true, open: true, path, activate: input.manualSync }
}

/**
 * 加载阶段：已有同步历史的老用户直接标记为「已提示」，升级后不会突然被打扰。
 * 信号与 shouldSuppressFirstSyncOnLoad 一致（initialSyncCompleted 或游标非空）。
 */
export function shouldSuppressMergeIntroOnLoad(opts: {
  alreadyShown: boolean
  initialSyncCompleted: boolean
  hasSyncHistory: boolean
}): boolean {
  return !opts.alreadyShown && (opts.initialSyncCompleted || opts.hasSyncHistory)
}
