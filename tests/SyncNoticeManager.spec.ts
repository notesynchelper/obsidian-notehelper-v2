import {
  SyncNoticeManager,
  PLAIN_NOTICE_DURATION_MS,
  REMINDER_NOTICE_DURATION_MS,
} from '../src/sync/SyncNoticeManager'
import { Notice } from 'obsidian'

/**
 * jest 跑在 node 环境（无 DOM），而带续费提醒的 Notice 要拼两行 DOM。
 * 这里塞一个最小 document 替身：只实现 composeMessage 用到的那几个方法，
 * 断言「第二行文本 + 点击回调」这两件真正要守的事。
 */
interface FakeNode {
  tag: string
  textContent: string
  className: string
  children: FakeNode[]
  listeners: Record<string, Array<(evt: unknown) => void>>
  appendChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (evt: unknown) => void): void
}

function makeNode(tag: string): FakeNode {
  return {
    tag,
    textContent: '',
    className: '',
    children: [],
    listeners: {},
    appendChild(child: FakeNode) {
      this.children.push(child)
      return child
    },
    addEventListener(type: string, fn: (evt: unknown) => void) {
      this.listeners[type] = this.listeners[type] || []
      this.listeners[type].push(fn)
    },
  }
}

function installFakeDocument(): () => void {
  const g = globalThis as unknown as { document?: unknown }
  const had = Object.prototype.hasOwnProperty.call(g, 'document')
  const prev = g.document
  g.document = {
    createDocumentFragment: () => makeNode('#fragment'),
    createElement: (tag: string) => makeNode(tag),
  }
  return () => {
    if (had) g.document = prev
    else delete g.document
  }
}

describe('SyncNoticeManager', () => {
  describe('progress bar calculation', () => {
    it('starts with 5 blocks, first block filled', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      // Access internal state for testing
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(1)
    })

    it('keeps minimum 5 blocks for small article counts', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(3, false)
      // ceil(3/5) = 1, max(1, 5) = 5
      expect(manager['totalBlocks']).toBe(5)
    })

    it('expands blocks when articles exceed 25', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      // ceil(15/5) = 3, max(3, 5) = 5
      expect(manager['totalBlocks']).toBe(5)

      manager.onBatchProcessed(15, true)
      // ceil(30/5) = 6, max(6, 5) = 6
      expect(manager['totalBlocks']).toBe(6)
    })

    it('caps at 10 blocks', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, false)
      // ceil(60/5) = 12, min(12, 10) = 10
      expect(manager['totalBlocks']).toBe(10)
    })

    it('reserves 1 block when hasNextPage is true', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      // totalBlocks=5, should fill at most 4 (reserve 1)
      expect(manager['filledBlocks']).toBeLessThanOrEqual(4)
    })

    it('fills all blocks when hasNextPage is false', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(10, false)
      expect(manager['filledBlocks']).toBe(manager['totalBlocks'])
    })
  })

  describe('renderProgressBar', () => {
    it('renders correct block pattern', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      const bar = manager['renderProgressBar']('拉取数据...')
      // 1 filled, 4 empty
      expect(bar).toBe('■ □ □ □ □  拉取数据...')
    })

    it('renders mid-progress correctly', () => {
      const manager = new SyncNoticeManager()
      manager['totalBlocks'] = 5
      manager['filledBlocks'] = 3
      const bar = manager['renderProgressBar']('处理文章 15...')
      expect(bar).toBe('■ ■ ■ □ □  处理文章 15...')
    })

    it('renders all filled', () => {
      const manager = new SyncNoticeManager()
      manager['totalBlocks'] = 5
      manager['filledBlocks'] = 5
      const bar = manager['renderProgressBar']('同步完成！')
      expect(bar).toBe('■ ■ ■ ■ ■  同步完成！')
    })
  })

  describe('showError', () => {
    it('shows API key message for 401 status', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      const error = { status: 401, message: 'Unauthorized' }
      manager.showError(error)
      // mainNotice should be cleaned up
      expect(manager['mainNotice']).toBeNull()
    })

    it('shows network error for errors without status', () => {
      const manager = new SyncNoticeManager()
      const error = new Error('fetch failed')
      // Should not throw
      expect(() => manager.showError(error)).not.toThrow()
    })

    it('shows generic message for other status codes', () => {
      const manager = new SyncNoticeManager()
      const error = { status: 500, message: 'Server error' }
      expect(() => manager.showError(error)).not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('handles 0 articles — showNoArticles', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.showNoArticles()
      expect(manager['mainNotice']).toBeNull()
    })

    it('handles 1 article, last page', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(1, false)
      // Should fill all 5 blocks
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(5)
    })

    it('handles exactly 25 articles (boundary for 5 blocks)', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(10, false)
      // ceil(25/5) = 5, max(5, 5) = 5
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(5)
    })

    it('handles exactly 50 articles (boundary for 10 blocks)', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(5, false)
      // ceil(50/5) = 10
      expect(manager['totalBlocks']).toBe(10)
      expect(manager['filledBlocks']).toBe(10)
    })
  })

  describe('phase notices', () => {
    it('completePhase hides and nulls phaseNotice', () => {
      const manager = new SyncNoticeManager()
      manager.showPhaseNotice('处理图片中...')
      expect(manager['phaseNotice']).not.toBeNull()
      manager.completePhase()
      expect(manager['phaseNotice']).toBeNull()
    })

    it('failPhase replaces message and nulls phaseNotice', () => {
      const manager = new SyncNoticeManager()
      manager.showPhaseNotice('处理图片中...')
      manager.failPhase('图片处理失败，文章内容不受影响')
      expect(manager['phaseNotice']).toBeNull()
    })
  })

  describe('会员续费提醒（Notice 第二行）', () => {
    let restoreDocument: () => void

    beforeEach(() => {
      restoreDocument = installFakeDocument()
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
      restoreDocument()
      jest.restoreAllMocks()
    })

    it('没有提醒时消息仍是纯字符串，3 秒后关闭（零回归）', () => {
      const setMessage = jest.spyOn(Notice.prototype, 'setMessage')
      const hide = jest.spyOn(Notice.prototype, 'hide')
      const manager = new SyncNoticeManager()
      manager.startSync()
      setMessage.mockClear()

      manager.completeSync(3)

      expect(typeof setMessage.mock.calls[0][0]).toBe('string')
      expect(setMessage.mock.calls[0][0]).toBe('■ ■ ■ ■ ■  同步完成！3 篇文章')
      jest.advanceTimersByTime(PLAIN_NOTICE_DURATION_MS - 1)
      expect(hide).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1)
      expect(hide).toHaveBeenCalledTimes(1)
    })

    it('带提醒时拼成两行：第一行进度、第二行可点击的续费入口', () => {
      const setMessage = jest.spyOn(Notice.prototype, 'setMessage')
      const onClick = jest.fn()
      const manager = new SyncNoticeManager()
      manager.startSync()
      setMessage.mockClear()

      manager.completeSync(2, { text: '⏳ 会员还有 12 天到期 · 点此续费', onClick })

      const frag = setMessage.mock.calls[0][0] as unknown as FakeNode
      expect(frag.children).toHaveLength(2)
      expect(frag.children[0].textContent).toBe('■ ■ ■ ■ ■  同步完成！2 篇文章')
      expect(frag.children[1].textContent).toBe('⏳ 会员还有 12 天到期 · 点此续费')
      expect(frag.children[1].className).toBe('notehelper-renewal-notice-line')

      // 点第二行 → 打开续费弹窗；同时拦住冒泡，别让 Notice 自带的「点一下就关」
      // 把提醒吞掉（用户会以为没点中）
      const evt = { preventDefault: jest.fn(), stopPropagation: jest.fn() }
      frag.children[1].listeners.click[0](evt)
      expect(onClick).toHaveBeenCalledTimes(1)
      expect(evt.stopPropagation).toHaveBeenCalled()
      expect(evt.preventDefault).toHaveBeenCalled()
    })

    it('带提醒时停留 10 秒（3 秒来不及点）', () => {
      const hide = jest.spyOn(Notice.prototype, 'hide')
      const manager = new SyncNoticeManager()
      manager.startSync()

      manager.completeSync(1, { text: '⌛ 会员已到期 3 天 · 点此续费', onClick: jest.fn() })

      jest.advanceTimersByTime(PLAIN_NOTICE_DURATION_MS)
      expect(hide).not.toHaveBeenCalled()
      jest.advanceTimersByTime(REMINDER_NOTICE_DURATION_MS - PLAIN_NOTICE_DURATION_MS)
      expect(hide).toHaveBeenCalledTimes(1)
    })

    it('「没有新文章」那条也带提醒', () => {
      const setMessage = jest.spyOn(Notice.prototype, 'setMessage')
      const manager = new SyncNoticeManager()
      manager.startSync()
      setMessage.mockClear()

      manager.showNoArticles({ text: '⏳ 试用还有 1 天到期 · 点此开通会员', onClick: jest.fn() })

      const frag = setMessage.mock.calls[0][0] as unknown as FakeNode
      expect(frag.children[0].textContent).toBe('没有新文章需要同步')
      expect(frag.children[1].textContent).toBe('⏳ 试用还有 1 天到期 · 点此开通会员')
    })
  })
})
