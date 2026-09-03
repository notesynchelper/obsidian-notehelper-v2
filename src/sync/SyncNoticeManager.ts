import { Notice } from 'obsidian'

/**
 * 弱升级提醒：附加在同步状态 Notice 下方的一行可点击文字。
 * 点击后由 onClick 打开 Obsidian 第三方插件页，由用户自行完成升级。
 */
export interface SyncUpdateReminder {
  text: string
  onClick: () => void
}

/**
 * 同步完成 Notice 上追加的第二行（会员续费提醒）。
 * text 由 vip/renewalReminder 算好，onClick 弹出续费二维码窗口。
 */
export interface SyncNoticeReminder {
  text: string
  onClick: () => void
}

/** 带提醒（升级 / 续费）时 Notice 的停留时长：3 秒来不及点，给到 10 秒 */
export const REMINDER_NOTICE_DURATION_MS = 10000
/** 不带提醒时的原有停留时长 */
export const PLAIN_NOTICE_DURATION_MS = 3000

export class SyncNoticeManager {
  private mainNotice: Notice | null = null
  private phaseNotice: Notice | null = null
  private totalBlocks: number = 5
  private filledBlocks: number = 0
  private processedCount: number = 0

  /** 终态状态 Notice（同步完成 / 没有新文章），升级提醒行挂在它下面 */
  private statusNotice: Notice | null = null
  private statusHideTimer: number | null = null
  private reminder: SyncUpdateReminder | null = null
  private reminderAttachedTo: Notice | null = null
  /** 本轮终态是否带了续费提醒行（影响自动隐藏时长） */
  private hasRenewalReminder = false

  /** Create the main progress notice, fill first block */
  startSync(): void {
    this.mainNotice = new Notice('', 0)
    this.filledBlocks = 1
    this.mainNotice.setMessage(this.renderProgressBar('拉取数据...'))
  }

  /** Called after each API page is processed */
  onBatchProcessed(count: number, hasNextPage: boolean): void {
    this.processedCount += count
    this.recalcBlocks()

    if (hasNextPage) {
      // Reserve 1 block for remaining pages
      this.filledBlocks = Math.min(
        this.totalBlocks - 1,
        Math.max(this.filledBlocks, Math.ceil(this.processedCount / 5))
      )
    } else {
      // Last page — fill all blocks
      this.filledBlocks = this.totalBlocks
    }

    if (this.mainNotice) {
      this.mainNotice.setMessage(
        this.renderProgressBar(`处理文章 ${this.processedCount}...`)
      )
    }
  }

  /**
   * Fill all blocks, show success message, auto-hide after 3s
   * （带提醒时改为 10s —— 第二行要能点得到）
   */
  completeSync(successCount: number, reminder?: SyncNoticeReminder): void {
    this.filledBlocks = this.totalBlocks
    if (this.mainNotice) {
      const line = this.renderProgressBar(`同步完成！${successCount} 篇文章`)
      this.mainNotice.setMessage(this.composeMessage(line, reminder))
      this.finishStatus(this.mainNotice, reminder)
    }
    this.mainNotice = null
  }

  /** Show "no new articles" for empty sync result */
  showNoArticles(reminder?: SyncNoticeReminder): void {
    if (this.mainNotice) {
      this.mainNotice.setMessage(this.composeMessage('没有新文章需要同步', reminder))
      this.finishStatus(this.mainNotice, reminder)
      this.mainNotice = null
    }
  }

  /**
   * 登记弱升级提醒。若终态状态 Notice 已在显示，立即在其下方附加提醒行；
   * 否则等下一次 completeSync / showNoArticles 渲染时附加。
   */
  setUpdateReminder(reminder: SyncUpdateReminder): void {
    this.reminder = reminder
    this.attachReminderToStatus()
  }

  /**
   * 终态状态渲染完成后的收尾：挂升级提醒行（如有）+ 调度自动隐藏。
   * 必须在最后一次 setMessage 之后调用（setMessage 会清掉 noticeEl 的子节点）。
   *
   * renewalReminder 只用来决定停留时长——它已经由 composeMessage 拼进消息里了。
   */
  private finishStatus(notice: Notice, renewalReminder?: SyncNoticeReminder): void {
    this.statusNotice = notice
    this.hasRenewalReminder = !!renewalReminder
    this.reminderAttachedTo = null
    this.attachReminderToStatus()
    this.scheduleStatusHide()
  }

  private scheduleStatusHide(): void {
    if (!this.statusNotice) return
    if (this.statusHideTimer) window.clearTimeout(this.statusHideTimer)
    const notice = this.statusNotice
    const ms =
      this.reminder || this.hasRenewalReminder
        ? REMINDER_NOTICE_DURATION_MS
        : PLAIN_NOTICE_DURATION_MS
    this.statusHideTimer = window.setTimeout(() => {
      notice.hide()
      if (this.statusNotice === notice) this.statusNotice = null
    }, ms)
  }

  /** 在当前终态状态 Notice 下方附加一行可点击的升级提醒（幂等） */
  private attachReminderToStatus(): void {
    if (!this.reminder || !this.statusNotice) return
    if (this.reminderAttachedTo === this.statusNotice) return
    const el = (this.statusNotice as unknown as { noticeEl?: HTMLElement })
      .noticeEl
    if (!el || typeof el.createEl !== 'function') return
    const line = el.createDiv({
      text: this.reminder.text,
      cls: 'notehelper-update-reminder',
    })
    const onClick = this.reminder.onClick
    line.addEventListener('click', () => onClick())
    this.reminderAttachedTo = this.statusNotice
    // 有提醒行时延长展示时间
    this.scheduleStatusHide()
  }

  /**
   * 没有续费提醒时保持原样（纯字符串，零回归）；有提醒时拼成两行 DOM，
   * 第二行是可点击的续费入口。
   *
   * 点击时 stopPropagation：Notice 自带「点一下就关」，不拦住的话弹窗打开的同一次
   * 点击会连带把 Notice 关掉——功能上没问题，但用户会看到提醒「一点就没了」，
   * 分不清是点中了还是误关。这里让关闭交给超时/再次点击。
   */
  private composeMessage(
    firstLine: string,
    reminder?: SyncNoticeReminder,
  ): string | DocumentFragment {
    if (!reminder) return firstLine
    const frag = createFragment()
    frag.appendChild(createDiv({ text: firstLine }))
    const line2 = createDiv({
      cls: 'notehelper-renewal-notice-line',
      text: reminder.text,
    })
    line2.addEventListener('click', (evt) => {
      evt.preventDefault()
      evt.stopPropagation()
      reminder.onClick()
    })
    frag.appendChild(line2)
    return frag
  }

  /** Show an independent notice for a post-sync phase */
  showPhaseNotice(text: string): void {
    this.phaseNotice = new Notice(text, 0)
  }

  private phaseTotal: number = 0
  private phaseProcessed: number = 0
  private phaseLabel: string = ''

  /** Start a phase with progress bar */
  startPhaseProgress(label: string, total: number): void {
    this.phaseLabel = label
    this.phaseTotal = total
    this.phaseProcessed = 0
    this.phaseNotice = new Notice('', 0)
    this.phaseNotice.setMessage(this.renderPhaseBar())
  }

  /** Update phase progress by one step */
  onPhaseItemProcessed(): void {
    this.phaseProcessed++
    if (this.phaseNotice) {
      this.phaseNotice.setMessage(this.renderPhaseBar())
    }
  }

  private renderPhaseBar(): string {
    const total = this.phaseTotal
    // 钳制到 [0, total]：图片级进度下，失败文件重试会让同一批图被重复计数，
    // 可能把 processed 顶过 total —— 显示上绝不超过 100%（不出现「9/8」）。
    const processed = Math.min(Math.max(this.phaseProcessed, 0), Math.max(total, 0))
    const blocks = Math.max(total, 1)
    const filled = '■'
    const empty = '□'
    // 最多显示 10 个方块，按比例映射
    const maxBlocks = Math.min(blocks, 10)
    const filledCount = blocks <= 10
      ? processed
      : Math.round((processed / total) * maxBlocks)
    const bar = Array(maxBlocks)
      .fill(null)
      .map((_, i) => (i < filledCount ? filled : empty))
      .join(' ')
    return `${bar}  ${this.phaseLabel} ${processed}/${total}`
  }

  /** Hide the current phase notice (success) */
  completePhase(): void {
    if (this.phaseNotice) {
      this.phaseNotice.hide()
      this.phaseNotice = null
    }
  }

  /** Replace phase notice with failure message, auto-hide after 5s */
  failPhase(text: string): void {
    if (this.phaseNotice) {
      this.phaseNotice.setMessage(text)
      const notice = this.phaseNotice
      window.setTimeout(() => notice.hide(), 5000)
      this.phaseNotice = null
    }
  }

  /** Show error notice based on error type */
  showError(error: unknown): void {
    const status = (error as { status?: number })?.status
    if (status === 401) {
      new Notice('API 密钥无效，请前往「笔记同步助手」公众号重新获取', 10000)
    } else if (status === undefined || status === null) {
      new Notice('网络连接失败，请检查网络后重试', 5000)
    } else {
      new Notice('同步失败，请稍后重试', 5000)
    }
    // Clean up main notice if it exists
    if (this.mainNotice) {
      this.mainNotice.hide()
      this.mainNotice = null
    }
  }

  private renderProgressBar(label: string): string {
    const filled = '■'
    const empty = '□'
    const blocks = Array(this.totalBlocks)
      .fill(null)
      .map((_, i) => (i < this.filledBlocks ? filled : empty))
      .join(' ')
    return `${blocks}  ${label}`
  }

  private recalcBlocks(): void {
    this.totalBlocks = Math.min(
      Math.max(Math.ceil(this.processedCount / 5), 5),
      10
    )
  }
}
