/**
 * 工单（2026-09-24）同一条：附件下载失败的任务只在内存队列里，重启 Obsidian 就丢了，
 * 已同步过的笔记不会再被拉回来入队 —— 用户只能等自己想起来右键「重新本地化」。
 * 失败任务必须像图片一样落盘，重启后续传。
 */

import { TFile } from 'obsidian'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import {
  downloadAttachment,
  isRemoteAttachment,
} from '../src/attachmentLocalizer/attachmentDownloader'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'

jest.mock('../src/attachmentLocalizer/attachmentDownloader', () => ({
  ...jest.requireActual('../src/attachmentLocalizer/attachmentDownloader'),
  downloadAttachment: jest.fn(),
  isRemoteAttachment: jest.fn(),
}))
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

const mockDownload = downloadAttachment as jest.MockedFunction<typeof downloadAttachment>
const mockIsRemote = isRemoteAttachment as jest.MockedFunction<typeof isRemoteAttachment>

const OPTIONS = {
  attachmentFolder: 'attachments',
  folderDateFormat: 'yyyy-MM-dd',
  maxRetries: 0,
  retryDelay: 0,
}

function makeVault(file: TFile, initial: string) {
  const state = { body: initial }
  const vault = {
    read: jest.fn(async () => state.body),
    process: jest.fn(async (_f: TFile, fn: (c: string) => string) => {
      state.body = fn(state.body)
      return state.body
    }),
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    createFolder: jest.fn().mockResolvedValue(undefined),
    createBinary: jest.fn().mockResolvedValue(undefined),
  }
  return { vault, state, resolve: (p: string) => (p === file.path ? file : null) }
}

function memoryPersister() {
  let data: unknown = {}
  return {
    load: async () => data,
    save: async (d: unknown) => {
      data = JSON.parse(JSON.stringify(d))
    },
  }
}

describe('附件失败任务跨重启续传', () => {
  beforeEach(() => {
    mockDownload.mockReset()
    mockIsRemote.mockReturnValue(true)
  })

  test('会话一失败落盘 → 重启后续传成功并清掉记录', async () => {
    const file = new TFile()
    file.path = '同步助手/聊天记录.md'
    file.basename = '聊天记录'
    const { vault, state, resolve } = makeVault(
      file,
      '📎 [AIDSO爱搜——白皮书.pdf](https://media30d.clipfx.app/wecom4/x) (17.37MB)',
    )
    const persister = memoryPersister()

    // 会话一
    const store1 = new PendingLocalizeStore(persister)
    await store1.load()
    const s1 = new AttachmentLocalizer({ vault } as any, OPTIONS, store1)
    mockDownload.mockResolvedValueOnce({ success: false, error: '请求超时' })
    expect(await s1.enqueueFile(file, { savedAt: '2026-09-24T19:58:06+08:00' })).toBe('enqueued')
    await s1.processQueue()
    expect(store1.get(file.path)).toMatchObject({ retryCount: 1 })
    await store1.flush()

    // 重启：全新实例，内存队列为空
    const store2 = new PendingLocalizeStore(persister)
    await store2.load()
    const s2 = new AttachmentLocalizer({ vault } as any, OPTIONS, store2)
    mockDownload.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(4) })
    const resumed = s2.resumePending(resolve)
    expect(resumed).toBe(1)
    expect(store2.get(file.path)?.meta).toEqual({ savedAt: '2026-09-24T19:58:06+08:00' })

    await s2.processQueue()
    expect(state.body).toContain('📎 [[attachments/AIDSO爱搜——白皮书.pdf|AIDSO爱搜——白皮书.pdf]]')
    expect(store2.get(file.path)).toBeUndefined()
  })

  test('续传跳过已在队列里的任务；笔记已删除的记录被清掉', async () => {
    const file = new TFile()
    file.path = 'a.md'
    file.basename = 'a'
    const { vault, resolve } = makeVault(file, '📎 [x.pdf](https://media30d.clipfx.app/x) (1MB)')
    const store = new PendingLocalizeStore(memoryPersister())
    store.upsert({ filePath: 'gone.md', retryCount: 2, createdAt: 1 })

    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)
    expect(await loc.enqueueFile(file)).toBe('enqueued')
    expect(loc.resumePending(resolve)).toBe(0)

    expect(loc.getQueueStats().pending).toBe(1)
    expect(store.get('a.md')).toBeDefined()
    expect(store.get('gone.md')).toBeUndefined()
  })

  test('源站确认过期（terminal）的任务不留续传记录', async () => {
    const file = new TFile()
    file.path = 'b.md'
    file.basename = 'b'
    const { vault, resolve } = makeVault(file, '📎 [y.pdf](https://media30d.clipfx.app/y) (1MB)')
    const store = new PendingLocalizeStore(memoryPersister())
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)
    mockDownload.mockResolvedValueOnce({ success: false, error: '文件已过期', expired: true })

    await loc.enqueueFile(file)
    await loc.processQueue()
    expect(store.get('b.md')).toBeUndefined()
  })

  test('笔记改名后续传记录跟着走', async () => {
    const file = new TFile()
    file.path = 'old.md'
    file.basename = 'old'
    const { vault, resolve } = makeVault(file, '📎 [z.pdf](https://media30d.clipfx.app/z) (1MB)')
    const store = new PendingLocalizeStore(memoryPersister())
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)
    mockDownload.mockResolvedValueOnce({ success: false, error: 'HTTP 502' })
    await loc.enqueueFile(file)
    await loc.processQueue()

    loc.handleNoteRename('old.md', 'new.md')
    expect(store.get('old.md')).toBeUndefined()
    expect(store.get('new.md')).toMatchObject({ retryCount: 1 })
  })

  test('下载时把附件行里的大小传给下载器', async () => {
    const file = new TFile()
    file.path = 'c.md'
    file.basename = 'c'
    const { vault } = makeVault(file, '📎 [w.pdf](https://media30d.clipfx.app/w) (17.37MB)')
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS)
    mockDownload.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(4) })

    await loc.enqueueFile(file)
    await loc.processQueue()
    expect(mockDownload).toHaveBeenCalledWith(
      'https://media30d.clipfx.app/w',
      0,
      0,
      { expectedBytes: Math.round(17.37 * 1024 * 1024) },
    )
  })

  test('入队即落盘；前一个失败后立刻更新记录，不等整批跑完', async () => {
    const a = new TFile(); a.path = 'a.md'; a.basename = 'a'
    const b = new TFile(); b.path = 'b.md'; b.basename = 'b'
    const bodies: Record<string, string> = {
      'a.md': '📎 [a.pdf](https://media30d.clipfx.app/a) (1MB)',
      'b.md': '📎 [b.pdf](https://media30d.clipfx.app/b) (1MB)',
    }
    const vault = {
      read: jest.fn(async (f: TFile) => bodies[f.path]),
      process: jest.fn(),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createFolder: jest.fn(),
      createBinary: jest.fn(),
    }
    const store = new PendingLocalizeStore(memoryPersister())
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)

    await loc.enqueueFile(a)
    await loc.enqueueFile(b)
    expect(store.get('a.md')).toMatchObject({ retryCount: 0 })
    expect(store.get('b.md')).toMatchObject({ retryCount: 0 })

    let releaseB!: () => void
    mockDownload
      .mockResolvedValueOnce({ success: false, error: 'HTTP 502' })
      .mockImplementationOnce(
        () => new Promise((r) => { releaseB = () => r({ success: false, error: 'x' }) }),
      )
    const running = loc.processQueue()
    await new Promise((r) => setImmediate(r))
    expect(store.get('a.md')).toMatchObject({ retryCount: 1 })
    releaseB()
    await running
  })

  test('续传不重复挂正在处理中的任务', async () => {
    const file = new TFile(); file.path = 'busy.md'; file.basename = 'busy'
    const { vault, resolve } = makeVault(file, '📎 [p.pdf](https://media30d.clipfx.app/p) (1MB)')
    const store = new PendingLocalizeStore(memoryPersister())
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)
    let release!: () => void
    mockDownload.mockImplementationOnce(
      () => new Promise((r) => { release = () => r({ success: true, data: new ArrayBuffer(1) }) }),
    )
    await loc.enqueueFile(file)
    const running = loc.processQueue()
    await new Promise((r) => setImmediate(r))

    expect(store.get('busy.md')).toBeDefined()
    expect(loc.resumePending(resolve)).toBe(0)
    expect(loc.getQueueStats().pending).toBe(0)

    release()
    await running
    expect(store.get('busy.md')).toBeUndefined()
  })

  test('续传时笔记暂时读不出来，任务仍留在队列里，下一轮自动重试', async () => {
    const file = new TFile(); file.path = 'r.md'; file.basename = 'r'
    const { vault, state, resolve } = makeVault(file, '📎 [q.pdf](https://media30d.clipfx.app/q) (1MB)')
    vault.read.mockRejectedValueOnce(new Error('EBUSY'))
    const store = new PendingLocalizeStore(memoryPersister())
    store.upsert({ filePath: 'r.md', retryCount: 1, createdAt: 1 })
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)

    expect(loc.resumePending(resolve)).toBe(1)
    const first = await loc.processQueue()
    expect(first.failed).toBe(1)
    expect(store.get('r.md')).toMatchObject({ retryCount: 2 })

    mockDownload.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(1) })
    const second = await loc.processQueue()
    expect(second.succeeded).toBe(1)
    expect(state.body).toContain('📎 [[attachments/q.pdf|q.pdf]]')
    expect(store.get('r.md')).toBeUndefined()
  })

  test('已排队任务刷新 meta 时同步更新续传记录', async () => {
    const file = new TFile(); file.path = 'm.md'; file.basename = 'm'
    const { vault } = makeVault(file, '📎 [m.pdf](https://media30d.clipfx.app/m) (1MB)')
    const store = new PendingLocalizeStore(memoryPersister())
    const loc = new AttachmentLocalizer({ vault } as any, OPTIONS, store)

    await loc.enqueueFile(file, { savedAt: '2026-09-24', siteName: '旧' })
    expect(await loc.enqueueFile(file, { savedAt: '2026-09-24', siteName: '新' })).toBe('already-queued')
    expect(store.get('m.md')?.meta).toMatchObject({ siteName: '新' })
  })
})
