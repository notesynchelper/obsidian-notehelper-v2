/**
 * 助手消息模板支持内置函数 + 完整日期变量集（设计文档 A1 / A2）。
 *
 * 背景（企微工单 2026-08-16~27）：用户把合并消息文件当日记用，消息模板里写
 * `{{#formatDate}}{{dateSaved}},HH:mm:ss{{/formatDate}}` 想只显示时分秒，结果渲染成空 ——
 * renderWeChatMessageSimple / generateMessageAnchor 的 view 没挂 functionMap，
 * Mustache 把 `{{#formatDate}}` 当缺失 section 整段吞掉；锚点也因此与正文标题不一致。
 */
import { Item } from '@omnivore-app/api'
import {
  renderWeChatMessageSimple,
  generateMessageAnchor,
  convertToObsidianAnchor,
} from '../src/settings/template'

const DATE_FORMAT = 'yyyy-MM-dd HH:mm:ss'

function makeMessage(overrides: Partial<Item> = {}): Item {
  return {
    id: 'msg-id-001',
    title: '同步助手_20260324_001_文本',
    // jest 固定 TZ=UTC（jest.config.js），下面的时分秒断言都按 UTC 写
    savedAt: '2026-03-24T10:57:21.000Z',
    updatedAt: '2026-03-24T10:57:21.000Z',
    content: '今天开会讨论了新功能的设计方案',
    url: 'https://example.com',
    slug: 'msg',
    labels: [],
    highlights: [],
    siteName: null,
    originalArticleUrl: null,
    author: null,
    description: null,
    pageType: 'ARTICLE',
    publishedAt: null,
    image: null,
    readAt: null,
    wordsCount: null,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as Item
}

describe('A1 助手消息模板：内置函数可用', () => {
  test('{{#formatDate}} 按指定格式渲染，而不是渲染成空', () => {
    const item = makeMessage()
    const rendered = renderWeChatMessageSimple(
      item,
      DATE_FORMAT,
      '---\n{{#formatDate}}{{dateSaved}},HH:mm:ss{{/formatDate}}\n{{{content}}}',
    )
    expect(rendered).toBe('---\n10:57:21\n今天开会讨论了新功能的设计方案')
  })

  test('其它内置函数（upperCase / extract）同样可用', () => {
    const item = makeMessage({ title: '同步助手_20260324_随手记_文本' })
    const rendered = renderWeChatMessageSimple(
      item,
      DATE_FORMAT,
      '{{#upperCase}}abc{{/upperCase}} {{#extract}}{{{title}}}|^同步助手_\\d{8}_([\\s\\S]+)_[^_]+$|$1{{/extract}}',
    )
    expect(rendered).toBe('ABC 随手记')
  })

  test('锚点与正文标题一致：标题行用 formatDate 时锚点不为空', () => {
    const item = makeMessage()
    const template =
      '## {{#formatDate}}{{dateSaved}},HH:mm{{/formatDate}}\n{{{content}}}'
    const rendered = renderWeChatMessageSimple(item, DATE_FORMAT, template)
    const headingLine = rendered.split('\n').find((l) => l.startsWith('## '))!
    expect(headingLine).toBe('## 10:57')

    const anchor = generateMessageAnchor(item, DATE_FORMAT, template)
    expect(anchor).toBe(convertToObsidianAnchor('10:57'))
    expect(anchor).toBe('10 57')
  })

  test('原有变量 id / title / content / dateSaved / savedAt / heading 不变', () => {
    const item = makeMessage()
    const rendered = renderWeChatMessageSimple(
      item,
      DATE_FORMAT,
      '{{{id}}}|{{{title}}}|{{{content}}}|{{{dateSaved}}}|{{{savedAt}}}|{{{heading}}}',
    )
    expect(rendered).toBe(
      'msg-id-001|同步助手_20260324_001_文本|今天开会讨论了新功能的设计方案|2026-03-24 10:57:21|2026-03-24T10:57:21.000Z|今天开会讨论了新功能',
    )
  })
})

describe('A2 助手消息模板：timeSaved / timeSavedShort 与日期拆解变量', () => {
  test('{{{timeSaved}}} = HH:mm:ss，{{{timeSavedShort}}} = HH:mm', () => {
    const item = makeMessage()
    const rendered = renderWeChatMessageSimple(
      item,
      DATE_FORMAT,
      '{{{timeSaved}}} / {{{timeSavedShort}}}',
    )
    expect(rendered).toBe('10:57:21 / 10:57')
  })

  test('timeSaved 不受「保存日期格式」影响；date 别名与 year/month/day 拆解也可用', () => {
    const item = makeMessage()
    const rendered = renderWeChatMessageSimple(
      item,
      'yyyy-MM-dd',
      '{{{date}}} {{{timeSaved}}} {{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}',
    )
    expect(rendered).toBe('2026-03-24 10:57:21 2026/03/24')
  })

  test('锚点渲染与正文共用同一套变量：标题行写 timeSaved 时锚点一致', () => {
    const item = makeMessage()
    const template = '## {{{timeSavedShort}}}\n{{{content}}}'
    const rendered = renderWeChatMessageSimple(item, DATE_FORMAT, template)
    expect(rendered.split('\n')[0]).toBe('## 10:57')
    expect(generateMessageAnchor(item, DATE_FORMAT, template)).toBe('10 57')
  })
})
