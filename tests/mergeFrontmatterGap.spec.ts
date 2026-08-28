/**
 * 合并文件属性块与正文之间的空行（设计文档 A5，问题 5）。
 *
 * 根因：MergeProcessor 重写属性块时固定接 `---\n\n`，用户合并文件模板里 `---` 后紧跟
 * 正文（`# 晨间记录`），第一次同步后就多出一个空行（编辑模式可见）。
 * 修法：保留文件原有的「闭合 --- 行 → 正文」间距，而不是固定一个空行。
 *
 * 🔴 边界：空属性块（`---\n---`）保持 `\n\n` 不变 —— `---\n---\n---\n…` 会把消息模板的
 * `---` 分隔线吞进 YAML 抛 YAMLException（见 MergeProcessor fmMatch 注释）。
 */
import { Item } from '@omnivore-app/api'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'
import { renderMergeFileTemplate } from '../src/sync/mergeFileTemplate'

const FILE = { path: 'journals/2026-08-27.md', basename: '2026-08-27' } as unknown as import('obsidian').TFile
const MSG_TEMPLATE = '- {{{dateSaved}}}\n{{{content}}}'

function makeMessage(id: string, savedAt: string, content: string): Item {
  return {
    id,
    title: '同步助手_20260827_001_文本',
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

function makeArticle(id: string, savedAt: string): Item {
  return { ...makeMessage(id, savedAt, ''), title: '普通文章', siteName: 'example.com' } as unknown as Item
}

function makeContext(initialContent: string, settings: Record<string, unknown> = {}) {
  let fileContent = initialContent
  return {
    burnTracker: new BurnDeleteTracker(),
    imageLocalizer: null,
    settings: {
      messageSortOrder: MessageSortOrder.ASC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate: MSG_TEMPLATE,
      mergeFileTemplate: '',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      burnAfterReading: false,
      burnAfterReadingEnabledAt: '',
      deviceSyncCursors: {},
      pendingBurnDeletes: [],
      // 三个「不写 id」开关全开（用户画像）：属性块里只剩用户自己的字段
      disableMessageMarkers: true,
      omitFrontmatterId: true,
      ...settings,
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

async function process(ctx: ReturnType<typeof makeContext>, items: MergeBatchItem[]) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  await new MergeProcessor(ctx as never).processBatch(items, FILE)
}

const m1 = (): MergeBatchItem => ({ item: makeMessage('id-1', '2026-08-27T00:32:15.000Z', '第一条'), content: '' })
const m2 = (): MergeBatchItem => ({ item: makeMessage('id-2', '2026-08-27T01:00:00.000Z', '第二条'), content: '' })

describe('A5 属性块与正文之间的空行：保留文件原有间距', () => {
  test('① 属性块后紧跟正文：同步后仍然没有空行', async () => {
    const ctx = makeContext('---\na: 1\n---\n# 头\n')
    await process(ctx, [m1()])
    const out = ctx.getFileContent()
    expect(out.startsWith('---\na: 1\n---\n# 头\n')).toBe(true)
    expect(out).toContain('第一条')
  })

  test('② 用户自己留了一个空行：保留一个（不增不减）', async () => {
    const ctx = makeContext('---\na: 1\n---\n\n# 头\n')
    await process(ctx, [m1()])
    const out = ctx.getFileContent()
    expect(out.startsWith('---\na: 1\n---\n\n# 头\n')).toBe(true)
    expect(out.startsWith('---\na: 1\n---\n\n\n')).toBe(false)
  })

  test('②b 用户留了两个空行：原样保留', async () => {
    const ctx = makeContext('---\na: 1\n---\n\n\n# 头\n')
    await process(ctx, [m1()])
    expect(ctx.getFileContent().startsWith('---\na: 1\n---\n\n\n# 头\n')).toBe(true)
  })

  test('③ 空属性块仍然固定 ---\\n---\\n\\n（不回归 YAMLException 那条老路）', async () => {
    for (const initial of ['---\n---\n# 头\n', '---\n---\n\n# 头\n', '']) {
      const ctx = makeContext(initial)
      await process(ctx, [m1()])
      expect(ctx.getFileContent().startsWith('---\n---\n\n')).toBe(true)
      expect(ctx.getFileContent().startsWith('---\n---\n\n\n')).toBe(false)
    }
  })

  test('④ 第二轮同步幂等：换行不累加、也不被吃掉', async () => {
    const noGap = makeContext('---\na: 1\n---\n# 头\n')
    await process(noGap, [m1()])
    await process(noGap, [m2()])
    const out = noGap.getFileContent()
    expect(out.startsWith('---\na: 1\n---\n# 头\n')).toBe(true)
    expect(out).toContain('第一条')
    expect(out).toContain('第二条')

    const oneGap = makeContext('---\na: 1\n---\n\n# 头\n')
    await process(oneGap, [m1()])
    await process(oneGap, [m2()])
    expect(oneGap.getFileContent().startsWith('---\na: 1\n---\n\n# 头\n')).toBe(true)
    expect(oneGap.getFileContent().startsWith('---\na: 1\n---\n\n\n')).toBe(false)
  })

  test('⑤ 用户画像：合并文件模板 `---` 后紧跟标题 + 降序插入 → 标题紧贴属性块', async () => {
    // 注：用户真实模板还有 `date: {{{date}}}`，但 parseYaml/stringifyYaml 往返会把
    // `2026-08-27` 变成 Date 再序列化成 ISO 串 —— 那是既有行为、与本项无关，测试里避开。
    const template = '---\nplace: 南京\ntrip: false\n---\n# 晨间记录'
    const initial = renderMergeFileTemplate(template, { date: '2026-08-27', title: '2026-08-27' })
    expect(initial).toBe('---\nplace: 南京\ntrip: false\n---\n# 晨间记录\n')
    const ctx = makeContext(initial, {
      mergeFileTemplate: template,
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: '---\n{{{timeSaved}}}\n{{{content}}}\n- - -',
    })
    await process(ctx, [m1()])
    await process(ctx, [m2()])
    const out = ctx.getFileContent()
    const head = '---\nplace: 南京\ntrip: false\n---\n# 晨间记录\n'
    expect(out.slice(0, head.length)).toBe(head)
    expect(out).not.toContain('---\n\n# 晨间记录')
    // 消息插在文件头之下，两条都在
    expect(out.indexOf('第二条')).toBeLessThan(out.indexOf('第一条'))
  })

  test('⑥ 属性块只有属性、正文为空（模板不带标题）：闭合线后没空行就不补', async () => {
    const ctx = makeContext('---\na: 1\n---\n')
    await process(ctx, [m1()])
    const out = ctx.getFileContent()
    expect(out.startsWith('---\na: 1\n---\n- 2026-08-27 00:32:15\n第一条')).toBe(true)
    // 第二轮：属性块边界不漂移
    await process(ctx, [m2()])
    expect(ctx.getFileContent().startsWith('---\na: 1\n---\n- 2026-08-27 00:32:15\n第一条')).toBe(true)
    expect(ctx.getFileContent()).toContain('第二条')
  })
})

describe('A5 零回归：历史形态的文件仍是一个空行', () => {
  test('文件原本没有属性块（全新空文件 / 纯正文）：写入后属性块与正文之间一个空行', async () => {
    const article = { item: makeArticle('a1', '2026-08-27T00:00:00.000Z'), content: '文章正文' }
    // 默认开关（写 syncedIds），属性块非空
    const fresh = makeContext('', { disableMessageMarkers: false, omitFrontmatterId: false })
    await process(fresh, [article])
    expect(fresh.getFileContent()).toMatch(/^---\nsyncedIds: [^\n]+\n---\n\n文章正文/)

    const legacy = makeContext('旧正文\n', { disableMessageMarkers: false, omitFrontmatterId: false })
    await process(legacy, [article])
    expect(legacy.getFileContent()).toMatch(/^---\nsyncedIds: [^\n]+\n---\n\n旧正文/)
  })

  test('既有测试的常见种子 `---\\nsyncedIds: …\\n---\\n\\n`（正文为空）：仍是一个空行', async () => {
    const article = { item: makeArticle('a1', '2026-08-27T00:00:00.000Z'), content: '文章正文' }
    const ctx = makeContext('---\nsyncedIds: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n---\n\n', {
      disableMessageMarkers: false,
      omitFrontmatterId: false,
    })
    await process(ctx, [article])
    expect(ctx.getFileContent()).toMatch(/^---\nsyncedIds: [^\n]+\n---\n\n文章正文/)
  })
})
