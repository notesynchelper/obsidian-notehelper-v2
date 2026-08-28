/**
 * 多选转发（聊天记录）末尾多一个空行（设计文档 A3，问题 3）。
 *
 * 根因：聊天记录的 content 自带尾换行（每条内层消息后 `\n\n`），
 * renderWeChatMessageSimple 不 trim；MergeProcessor 只对整段渲染结果 trimEnd()，
 * 模板里 {{{content}}} 后面还有 `- - -` 之类的收尾行时，空行就留在中间。
 */
import { Item } from '@omnivore-app/api'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'
import { renderWeChatMessageSimple } from '../src/settings/template'

const DATE_FORMAT = 'yyyy-MM-dd HH:mm:ss'
const CHAT_RECORD =
  '**2026/08/27 08:32:15**\n这个链接的设置最好能像消息模板设置一样\n\n**2026/08/27 08:33:07**\n目前这种设置只能紧跟着上文的内容\n\n'
const TEMPLATE = '- {{{dateSaved}}}\n{{{content}}}\n- - -'

function makeMessage(id: string, content: string, savedAt = '2026-08-27T00:32:15.000Z'): Item {
  return {
    id,
    title: '同步助手_20260827_聊天记录_聊天记录',
    savedAt,
    updatedAt: savedAt,
    content,
    url: 'https://example.com',
    slug: 'message',
    labels: [],
    highlights: [],
    siteName: '企业微信',
  } as unknown as Item
}

describe('A3 renderWeChatMessageSimple：聊天记录尾部空白', () => {
  test('content 自带尾换行时，{{{content}}} 与后面的收尾行之间不留空行', () => {
    const rendered = renderWeChatMessageSimple(makeMessage('id-1', CHAT_RECORD), DATE_FORMAT, TEMPLATE)
    expect(rendered).toContain('目前这种设置只能紧跟着上文的内容\n- - -')
    expect(rendered).not.toContain('\n\n- - -')
    expect(rendered.endsWith('- - -')).toBe(true)
  })

  test('单条消息（无尾换行）输出与原来逐字节一致', () => {
    const rendered = renderWeChatMessageSimple(
      makeMessage('id-2', '万载时代项目现场，停机检修过程中发现'),
      DATE_FORMAT,
      TEMPLATE,
    )
    expect(rendered).toBe('- 2026-08-27 00:32:15\n万载时代项目现场，停机检修过程中发现\n- - -')
  })

  test('content 开头的空行也去掉；正文中间的段落空行保留', () => {
    const rendered = renderWeChatMessageSimple(
      makeMessage('id-3', '\n\n第一段\n\n第二段\n'),
      DATE_FORMAT,
      '{{{content}}}\n- - -',
    )
    expect(rendered).toBe('第一段\n\n第二段\n- - -')
  })

  test('content 为空时仍渲染为空串（不抛错）', () => {
    const rendered = renderWeChatMessageSimple(makeMessage('id-4', ''), DATE_FORMAT, '[{{{content}}}]')
    expect(rendered).toBe('[]')
  })
})

// ---- MergeProcessor 层：写进合并文件后也不留空行 ----
const FILE = { path: 'journals/2026-08-27.md', basename: '2026-08-27' } as unknown as import('obsidian').TFile

function makeContext(initialContent = '') {
  let fileContent = initialContent
  return {
    burnTracker: new BurnDeleteTracker(),
    imageLocalizer: null,
    settings: {
      messageSortOrder: MessageSortOrder.ASC,
      dateSavedFormat: DATE_FORMAT,
      wechatMessageTemplate: TEMPLATE,
      mergeFileTemplate: '',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      burnAfterReading: false,
      burnAfterReadingEnabledAt: '',
      deviceSyncCursors: {},
      pendingBurnDeletes: [],
      disableMessageMarkers: true,
      omitFrontmatterId: true,
    },
    app: {
      vault: {
        process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
          fileContent = fn(fileContent)
          return fileContent
        }),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    getFileContent: () => fileContent,
  }
}

describe('A3 MergeProcessor：聊天记录落盘后 - - - 前无空行', () => {
  test('聊天记录 + 后续单条消息：两块之间、块内收尾行前都没有多余空行', async () => {
    const ctx = makeContext()
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const items: MergeBatchItem[] = [
      { item: makeMessage('id-a', CHAT_RECORD, '2026-08-27T00:33:07.000Z'), content: '' },
      { item: makeMessage('id-b', '万载时代项目现场', '2026-08-27T00:40:00.000Z'), content: '' },
    ]
    await new MergeProcessor(ctx as never).processBatch(items, FILE)
    const body = ctx.getFileContent()
    expect(body).toContain('目前这种设置只能紧跟着上文的内容\n- - -')
    expect(body).not.toContain('\n\n- - -')
    expect(body).toContain('万载时代项目现场\n- - -')
  })
})
