/**
 * 判断笔记正文模板里是否引用了正文变量。
 *
 * 正文只由 `content` 这一个变量携带（文章视图与消息视图都是；description / highlights
 * 只是摘要和划线，不算正文）。容忍花括号内的空白，以及 `{{&content}}`、
 * `{{#content}}`、`{{^content}}`、`{{/content}}` 这些等价写法。
 * 空模板返回 false（调用方自行决定空模板是否回退到默认模板而不提示）。
 */
const BODY_VARIABLE = /\{\{[{&#^/]?\s*content\s*\}{2,3}/

export function templateHasBody(template: string | null | undefined): boolean {
  return BODY_VARIABLE.test(template ?? '')
}
