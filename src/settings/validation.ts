import { Notice } from 'obsidian'
import { preParseTemplate } from './template'
import { formatDate } from '../util'
import { maskTemplaterTags } from '../sync/templaterRelay'
import { tf } from '../i18n'

// Errors found while the user is still typing in a field are held until that field loses focus.
const pendingNotices = new Map<Element, string>()

function focusedField(): Element | null {
  const doc =
    (window as Window & { activeDocument?: Document }).activeDocument ??
    (typeof document === 'undefined' ? undefined : document)
  const el = doc?.activeElement
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null
}

function report(message: string | null): void {
  const field = focusedField()
  if (field) {
    if (message) pendingNotices.set(field, message)
    else pendingNotices.delete(field)
    return
  }
  if (message) new Notice(message)
}

/** Show held validation errors for `field`, or for every field when omitted. */
export function flushValidationNotice(field?: EventTarget | null): void {
  for (const [el, message] of [...pendingNotices]) {
    if (field && el !== field) continue
    pendingNotices.delete(el)
    new Notice(message)
  }
}

/**
 * 验证 Mustache 模板语法
 * @param opts.allowTemplaterTags 仅支持 Templater 接力的字段（文章模板 / 助手
 *   消息模板）可传 true：校验前先掩码 <% %>，Templater 表达式里的 {{ / }} 不归
 *   Mustache 管（这两个字段的运行时渲染同样掩码，两边一致）。
 *   其余字段（前置元数据 / 文件夹 / 文件名 / 合并文件模板等）**必须**保持严格
 *   校验：它们的运行时渲染/预解析不掩码，放进含 <% "{{" %> 的值会让每轮同步
 *   在 preParseTemplate 处直接失败（codex P1）。
 * @returns true 如果合法，false 如果有语法错误（正在输入时等失焦再弹 Notice）
 */
export function validateTemplate(
  value: string,
  fieldName: string,
  opts: { allowTemplaterTags?: boolean } = {},
): boolean {
  if (!value) {  // 空值不验证
    report(null)
    return true
  }
  try {
    preParseTemplate(
      opts.allowTemplaterTags === true ? maskTemplaterTags(value).text : value,
    )
    report(null)
    return true
  } catch (e) {
    report(tf('validation.template', { name: fieldName, error: e instanceof Error ? e.message : String(e) }))
    return false
  }
}

/**
 * 验证日期格式字符串
 * @returns true 如果合法，false 如果格式无效（同时弹出 Notice）
 */
export function validateDateFormat(value: string, fieldName: string): boolean {
  if (!value) {  // 空值不验证
    report(null)
    return true
  }
  try {
    const result = formatDate(new Date().toISOString(), value)
    // 如果格式化结果仍然和原始格式字符串完全一样，说明格式无效
    if (result === value && /[yMdHhms]/.test(value)) {
      report(tf('validation.dateFormat', { name: fieldName }))
      return false
    }
    report(null)
    return true
  } catch (e) {
    report(tf('validation.dateFormatError', { name: fieldName, error: e instanceof Error ? e.message : String(e) }))
    return false
  }
}
