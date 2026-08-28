/**
 * oneLine 模板函数：把多行取值折成一行（换行 → <br>），给 Memos / Thino 这类只认单行列表项的
 * 流式笔记插件用（真机对照 tests/real-obsidian/run-memos-compat-screenshot.js G4）。
 */
import Mustache from 'mustache'
import { functionMap, renderWeChatMessageSimple } from '../src/settings/template'
import { Item } from '@omnivore-app/api'

const render = (tpl: string, view: Record<string, unknown>) =>
  Mustache.render(tpl, { ...functionMap, ...view })

describe('oneLine', () => {
  it('每段换行（含空行、两侧空白）折成一个 <br>，首尾空白去掉', () => {
    expect(render('{{#oneLine}}{{{content}}}{{/oneLine}}', { content: '第一句\n\n第二句 \n  第三句\n' }))
      .toBe('第一句<br>第二句<br>第三句')
  })
  it('单行取值原样', () => {
    expect(render('- {{{t}}} {{#oneLine}}{{{content}}}{{/oneLine}}', { t: '08:59', content: '只有一行' }))
      .toBe('- 08:59 只有一行')
  })
  it('CRLF 也折', () => {
    expect(render('{{#oneLine}}{{{content}}}{{/oneLine}}', { content: 'a\r\nb' })).toBe('a<br>b')
  })
  it('空取值 → 空串', () => {
    expect(render('[{{#oneLine}}{{{content}}}{{/oneLine}}]', { content: '\n\n' })).toBe('[]')
  })
  it('助手消息模板里可用：聊天记录整条折成一行的列表项', () => {
    const item = {
      id: 'x', title: '同步助手_20260828_聊天记录', savedAt: '2026-08-28T00:59:21.000Z',
      content: '**2026/08/28 08:32:15**\n第一句\n\n**2026/08/28 08:33:07**\n第二句\n\n',
    } as unknown as Item
    const out = renderWeChatMessageSimple(
      item, 'yyyy-MM-dd HH:mm:ss',
      '- {{{timeSavedShort}}} {{#oneLine}}{{{content}}}{{/oneLine}}',
      '{{{timeShort}}}',
    )
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toMatch(/^- \d{2}:\d{2} 08:32<br>第一句<br>08:33<br>第二句$/)
  })
})
