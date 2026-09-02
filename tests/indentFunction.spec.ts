/**
 * indent 模板函数：多行取值每行缩进 4 个空格，让正文成为上面「- 时:分」列表项的下一级
 * （Thino 按列表项取条目、整段可读；Obsidian 里时间行可折叠）。
 * 真机对照 tests/real-obsidian/run-memos-compat-screenshot.js G5。
 */
import Mustache from 'mustache'
import { functionMap, renderWeChatMessageSimple } from '../src/settings/template'
import { Item } from '@omnivore-app/api'

const render = (tpl: string, view: Record<string, unknown>) =>
  Mustache.render(tpl, { ...functionMap, ...view })

describe('indent', () => {
  it('每一行前面加 4 个空格，空行保持空行', () => {
    expect(render('{{#indent}}{{{content}}}{{/indent}}', { content: '第一句\n\n第二句' }))
      .toBe('    第一句\n\n    第二句')
  })
  it('首尾空行去掉，中间空行保留；只含空白的行当空行', () => {
    expect(render('{{#indent}}{{{content}}}{{/indent}}', { content: '\n\n a\n   \nb \n\n' }))
      .toBe('     a\n\n    b ')
  })
  it('CRLF 归一成 LF 再缩进', () => {
    expect(render('{{#indent}}{{{content}}}{{/indent}}', { content: 'a\r\nb' })).toBe('    a\n    b')
  })
  it('空取值 → 空串', () => {
    expect(render('[{{#indent}}{{{content}}}{{/indent}}]', { content: '\n\n' })).toBe('[]')
  })
  it('助手消息模板：时间独占一行，聊天记录整段缩进成它的下一级（含空行隔开的第二段）', () => {
    const item = {
      id: 'x', title: '同步助手_20260831_聊天记录', savedAt: '2026-08-31T02:59:21.000Z',
      content: '**2026/08/31 08:32:15**\n第一句\n\n**2026/08/31 08:33:07**\n第二句\n\n',
    } as unknown as Item
    const out = renderWeChatMessageSimple(
      item, 'yyyy-MM-dd HH:mm:ss',
      '- {{{timeSavedShort}}}\n{{#indent}}{{{content}}}{{/indent}}',
      '{{{timeShort}}}',
    )
    expect(out.split('\n')).toEqual([
      expect.stringMatching(/^- \d{2}:\d{2}$/),
      '    08:32',
      '    第一句',
      '',
      '    08:33',
      '    第二句',
    ])
  })
  it('助手消息模板里 labels 可用：转发留言的 #标签 能放到时间行上', () => {
    const item = {
      id: 'y', title: '同步助手_20260830_文本', savedAt: '2026-08-30T07:33:00.000Z',
      content: '韦总您好，这两天小董看了其他工地围挡。',
      labels: [{ name: '太行' }, { name: '项目 A' }],
    } as unknown as Item
    const out = renderWeChatMessageSimple(
      item, 'yyyy-MM-dd HH:mm:ss',
      '- {{{timeSavedShort}}} {{#labels}}#{{{name}}} {{/labels}}\n{{#indent}}{{{content}}}{{/indent}}',
    )
    expect(out.split('\n')).toEqual([
      expect.stringMatching(/^- \d{2}:\d{2} #太行 #项目_A $/),
      '    韦总您好，这两天小董看了其他工地围挡。',
    ])
  })
  it('没有标签时 labels 段渲染为空，不报错', () => {
    const item = {
      id: 'z', title: '同步助手_20260830_文本', savedAt: '2026-08-30T07:33:00.000Z', content: '只有正文',
    } as unknown as Item
    const out = renderWeChatMessageSimple(
      item, 'yyyy-MM-dd HH:mm:ss', '- {{{timeSavedShort}}}{{#labels}} #{{{name}}}{{/labels}}\n{{#indent}}{{{content}}}{{/indent}}',
    )
    expect(out).toMatch(/^- \d{2}:\d{2}\n    只有正文$/)
  })
})
