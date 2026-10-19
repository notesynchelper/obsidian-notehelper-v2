import { templateHasBody } from '../src/settings/templateBody'

describe('templateHasBody', () => {
  it.each([
    '{{{content}}}',
    '{{content}}',
    '{{{ content }}}',
    '{{  content  }}',
    '{{&content}}',
    '{{& content }}',
    '---\n## 📅 {{{dateSaved}}}\n{{{content}}}',
    '{{#indent}}{{{content}}}{{/indent}}',
    '{{#content}}{{.}}{{/content}}',
    '{{^content}}无正文{{/content}}',
  ])('含正文变量: %j', (tpl) => {
    expect(templateHasBody(tpl)).toBe(true)
  })

  it.each([
    '# {{{title}}}',
    '{{{title}}}\n{{{dateSaved}}}',
    '',
    '   ',
    '{{{contents}}}',
    '{{{mycontent}}}',
    '{{{content2}}}',
    'content',
    '{{{description}}}{{{highlights}}}',
    null,
    undefined,
  ])('不含正文变量: %j', (tpl) => {
    expect(templateHasBody(tpl)).toBe(false)
  })
})
