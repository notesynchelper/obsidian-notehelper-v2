/**
 * 聊天记录内层时间戳样式可配置（设计文档 A4，问题 4）。
 *
 * 现状：processContentTimestamps 把 `**yyyy/MM/dd HH:mm:ss**` 硬替换成
 * `<small style="color: #999;">…</small>`，用户要纯文本 + 自定格式。
 * 新设置 chatRecordTimestampTemplate，默认值 = 旧输出（零回归）。
 */
import { Item } from '@omnivore-app/api'
import {
  processContentTimestamps,
  renderWeChatMessageSimple,
} from '../src/settings/template'
import {
  DEFAULT_SETTINGS,
  DEFAULT_CHAT_RECORD_TIMESTAMP_TEMPLATE,
} from '../src/settings'
import { logError } from '../src/logger'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const DATE_FORMAT = 'yyyy-MM-dd HH:mm:ss'
const OLD_SMALL = '<small style="color: #999;">'
const CHAT_RECORD =
  '**2026/08/27 08:32:15**\n这个链接的设置最好能像消息模板设置一样\n\n**2026/08/27 08:33:07**\n目前这种设置只能紧跟着上文的内容\n\n'
/** 旧版 processContentTimestamps 对上面 CHAT_RECORD 的逐字节输出 */
const OLD_OUTPUT =
  `${OLD_SMALL}2026/08/27 08:32:15</small>\n这个链接的设置最好能像消息模板设置一样\n\n` +
  `${OLD_SMALL}2026/08/27 08:33:07</small>\n目前这种设置只能紧跟着上文的内容\n\n`

function makeMessage(content: string): Item {
  return {
    id: 'chat-1',
    title: '同步助手_20260827_聊天记录_聊天记录',
    savedAt: '2026-08-27T00:32:15.000Z',
    updatedAt: '2026-08-27T00:32:15.000Z',
    content,
    url: 'https://example.com',
    slug: 'message',
    labels: [],
    highlights: [],
    siteName: '企业微信',
  } as unknown as Item
}

beforeEach(() => {
  ;(logError as jest.Mock).mockClear()
})

describe('A4 默认值 = 旧行为（零回归）', () => {
  test('DEFAULT_SETTINGS.chatRecordTimestampTemplate 就是旧的灰色小字写法', () => {
    expect(DEFAULT_CHAT_RECORD_TIMESTAMP_TEMPLATE).toBe(`${OLD_SMALL}{{{timestamp}}}</small>`)
    expect(DEFAULT_SETTINGS.chatRecordTimestampTemplate).toBe(DEFAULT_CHAT_RECORD_TIMESTAMP_TEMPLATE)
  })

  test('不传模板 / 传默认模板 / 传空串：输出与旧版逐字节一致', () => {
    expect(processContentTimestamps(CHAT_RECORD)).toBe(OLD_OUTPUT)
    expect(processContentTimestamps(CHAT_RECORD, DEFAULT_CHAT_RECORD_TIMESTAMP_TEMPLATE)).toBe(OLD_OUTPUT)
    expect(processContentTimestamps(CHAT_RECORD, '')).toBe(OLD_OUTPUT)
    expect(processContentTimestamps(CHAT_RECORD, '   ')).toBe(OLD_OUTPUT)
  })

  test('旧版的换行整理规则原样保留：3+ 换行压成 2 个、时间戳后的空行去掉', () => {
    expect(processContentTimestamps('**2026/08/27 08:32:15**\n\n\nA\n\n\n\nB')).toBe(
      `${OLD_SMALL}2026/08/27 08:32:15</small>\nA\n\nB`,
    )
  })

  test('renderWeChatMessageSimple 不传第 4 个参数时行为不变', () => {
    const withDefault = renderWeChatMessageSimple(makeMessage(CHAT_RECORD), DATE_FORMAT, '{{{content}}}')
    const explicit = renderWeChatMessageSimple(
      makeMessage(CHAT_RECORD),
      DATE_FORMAT,
      '{{{content}}}',
      DEFAULT_CHAT_RECORD_TIMESTAMP_TEMPLATE,
    )
    expect(withDefault).toBe(explicit)
    expect(withDefault).toBe(OLD_OUTPUT.replace(/\s+$/, ''))
  })

  test('没有时间戳的普通消息：任何模板下都原样返回', () => {
    expect(processContentTimestamps('普通一条消息', '{{{time}}}')).toBe('普通一条消息')
    expect(processContentTimestamps('', '{{{time}}}')).toBe('')
  })
})

describe('A4 自定义样式', () => {
  test('{{{time}}} → 纯文本时分秒', () => {
    expect(processContentTimestamps(CHAT_RECORD, '{{{time}}}')).toBe(
      '08:32:15\n这个链接的设置最好能像消息模板设置一样\n\n08:33:07\n目前这种设置只能紧跟着上文的内容\n\n',
    )
  })

  test('{{{date}}} / {{{timeShort}}} / {{{timestamp}}} 四个变量', () => {
    expect(
      processContentTimestamps('**2026/08/27 08:32:15**\nA', '[{{{timestamp}}}|{{{date}}}|{{{time}}}|{{{timeShort}}}]'),
    ).toBe('[2026/08/27 08:32:15|2026-08-27|08:32:15|08:32]\nA')
  })

  test('内置函数可用：{{#formatDate}}{{timestamp}},HH:mm{{/formatDate}}', () => {
    expect(
      processContentTimestamps('**2026/08/27 08:32:15**\nA', '{{#formatDate}}{{timestamp}},HH:mm{{/formatDate}}'),
    ).toBe('08:32\nA')
  })

  test('多行模板：时间戳后的空行整理仍然生效，渲染值里的换行不被整理波及', () => {
    expect(
      processContentTimestamps('**2026/08/27 08:32:15**\n\n\nA\n\n**2026/08/27 08:33:07**\n\nB', '- - -\n{{{time}}}'),
    ).toBe('- - -\n08:32:15\nA\n\n- - -\n08:33:07\nB')
  })

  test('模板语法坏了：记错误日志并回落默认样式，整条消息不丢', () => {
    const out = processContentTimestamps(CHAT_RECORD, '{{#formatDate}}没闭合')
    expect(out).toBe(OLD_OUTPUT)
    expect(logError).toHaveBeenCalled()
  })

  test('renderWeChatMessageSimple 第 4 个参数接进来（含 A3 的尾部整理）', () => {
    const rendered = renderWeChatMessageSimple(
      makeMessage(CHAT_RECORD),
      DATE_FORMAT,
      '- {{{dateSaved}}}\n{{{content}}}\n- - -',
      '{{{time}}}',
    )
    expect(rendered).toBe(
      '- 2026-08-27 00:32:15\n08:32:15\n这个链接的设置最好能像消息模板设置一样\n\n08:33:07\n目前这种设置只能紧跟着上文的内容\n- - -',
    )
  })
})
