/**
 * timeSaved / timeSavedShort 在各渲染入口的接线（设计文档 A2，问题 2）。
 *
 * 底座 commit 439564a 在 DateView 上新增了 timeSaved(HH:mm:ss) / timeSavedShort(HH:mm)。
 * 这组用例钉住：文件夹 / 文件名（render）、正文 + 前置元数据（renderItemContent）、
 * 助手消息模板（A1 已接）三条渲染路径都真的暴露了这两个变量 —— 任何一处 view 改回
 * 手写字段漏掉它们，这里立刻红。
 */
import { Item } from '@omnivore-app/api'
import {
  render,
  renderFilename,
  renderItemContent,
  renderWeChatMessageSimple,
} from '../src/settings/template'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article',
    author: 'Test Author',
    description: null,
    slug: 'test-slug',
    labels: [],
    highlights: [],
    updatedAt: '2024-03-20T08:15:00.000Z',
    // jest 固定 TZ=UTC，时分秒按 UTC 断言
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: 'body text',
    publishedAt: null,
    url: 'https://example.com/article',
    image: null,
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as Item
}

describe('timeSaved / timeSavedShort 接线', () => {
  test('render()：文件夹 / 文件名模板可用，且不受日期格式影响', () => {
    const item = makeItem()
    expect(render(item, '{{{timeSaved}}}|{{{timeSavedShort}}}', 'yyyy-MM-dd')).toBe(
      '10:30:00|10:30',
    )
    expect(render(item, '{{{timeSaved}}}', 'yyyy')).toBe('10:30:00')
    expect(renderFilename(item, '{{{title}}}-{{{timeSavedShort}}}', 'yyyy-MM-dd')).toBe(
      'Test Article-10:30',
    )
  })

  test('renderItemContent()：正文模板与前置元数据模板都能取到', () => {
    const item = makeItem()
    const content = renderItemContent(
      item,
      '# {{{title}}}\n保存于 {{{timeSaved}}} / {{{timeSavedShort}}}\n{{{content}}}',
      'LOCATION',
      undefined,
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd HH:mm:ss',
      false,
      [],
      'saved_time: {{{timeSaved}}}\nsaved_short: {{{timeSavedShort}}}',
      '',
      '',
    )
    expect(content).toContain('保存于 10:30:00 / 10:30')
    expect(content).toMatch(/saved_time: ['"]?10:30:00['"]?/)
    expect(content).toMatch(/saved_short: ['"]?10:30['"]?/)
  })

  test('助手消息模板（合并模式）同样可用', () => {
    const item = makeItem({ title: '同步助手_20240115_001_文本', content: '一条消息' })
    expect(
      renderWeChatMessageSimple(item, 'yyyy-MM-dd', '{{{timeSaved}}} {{{content}}}'),
    ).toBe('10:30:00 一条消息')
  })
})
