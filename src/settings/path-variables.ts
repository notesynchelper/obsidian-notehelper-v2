import type { Item } from '@omnivore-app/api'
import { normalizePath } from 'obsidian'
import { render, renderFilename } from './template'
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../util'
import { t } from '../i18n'
export type PathVariableGroup = 'date' | 'source' | 'title'
export type PathVariableId =
  | 'savedDate'
  | 'year'
  | 'month'
  | 'day'
  | 'siteName'
  | 'author'
  | 'kind'
  | 'title'
  | 'rawTitle'
  | 'messageType'
export interface PathVariable {
  group: PathVariableGroup
  id: PathVariableId
  value: string
}
export function pathVariables(): PathVariable[] {
  const kind = `{{#isMessage}}${t('pathControls.kindMessage')}{{/isMessage}}{{^isMessage}}${t('pathControls.kindArticle')}{{/isMessage}}`
  return [
    { group: 'date', id: 'savedDate', value: '{{{date}}}' },
    { group: 'date', id: 'year', value: '{{{yearSaved}}}' },
    { group: 'date', id: 'month', value: '{{{monthSaved}}}' },
    { group: 'date', id: 'day', value: '{{{daySaved}}}' },
    { group: 'source', id: 'siteName', value: '{{{siteName}}}' },
    { group: 'source', id: 'author', value: '{{{author}}}' },
    { group: 'source', id: 'kind', value: kind },
    { group: 'title', id: 'title', value: '{{{title}}}' },
    { group: 'title', id: 'rawTitle', value: '{{{rawTitle}}}' },
    { group: 'title', id: 'messageType', value: '{{{messageType}}}' },
  ]
}
export const pathVariableName = (v: PathVariable): string =>
  t(`pathControls.vars.${v.id}`)
export const appendFolderVariable = (current: string, value: string): string =>
  [current.replace(/\/+$/, ''), value].filter(Boolean).join('/')
export function insertAtCursor(
  current: string,
  value: string,
  start: number,
  end = start,
) {
  return {
    value: current.slice(0, start) + value + current.slice(end),
    cursor: start + value.length,
  }
}
/**
 * Folder insertion: exactly at the caret the user placed; without one,
 * at the end as a new sub-folder level.
 */
export function insertFolderVariable(
  current: string,
  value: string,
  selection: { start: number; end: number } | null,
) {
  if (selection) {
    return insertAtCursor(current, value, selection.start, selection.end)
  }
  const next = appendFolderVariable(current, value)
  return { value: next, cursor: next.length }
}
/** Variables (`{{{date}}}`, or whole `{{#x}}…{{/x}}` blocks) in a value, in order, deduplicated. */
export const templateVariablesIn = (value: string): string[] => [
  ...new Set(
    value.match(/\{\{[#^](\w+)\}\}[\s\S]*?\{\{\/\1\}\}|\{\{\{?\s*[\w.]+\s*\}?\}\}/g) ?? [],
  ),
]
export function renderPathPreview(
  item: Item,
  template: string,
  format: string,
  kind: 'folder' | 'filename',
): string {
  return kind === 'folder'
    ? replaceIllegalCharsFolder(
        normalizePath(render(item, template, format, { pathSafe: true })),
      )
    : replaceIllegalCharsFile(renderFilename(item, template, format))
}
