/**
 * 消息摘要 / 锚点（问题 14，企微工单 2026-08-16~27 真机 E2E 顺带发现）
 *
 * 插件给每条消息起「小名」= 正文前 10 个字，用作日记链接的显示文字与跳转锚点
 * （`[[合并文件#小名]]`），也用作消息模板 `#### {{{heading}}}` 的标题。
 * 多选转发的聊天记录开头不是正文而是加粗时间戳 `**2026/08/28 08:32:15**`，
 * 旧实现照剪 10 个字 → 小名变成 `**2026/08/`：链接显示难看、锚点指向不存在的标题。
 *
 * 规则：
 *   - 起小名前先剥掉聊天记录的时间戳行（`**yyyy/MM/dd HH:mm:ss**` 独占一行）
 *   - 再剥掉 markdown 强调记号（`**` / `__` / `~~` / 反引号）
 *   - 用剩下的第一段真正的文字取前 10 个字；纯时间戳/空正文仍回落「消息」
 *   - 合并文件里的 `#### {{{heading}}}` 标题与日记链接锚点走同一函数，天然一致
 */

import {
  extractMessagePlainText,
  generateMessageHeading,
  generateMessageAnchor,
  renderWeChatMessageSimple,
} from '../src/settings/template'
import { Item } from '@omnivore-app/api'

function msg(content: string): Item {
  return {
    id: 'chat-1',
    title: '同步助手_20260828_聊天记录',
    content,
    savedAt: '2026-08-28T08:59:21.000Z',
    updatedAt: '2026-08-28T08:59:21.000Z',
    createdAt: '2026-08-28T08:59:21.000Z',
    url: '',
    slug: '',
    author: null,
    siteName: '企业微信',
    siteIcon: null,
    publishedAt: null,
    readAt: null,
    isArchived: false,
    contentReader: 'WEB',
    pageType: 'ARTICLE',
    state: 'SUCCEEDED',
    description: null,
    labels: [],
    highlights: [],
    image: null,
    words: null,
    wordsCount: null,
    readingProgressTopPercent: 0,
    readingProgressPercent: 0,
    readingProgressAnchorIndex: 0,
  } as unknown as Item
}

const CHAT =
  '**2026/08/28 08:32:15**\n这个链接的设置最好能像消息模板设置一样：可以自定义前缀、时间和分隔线。\n\n' +
  '**2026/08/28 08:33:07**\n目前这种设置只能紧跟着上文的内容，中间没有空行，挤在一起不好看。\n\n'

describe('聊天记录的小名：剥掉时间戳与加粗记号', () => {
  it('纯文本里没有时间戳行，也没有 ** 号', () => {
    const text = extractMessagePlainText(msg(CHAT))
    expect(text).not.toContain('**')
    expect(text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/)
    expect(text.startsWith('这个链接的设置最好能像消息模板设置一样')).toBe(true)
    // 第二条内层消息仍在（只是去掉了它前面的时间戳行）
    expect(text).toContain('目前这种设置只能紧跟着上文的内容')
  })

  it('小名 = 第一句真正文字的前 10 个字', () => {
    expect(generateMessageHeading(msg(CHAT))).toBe('这个链接的设置最好能')
  })

  it('时间戳后紧跟正文（同一行）也能剥掉', () => {
    expect(generateMessageHeading(msg('**2026/08/28 08:32:15** 张三：会议改到下午三点'))).toBe(
      '张三：会议改到下午三',
    )
  })

  it('加粗 / 删除线 / 行内代码的记号不进小名，文字保留', () => {
    expect(generateMessageHeading(msg('**重要**通知：~~取消~~改期`v2`发布'))).toBe('重要通知：取消改期v')
  })

  it('只有时间戳没有正文 → 回落「消息」', () => {
    expect(generateMessageHeading(msg('**2026/08/28 08:32:15**\n\n'))).toBe('消息')
  })

  it('普通文本消息（无时间戳、无记号）行为不变', () => {
    expect(generateMessageHeading(msg('万载时代项目现场，停机检修过程中发现三号机组轴承温度偏高'))).toBe(
      '万载时代项目现场，停',
    )
  })
})

describe('锚点与合并文件里的标题一致', () => {
  const TEMPLATE = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'

  it('#### {{{heading}}} 渲染出的标题就是剥完记号的小名', () => {
    const body = renderWeChatMessageSimple(msg(CHAT), 'yyyy-MM-dd HH:mm:ss', TEMPLATE)
    expect(body).toContain('#### 这个链接的设置最好能\n')
    expect(body).not.toContain('#### **')
  })

  it('generateMessageAnchor 与标题同源，不含 ** 与斜杠日期', () => {
    const anchor = generateMessageAnchor(msg(CHAT), 'yyyy-MM-dd HH:mm:ss', TEMPLATE)
    expect(anchor).toBe('这个链接的设置最好能')
  })
})
