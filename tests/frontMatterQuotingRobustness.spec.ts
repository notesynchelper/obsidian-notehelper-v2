// 前置元数据模板里「用户手写的引号」对脏数据的鲁棒性矩阵 —— 固化当前行为。
//
// 背景（2026-07-30 用户工单）：用户自己写的前置元数据模板长这样
//   标题: {{title}}
//   描述: {{"文章内容一句话总结"}}
//   标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]
// 里面的 {{"自然语言"}} 被当成变量名去查表（查不到→空串），labels 循环体里没有
// {{{name}}}，于是标签行渲染成 `标签: [,  ,,  ,]` 非法 YAML，整段 front matter 解析
// 失败 → 落盘只剩 id + omnivore_error，用户配的字段全丢。
//
// 回答"那到底该怎么写"时发现：值该不该加引号没有免费的午餐 —— 三种写法各有一类
// 必挂的脏数据。本文件把这个矩阵钉住，避免以后凭直觉改建议：
//
//   脏数据            | "双引号" | '单引号' | 裸值
//   值含 ASCII "      |   ✗整段  |   ✓      |  ✓
//   值含 ASCII '      |   ✓      |   ✗整段  |  ✓
//   值含 ": "         |   ✓      |   ✓      |  ✓(sanitize 兜底)
//   值以 # 开头       |   ✓      |   ✓      |  △null
//   值以 - 开头       |   ✓      |   ✓      |  ✗整段
//
// 结论（给用户的推荐写法）：用**双引号**。它唯一的雷是"值里含半角双引号"，而中文
// 内容通常用全角引号“”（安全）；单引号版怕英文撇号（it's / don't，概率高得多）。
// 裸值版如今靠 sanitize 兜底能救回 ": "（含中文 key，2026-10-09 修复），但仍怕
// 值以 - 开头（见矩阵），以及值中段「空格+#」的静默截断（见文末局限用例）。
//
// ⚠️ "✗整段" 是插件端的短板，不是 YAML 的必然：renderItemContent 只把模板渲染完就
// 交给 parseYaml，没有对插值出来的**值**做 YAML 转义（sanitizeRenderedYaml 兜底只
// 会给整个值加引号，救不了值内部本来就有的引号，也够不到值以 - 开头的裸值——
// YAML_NEEDS_QUOTING 不含 -）。要根治得在渲染层转义值，届时请更新本矩阵而不是删掉它。

import { renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
import { Item } from '@omnivore-app/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

function frontMatterRaw(content: string): string {
  const m = content.match(/^---\n([\s\S]*?)---/)
  return m ? m[1] : ''
}

function frontMatterParsed(content: string): Record<string, unknown> | null {
  const m = content.match(/^---\n([\s\S]*?)---/)
  if (!m) return null
  try {
    return jsYaml.load(m[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function mockArticle(overrides?: Partial<Item>): Item {
  return {
    id: 'id-1',
    title: '正常标题',
    siteName: '巴蜀文化研究',
    originalArticleUrl: 'https://mp.weixin.qq.com/s/abc',
    author: '作者',
    description: '一句话描述。',
    slug: 's',
    labels: [{ name: '都江堰' }, { name: '李冰' }],
    highlights: [],
    updatedAt: '2026-07-30T11:33:39.000Z',
    savedAt: '2026-07-30T11:33:39.000Z',
    pageType: 'ARTICLE',
    content: '正文',
    publishedAt: '2026-07-29T00:00:00.000Z',
    url: 'https://mp.weixin.qq.com/s/abc',
    image: '',
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as unknown as Item
}

/** 同一套字段，只改「值外面包什么引号」。tags 行用插件默认的 C 写法（flow seq）。 */
const template = (quote: '"' | "'" | '') =>
  `标题: ${quote}{{{title}}}${quote}\n` +
  `链接: ${quote}{{{originalUrl}}}${quote}\n` +
  `描述: ${quote}{{{description}}}${quote}\n` +
  `保存: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}\n` +
  `来源: ${quote}{{{siteName}}} | 笔记同步助手${quote}\n` +
  `tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]`

const render = (tpl: string, item: Item) =>
  renderItemContent(
    item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
    DATE_FORMAT, DATE_FORMAT, false, [], tpl, '', '', '',
  )

type Verdict = 'ok' | 'whole-block-lost' | 'field-null'

function verdictOf(tpl: string, item: Item): Verdict {
  const content = render(tpl, item)
  if (/omnivore_error/.test(frontMatterRaw(content))) return 'whole-block-lost'
  const fm = frontMatterParsed(content)
  if (fm?.['标题'] == null || fm?.['描述'] == null) return 'field-null'
  return 'ok'
}

describe('前置元数据模板：引号写法 × 脏数据 鲁棒性矩阵（固化当前行为）', () => {
  const cases: Array<{
    label: string
    override: Partial<Item>
    expect: { double: Verdict; single: Verdict; bare: Verdict }
  }> = [
    {
      label: '值含 ASCII 双引号 → 双引号版整段丢失',
      override: { title: '他说"你好"' } as Partial<Item>,
      expect: { double: 'whole-block-lost', single: 'ok', bare: 'ok' },
    },
    {
      label: '值含 ASCII 单引号（英文撇号）→ 单引号版整段丢失',
      override: { title: "it's fine" } as Partial<Item>,
      expect: { double: 'ok', single: 'whole-block-lost', bare: 'ok' },
    },
    {
      label: '值含「冒号+空格」→ 裸值版靠 sanitize 兜底保住（中文 key 2026-10-09 起同样救回）',
      override: { title: '深度: 都江堰' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'ok' },
    },
    {
      label: '值以 # 开头 → 裸值版被当注释，字段静默变 null',
      override: { title: '#爆款 都江堰' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'field-null' },
    },
    {
      label: '值以 - 开头 → 裸值版整段丢失',
      override: { title: '- 列表项标题' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'whole-block-lost' },
    },
    {
      label: '描述含 ASCII 双引号 → 双引号版整段丢失（与标题同理）',
      override: { description: '他说"行"，然后走了' } as Partial<Item>,
      expect: { double: 'whole-block-lost', single: 'ok', bare: 'ok' },
    },
  ]

  for (const c of cases) {
    it(c.label, () => {
      const item = mockArticle(c.override)
      expect(verdictOf(template('"'), item)).toBe(c.expect.double)
      expect(verdictOf(template("'"), item)).toBe(c.expect.single)
      expect(verdictOf(template(''), item)).toBe(c.expect.bare)
    })
  }

  it('干净数据下三种写法都 OK，且 tags 落盘为 YAML 数组（Properties 面板才给可删 pill）', () => {
    for (const q of ['"', "'", ''] as const) {
      const content = render(template(q), mockArticle())
      const fm = frontMatterParsed(content)
      expect(fm?.['omnivore_error']).toBeUndefined()
      expect(fm?.['tags']).toEqual(['笔记同步助手', '都江堰', '李冰'])
    }
  })

  it('用户原版模板：{{"自然语言"}} 不是变量，标签行渲染成非法 YAML → 中文 key 起被 sanitize 兜住（降级为乱串字符串而非整段丢失）', () => {
    // 2026-07-30 工单原形态。旧行为：`标签: [,  ,,  ,]` 非法 flow seq → 首轮解析
    // 失败 → sanitize 匹配不上中文 key → omnivore_error、字段全丢。2026-10-09
    // 中文 key 修复后：标签行被兜底加引号 → 解析成功，字段保住，标签值退化为
    // 一坨字符串（与上方 commaBefore 用例钉的降级语义一致）。
    const USER_TEMPLATE =
      '标题: {{title}}\n' +
      '链接: "{{{originalUrl}}}"\n' +
      '描述: {{"文章内容一句话总结"}}\n' +
      '保存: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}\n' +
      '来源: {{{siteName}}} | 笔记同步助手\n' +
      '标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]'
    const content = render(USER_TEMPLATE, mockArticle())
    const fm = frontMatterParsed(content)
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['标题']).toBe('正常标题')
    expect(fm?.['标签']).toBe('[,  ,,  ,]')
  })

  it('去掉固定首项标签时，逗号必须挪到 name 后面（否则空首项被兜底成一坨字符串）', () => {
    // 带固定首项「笔记同步助手」时，逗号写在 name 前面才对：
    //   tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]  → [固定, a, b]
    // 用户想删掉固定标签时，如果照抄"逗号在前"就会得到 `[, a, b]` 空首项：
    // 非法 flow seq → sanitize 兜底加引号 → 变成【单个字符串】，Properties 里
    // 退化成一个挤成一坨的 chip（不报错，所以特别容易被当成"正常"）。
    const commaBefore = 'tags: [{{#labels}}, {{{name}}}{{/labels}}]'
    const commaAfter = 'tags: [{{#labels}}{{{name}}}, {{/labels}}]'
    const labels3 = mockArticle()
    const labels1 = mockArticle({ labels: [{ name: '李冰' }] } as unknown as Partial<Item>)
    const labels0 = mockArticle({ labels: [] } as unknown as Partial<Item>)

    // ✗ 逗号在前：退化成单字符串（注意不是抛错，是静默变形）
    expect(frontMatterParsed(render(commaBefore, labels3))?.['tags'])
      .toBe('[, 都江堰, 李冰]')
    expect(frontMatterParsed(render(commaBefore, labels1))?.['tags'])
      .toBe('[, 李冰]')

    // ✓ 逗号在后（尾逗号）：0 / 1 / N 个标签都是合法数组
    expect(frontMatterParsed(render(commaAfter, labels3))?.['tags'])
      .toEqual(['都江堰', '李冰'])
    expect(frontMatterParsed(render(commaAfter, labels1))?.['tags'])
      .toEqual(['李冰'])
    expect(frontMatterParsed(render(commaAfter, labels0))?.['tags'])
      .toEqual([])
  })

  it('块状 list 写法在 0 个标签时退化成 null，所以不如尾逗号 flow seq', () => {
    const block = 'tags:{{#labels}}\n  - {{{name}}}{{/labels}}'
    expect(frontMatterParsed(render(block, mockArticle()))?.['tags'])
      .toEqual(['都江堰', '李冰'])
    expect(frontMatterParsed(render(block, mockArticle({ labels: [] } as unknown as Partial<Item>)))?.['tags'])
      .toBeNull()
  })

  it('同一模板在 labels 为空时反而能解析（`标签: []` 合法）—— 所以故障看着"时好时坏"', () => {
    const USER_TEMPLATE =
      '标题: {{{title}}}\n' +
      '标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]'
    const content = render(USER_TEMPLATE, mockArticle({ labels: [] } as Partial<Item>))
    const fm = frontMatterParsed(content)
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['标签']).toEqual([])
  })
})

// 2026-10-09「天圆地方」工单：用户 7 个属性 key 全中文、值全裸写。实测回放该用户
// omniserver 近 12 天 119 篇文章：X 44/48、头条 33/48（微头条）、微博 2/2、小红书
// 2/2 整段丢失（omnivore_error，7 字段全没），公众号 4/4 正常 —— 因为 X/微博标题是
// `作者: 推文内容`（ASCII 冒号+空格）、头条微头条/小红书摘要以 `@作者 发布的微头条`
// 开头（@ 是 YAML 保留起始符），首轮 parseYaml 必炸；而 sanitizeRenderedYaml 的行
// 正则只认 \w key，中文 key 一行都匹配不上、加不了引号 → 二次解析也炸。公众号值
// 干净所以"大部分正常"，造成"时好时坏"的观感。
describe('中文 key × 平台脏数据（sanitize 兜底须覆盖中文 key）', () => {
  const USER_TEMPLATE = `原标题: {{{title}}}
原文链接: {{{originalUrl}}}
作者: {{{author}}}
发行平台: {{{siteName}}}
添加时间: {{{dateSaved}}}
Tags标签: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]
前言摘要: {{{description}}}`

  it('X 形态标题（`作者: 推文`）不再整段丢失，7 个字段全部落盘', () => {
    const item = mockArticle({
      title: 'Suu: 我发现很多大学生都已经会翻墙了',
      siteName: 'X',
      labels: [{ name: 'AI' }],
    } as Partial<Item>)
    const fm = frontMatterParsed(render(USER_TEMPLATE, item))
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['原标题']).toBe('Suu: 我发现很多大学生都已经会翻墙了')
    expect(fm?.['发行平台']).toBe('X')
    expect(fm?.['作者']).toBe('作者')
    expect(fm?.['原文链接']).toBe('https://mp.weixin.qq.com/s/abc')
    expect(fm?.['前言摘要']).toBe('一句话描述。')
    expect('添加时间' in (fm ?? {})).toBe(true)
    // 降级（既有行为，非本修复目标）：sanitize 给「违规行」之外的含特殊字符行
    // 也加了引号 → flow seq 兜成字符串而非数组（与 ASCII key 行为一致）。
    expect(fm?.['Tags标签']).toBe('[笔记同步助手, AI]')
  })

  it('头条微头条形态摘要（`@作者 发布的微头条`）不再整段丢失', () => {
    const item = mockArticle({
      title: 'AI巨风：做自媒体最累的',   // 全角冒号本身安全，不触发 sanitize
      siteName: '头条',
      author: undefined,                // 头条 author 常为 NULL → 插件兜 'unknown'
      description: '@AI巨风 发布的微头条 146人阅读',
      labels: [],
    } as Partial<Item>)
    const fm = frontMatterParsed(render(USER_TEMPLATE, item))
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['原标题']).toBe('AI巨风：做自媒体最累的')
    expect(fm?.['前言摘要']).toBe('@AI巨风 发布的微头条 146人阅读')
    expect(fm?.['作者']).toBe('unknown')
    expect(fm?.['Tags标签']).toBe('[笔记同步助手]')
  })

  it('局限（固化现状）：值中段「空格+#」首轮解析就成功、值被当注释静默截断，sanitize 不介入', () => {
    // AI整理-今日头条的摘要形态（v2a 正文带 #话题）。`前言摘要: xxx #话题` 在 YAML
    // 里是合法的（# 起注释）→ 首轮 parseYaml 成功 → 兜底永不触发 → 值在 # 前被无声
    // 截断。这是「sanitize 只在解析失败时触发」的固有盲区，不是本次中文 key 修复
    // 的范围；要根治需在渲染层统一给值加引号/转义。
    const item = mockArticle({
      description: '用豆包Agent做了一个Skill，每天帮我节省半小时 #豆包工作流',
    } as Partial<Item>)
    const content = render(USER_TEMPLATE, item)
    expect(frontMatterRaw(content)).not.toMatch(/omnivore_error/)
    const fm = frontMatterParsed(content)
    expect(fm?.['前言摘要']).toBe('用豆包Agent做了一个Skill，每天帮我节省半小时')
  })

  it('块标量头不受兜底牵连：另一字段触发 sanitize 时 `摘要块: |` 原样保留（codex 二审 P2）', () => {
    const tpl = `原标题: {{{title}}}
摘要块: |
  静态多行正文`
    const fm = frontMatterParsed(render(tpl, mockArticle({
      title: 'Suu: 我发现很多大学生',
    } as Partial<Item>)))
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['原标题']).toBe('Suu: 我发现很多大学生')
    expect(fm?.['摘要块']).toBe('静态多行正文\n')
  })
})
