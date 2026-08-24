/**
 * extract helper —— 模板里按「匹配规则」从某个变量里抠出想要的片段
 *
 * 背景：企微消息入库后的标题固定形如
 *     同步助手_20260824_空调蓝图打印  #丰顺展厅 #蓝图打印_文本
 *     同步助手_20260824_聊天记录_聊天记录
 * 关掉「合并」（mergeMode=none）后每条消息各自落一个文件，文件名默认就是整个
 * 标题，前缀「同步助手_日期_」和后缀「_类型」全带上，很难看。用户希望文件名
 * 只保留中间那段正文摘要。
 *
 * 现有 functionMap 只有 lowerCase / upperCase / upperCaseFirst / formatDate /
 * mapValue —— mapValue 是「整值映射」，抠不出子串。本组用例锁定新 helper：
 *
 *   {{#extract}}<取值表达式>|<匹配规则>|<输出格式>{{/extract}}
 *
 *   - 取值表达式先经 Mustache 渲染（可写 {{{title}}}），渲染后裁掉首尾空白
 *   - 匹配规则按字面量使用（不再过 Mustache），`\|` 表示「这个竖线属于规则」
 *   - 输出格式可省，默认 $1（第 1 个括号分组；无分组则取整段命中）
 *   - 【安全兜底】规则没命中 / 规则本身写错 → 原样返回取值，绝不返回空串
 *     （非消息的普通文章标题不含这套前后缀，必须原样保留）
 *
 * 同时含回归断言：不含 extract 的模板渲染结果不变，既有 helper 照常工作。
 */

import { Item } from '@omnivore-app/api'
import { render, renderFilename } from '../src/settings/template'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function createMockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article',
    author: 'Test Author',
    description: 'A test description',
    slug: 'test-slug',
    labels: [],
    highlights: [],
    updatedAt: '2024-03-20T08:15:00.000Z',
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>Test content here.</p>',
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
  } as unknown as Item
}

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

/** 生产同款配置：抠掉「同步助手_日期_」前缀与「_类型」后缀 */
const MSG_BODY_TPL =
  '{{#extract}}{{{title}}}|^同步助手_\\d{8}_([\\s\\S]+)_[^_]+$|$1{{/extract}}'

function viaRender(title: string, tpl: string): string {
  return render(createMockItem({ title }), tpl, DATE_FORMAT)
}

describe('extract helper —— 企微消息标题抠正文摘要', () => {
  it('文本消息：去掉「同步助手_20260824_」前缀与「_文本」后缀', () => {
    expect(
      viaRender('同步助手_20260824_空调蓝图打印  #丰顺展厅 #蓝图打印_文本', MSG_BODY_TPL),
    ).toBe('空调蓝图打印  #丰顺展厅 #蓝图打印')
  })

  it('聊天记录：中间段与类型段同名时也只取中间段', () => {
    expect(viaRender('同步助手_20260824_聊天记录_聊天记录', MSG_BODY_TPL)).toBe('聊天记录')
  })

  it('图片消息', () => {
    expect(viaRender('同步助手_20260824_图片_图片', MSG_BODY_TPL)).toBe('图片')
  })

  it('中间段自带下划线时贪婪到最后一个下划线，类型段仍被剥掉', () => {
    expect(viaRender('同步助手_20260824_a_b_c_文本', MSG_BODY_TPL)).toBe('a_b_c')
  })

  it('中间段含换行（转发的聊天片段）也能抠出来', () => {
    expect(
      viaRender('同步助手_20260824_阿u\n2026年08月24日 08:33\n有人两把风扇都冇关_文本', MSG_BODY_TPL),
    ).toBe('阿u\n2026年08月24日 08:33\n有人两把风扇都冇关')
  })

  it('【安全兜底】普通文章标题不匹配 → 原样返回整个标题', () => {
    expect(viaRender('SuMore — 创意无限 探索无界', MSG_BODY_TPL)).toBe(
      'SuMore — 创意无限 探索无界',
    )
  })

  it('【安全兜底】形似但日期段不是 8 位 → 原样返回', () => {
    expect(viaRender('同步助手_2026_随手记_文本', MSG_BODY_TPL)).toBe(
      '同步助手_2026_随手记_文本',
    )
  })
})

describe('extract helper —— 语法细节', () => {
  it('省略输出格式时默认取第 1 个分组', () => {
    expect(
      viaRender('同步助手_20260824_随手记_文本', '{{#extract}}{{{title}}}|^同步助手_\\d{8}_([\\s\\S]+)_[^_]+${{/extract}}'),
    ).toBe('随手记')
  })

  it('规则里没有分组时取整段命中', () => {
    expect(viaRender('订单 ABC-12345 已发货', '{{#extract}}{{{title}}}|[A-Z]{3}-\\d+{{/extract}}')).toBe(
      'ABC-12345',
    )
  })

  it('输出格式可拼多个分组与字面量', () => {
    expect(
      viaRender('同步助手_20260824_随手记_文本', '{{#extract}}{{{title}}}|^同步助手_(\\d{8})_([\\s\\S]+)_([^_]+)$|$3 · $2（$1）{{/extract}}'),
    ).toBe('文本 · 随手记（20260824）')
  })

  it('\\| 表示这个竖线属于规则本身（分支），不当参数分隔符', () => {
    expect(
      viaRender('同步助手_20260824_图片_图片', '{{#extract}}{{{title}}}|_(图片\\|文本)_{{/extract}}'),
    ).toBe('图片')
  })

  it('\\\\| 表示「匹配一个字面竖线字符」（前一个反斜杠不构成转义）', () => {
    expect(
      viaRender('订单 A|B 已发货', '{{#extract}}{{{title}}}|([A-Z]\\\\|[A-Z]){{/extract}}'),
    ).toBe('A|B')
  })

  it('【安全兜底】规则能匹配空串（^ / a*）→ 不返回空，回落取值', () => {
    expect(viaRender('随手记', '{{#extract}}{{{title}}}|^{{/extract}}')).toBe('随手记')
    expect(viaRender('随手记', '{{#extract}}{{{title}}}|x*{{/extract}}')).toBe('随手记')
    expect(viaRender('随手记', '{{#extract}}{{{title}}}|(x*){{/extract}}')).toBe('随手记')
  })

  it('【安全兜底】取值超长（>10000 字符）→ 跳过匹配原样返回，不给规则跑飞的机会', () => {
    const huge = '同步助手_20260824_' + 'a'.repeat(10001) + '_文本'
    expect(viaRender(huge, MSG_BODY_TPL)).toBe(huge)
  })

  it('只给取值、不给规则 → 原样返回取值', () => {
    expect(viaRender('同步助手_20260824_随手记_文本', '{{#extract}}{{{title}}}{{/extract}}')).toBe(
      '同步助手_20260824_随手记_文本',
    )
  })

  it('【安全兜底】规则写错（括号没闭合）→ 原样返回取值，不炸不清空', () => {
    expect(viaRender('同步助手_20260824_随手记_文本', '{{#extract}}{{{title}}}|^同步助手_([\\s\\S]+${{/extract}}')).toBe(
      '同步助手_20260824_随手记_文本',
    )
  })

  it('取值本身为空 → 返回空串，不抛异常', () => {
    expect(viaRender('', MSG_BODY_TPL)).toBe('')
  })

  it('可以套在别的 helper 外层使用', () => {
    expect(
      viaRender('同步助手_20260824_daily Note_文本', '{{#upperCase}}{{#extract}}{{{title}}}|^同步助手_\\d{8}_([\\s\\S]+)_[^_]+$|$1{{/extract}}{{/upperCase}}'),
    ).toBe('DAILY NOTE')
  })
})

describe('extract helper —— 走真实文件名入口 renderFilename', () => {
  it('文件名模板里可直接用', () => {
    const item = createMockItem({ title: '同步助手_20260824_方案调整意见#揭阳办公楼_文本' })
    expect(renderFilename(item, MSG_BODY_TPL, DATE_FORMAT)).toBe('方案调整意见#揭阳办公楼')
  })

  it('抠出来的中间段超长时，renderFilename 的 100 字上限照常生效', () => {
    const body = '很长的一段中文标题内容'.repeat(20)   // 220 字，远超 100
    const item = createMockItem({ title: `同步助手_20260824_${body}_文本` })
    const out = renderFilename(item, MSG_BODY_TPL, DATE_FORMAT)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.startsWith('很长的一段中文标题内容')).toBe(true)
    expect(out.endsWith('...')).toBe(true)
  })

  it('中间段是 emoji / 组合字符时不被打散成乱码', () => {
    const item = createMockItem({ title: '同步助手_20260824_🐷仔的一天 👨‍👩‍👧_文本' })
    expect(renderFilename(item, MSG_BODY_TPL, DATE_FORMAT)).toBe('🐷仔的一天 👨‍👩‍👧')
  })

  it('可与日期变量拼接', () => {
    const item = createMockItem({ title: '同步助手_20260824_随手记_文本' })
    expect(
      renderFilename(item, `{{{dateSaved}}}-${MSG_BODY_TPL}`, 'yyyyMMdd'),
    ).toBe('20240115-随手记')
  })
})

describe('extract helper —— 回归：不影响既有渲染', () => {
  it('不含 extract 的模板结果不变', () => {
    expect(viaRender('随手记', '{{{title}}}-{{{siteName}}}')).toBe('随手记-example.com')
  })

  it('既有 helper 照常工作', () => {
    expect(viaRender('Hello World', '{{#lowerCase}}{{{title}}}{{/lowerCase}}')).toBe('hello world')
    expect(
      viaRender('x', '{{#mapValue}}{{{siteName}}}|example.com=示例,*=其他{{/mapValue}}'),
    ).toBe('示例')
  })
})
