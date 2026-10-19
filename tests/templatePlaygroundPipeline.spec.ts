/**
 * 针对 cfnotehelper 里的前置元数据模拟器（template-playground.html）所用
 * pipeline 模块做契约测试。
 *
 * 模拟器脚本位置: /home/work/gate/cfnotehelper/public/template-playground-pipeline.js
 * 关系: 模拟器需要 1:1 复刻本插件 src/settings/template.ts 的 YAML 行为。
 *       这些用例用来保证模拟器"看着能过"的模板和"插件里能落盘"的模板一致。
 *
 * 技术细节:
 *   模拟器脚本是 UMD，浏览器分支需要 root.Mustache / root.jsyaml 全局。
 *   用 vm.runInContext 构造一个带这些全局的沙箱，绕开 cfnotehelper 缺依赖
 *   的情况（cfnotehelper 没装 js-yaml，但 obsidian-plug 有）。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mustache = require('mustache')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsyaml = require('js-yaml')

interface PipelineResult {
  output: string
  rendered: string
  error: string | null
  parsed: Record<string, unknown>
  sanitized: boolean
}
interface Pipeline {
  sanitizeRenderedYaml: (rendered: string) => string
  renderFrontMatter: (
    template: string,
    articleView: Record<string, unknown>,
    options?: { itemId?: string },
  ) => PipelineResult
  renderFolder: (
    template: string,
    articleView: Record<string, unknown>,
  ) => { rendered: string; error: string | null }
}

function loadSimulatorPipeline(): Pipeline {
  const pipelinePath = path.resolve(
    __dirname,
    '../../../cfnotehelper/public/template-playground-pipeline.js',
  )
  const src = fs.readFileSync(pipelinePath, 'utf8')
  const sandbox: Record<string, unknown> = {
    Mustache,
    jsyaml,
    Set,
    Object,
    Array,
    JSON,
    String,
  }
  // UMD 检查 `typeof self` —— 让 self 指向 sandbox 自身触发浏览器分支
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: pipelinePath })
  const pipeline = sandbox.TemplatePipeline as Pipeline | undefined
  if (!pipeline) {
    throw new Error('模拟器脚本未挂载 TemplatePipeline，检查 UMD 分支')
  }
  return pipeline
}

const pipeline = loadSimulatorPipeline()

// 复刻 simulator buildArticleView 的关键字段（只放测试里用到的）
function mockView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    author: 'John Doe',
    siteName: 'example.com',
    originalUrl: 'https://example.com/article/test',
    description: 'desc',
    dateSaved: '2024-01-15 10:30:00',
    datePublished: '2024-01-10 00:00:00',
    dateRead: '2024-01-16 08:00:00',
    updatedAt: '2024-01-15 12:00:00',
    image: 'https://example.com/cover.jpg',
    fileAttachment: 'attachments/my.pdf',
    labels: [] as Array<{ name: string }>,
    ...overrides,
  }
}

describe('template-playground 模拟器 - 前置元数据 pipeline 契约', () => {
  describe('对齐插件：踩坑模板必须报错（之前模拟器会误判为成功）', () => {
    const USER_BROKEN_TEMPLATE = `author: {{{author}}}
url: {{{siteName}}}
source: "{{{originalUrl}}}"
saved: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}
tags: {{#labels}}[{{{name}}}]{{/labels}}
cover：
{{{dateSaved}}}
{{{datePublished}}}
{{{dateRead}}}
{{{updatedAt}}}
{{{image}}}
附件路径：{{{fileAttachment}}}`

    it('完整用户模板 - error 不为 null 且 parsed 只剩 id + omnivore_error', () => {
      const view = mockView({ labels: [{ name: 'tech' }, { name: 'react' }] })
      // 先预计算 formatDate（pipeline 本身不管这个，view 里直接给成字符串即可）
      view.dateSaved = '2024-01-15' // 模板里有 formatDate，这里简化用已格式化的值
      const tpl = USER_BROKEN_TEMPLATE.replace(
        '{{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}',
        '{{{dateSaved}}}',
      )
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'test-id-123' })
      expect(r.error).not.toBeNull()
      expect(r.parsed.id).toBe('test-id-123')
      expect(r.parsed.omnivore_error).toMatch(/error parsing/i)
      // 用户字段必须全部丢失（与插件真实落盘一致）
      expect(r.parsed.author).toBeUndefined()
      expect(r.parsed.cover).toBeUndefined()
      expect(r.parsed['附件路径']).toBeUndefined()
    })

    it('bug-1 全角冒号 `cover：` 单独能触发错误', () => {
      const tpl = 'author: {{{author}}}\ncover：\n{{{image}}}'
      const r = pipeline.renderFrontMatter(tpl, mockView(), { itemId: 'x' })
      expect(r.error).not.toBeNull()
      expect(r.parsed.omnivore_error).toBeDefined()
    })

    it('bug-2 多 label 时 `tags: [a][b]` 不是合法列表 → 报错或退化为字符串', () => {
      const tpl =
        'title: {{{title}}}\ntags: {{#labels}}[{{{name}}}]{{/labels}}'
      const view = mockView({ labels: [{ name: 'a' }, { name: 'b' }] })
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'x' })
      // 插件里 tags 应是数组；模板产出 `[a][b]` 不是合法 YAML 列表
      // 要么解析失败 (error != null)，要么 tags 被解析成非数组
      const tagsOk = Array.isArray(r.parsed.tags)
      expect(r.error !== null || !tagsOk).toBe(true)
    })

    it('bug-3 多个裸值（ISO 日期/URL）独占一行 → 与 mapping 冲突触发解析失败', () => {
      // 真实插件里 updatedAt 是 ISO 串 "yyyy-MM-ddTHH:mm:ss.sssZ"，
      // 裸值行里的 `T10:30:00` 会被 YAML 视为 key 与上方 mapping 冲突
      const tpl = [
        'author: {{{author}}}',
        '{{{updatedAt}}}',
        '{{{image}}}',
      ].join('\n')
      const view = mockView({ updatedAt: '2024-01-15T10:30:00.000Z' })
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'x' })
      expect(r.error).not.toBeNull()
      expect(r.parsed.omnivore_error).toBeDefined()
    })

    it('bug-4 空 labels 时 `tags: ` 解析为 null（字段丢失）', () => {
      const tpl = 'tags: {{#labels}}[{{{name}}}]{{/labels}}'
      const view = mockView({ labels: [] })
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'x' })
      // YAML 能解析，但 tags 是 null
      expect(r.error).toBeNull()
      expect(r.parsed.tags).toBeNull()
    })
  })

  describe('正常模板不应报错', () => {
    it('全字段合规模板 - no error', () => {
      const tpl = [
        'author: "{{{author}}}"',
        'url: "{{{siteName}}}"',
        'source: "{{{originalUrl}}}"',
        'saved: "{{{dateSaved}}}"',
        'cover: "{{{image}}}"',
        'datePublished: "{{{datePublished}}}"',
        'updatedAt: "{{{updatedAt}}}"',
        'fileAttachment: "{{{fileAttachment}}}"',
      ].join('\n')
      const r = pipeline.renderFrontMatter(tpl, mockView(), { itemId: 'abc' })
      expect(r.error).toBeNull()
      expect(r.parsed.id).toBe('abc')
      expect(r.parsed.author).toBe('John Doe')
      expect(r.parsed.cover).toBe('https://example.com/cover.jpg')
      expect(r.parsed.fileAttachment).toBe('attachments/my.pdf')
      expect(r.sanitized).toBe(false)
    })
  })

  describe('sanitize 兜底语义：踩线但能救回来', () => {
    it('title 裸值含冒号 → 首次 parseYaml 会失败 → sanitize 补引号救回', () => {
      const tpl = 'title: {{{title}}}'
      const view = mockView({ title: 'React: A Complete Guide' })
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'x' })
      // sanitize 兜底让 parse 成功
      expect(r.error).toBeNull()
      expect(r.sanitized).toBe(true)
      expect(r.parsed.title).toBe('React: A Complete Guide')
    })

    it('字符串值含换行 → pipeline 先把换行折成空格 → 不需要 sanitize', () => {
      const tpl = 'description: "{{{description}}}"'
      const view = mockView({ description: 'line1\nline2\nline3' })
      const r = pipeline.renderFrontMatter(tpl, view, { itemId: 'x' })
      expect(r.error).toBeNull()
      expect(r.parsed.description).toBe('line1 line2 line3')
    })
  })

  describe('和插件真实流水线的对照', () => {
    // 直接对比 obsidian-plug 的 sanitizeRenderedYaml：两边对同一段输入
    // 的输出必须完全一致。避免两边实现悄悄分叉。
    it('sanitizeRenderedYaml 行为与插件一致', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pluginTpl = require('../src/settings/template')
      const cases = [
        'title: React: A Guide',
        'author: O"Brien',
        'desc: see [link]',
        'flag: true',
        'ok: "already quoted"',
        '  nested: value',
        '',
        'lone line without key',
        // 中文 key（2026-10-09「天圆地方」工单同步：模拟器必须跟进插件的正则扩展）
        '原标题: Suu: 我发现很多大学生',
        '前言摘要: @AI巨风 发布的微头条',
        'Tags标签: 副标: 说明',
        '原标题: 正常的中文标题',
        // 块标量头不得加引号（否则缩进正文跟着炸）
        'title: @user\n描述: |\n  一段正文',
        'title: @user\nfolded: >-\n  body',
      ]
      for (const input of cases) {
        expect(pipeline.sanitizeRenderedYaml(input)).toBe(
          pluginTpl.sanitizeRenderedYaml(input),
        )
      }
    })
  })

  describe('id 始终保底', () => {
    it('模板完全是错的 - 最终 parsed 仍然有 id', () => {
      const r = pipeline.renderFrontMatter('完全:  不是：YAML\n[[崩]]', mockView(), {
        itemId: 'safe-id',
      })
      expect(r.parsed.id).toBe('safe-id')
    })

    it('模板为空 - 最终 parsed 仍然有 id', () => {
      const r = pipeline.renderFrontMatter('', mockView(), { itemId: 'safe-id' })
      expect(r.error).toBeNull()
      expect(r.parsed.id).toBe('safe-id')
    })
  })

  // 路径分流 tab：模拟器的 renderFolder 必须和插件 render() 一样支持 isMessage
  // section，否则用户在模拟器里调出来的「文章/消息分目录」模板到插件里行为不一致。
  describe('对齐插件：folder 路径模板支持 {{#isMessage}} 分流（自 3.0.0）', () => {
    const SPLIT_TPL =
      '笔记同步助手/{{#isMessage}}messages{{/isMessage}}{{^isMessage}}articles{{/isMessage}}/images'

    it('isMessage=true（企微消息）→ messages 目录', () => {
      const r = pipeline.renderFolder(SPLIT_TPL, { isMessage: true })
      expect(r.error).toBeNull()
      expect(r.rendered).toBe('笔记同步助手/messages/images')
    })

    it('isMessage=false（文章）→ articles 目录', () => {
      const r = pipeline.renderFolder(SPLIT_TPL, { isMessage: false })
      expect(r.error).toBeNull()
      expect(r.rendered).toBe('笔记同步助手/articles/images')
    })

    it('缺省 isMessage（未注入）→ 走 ^isMessage（articles），不报错', () => {
      const r = pipeline.renderFolder(SPLIT_TPL, { labels: [] })
      expect(r.error).toBeNull()
      expect(r.rendered).toBe('笔记同步助手/articles/images')
    })
  })
})
