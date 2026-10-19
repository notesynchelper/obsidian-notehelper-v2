import { normalizeApiKey, checkApiKeyFormat } from '../src/settings/apiKeyValidation'
import { appendFolderVariable, insertAtCursor, insertFolderVariable, renderPathPreview, pathVariables, templateVariablesIn } from '../src/settings/path-variables'
import { applyPreset, isVisibleSetting, PATH_KEYS } from '../src/settings/presets'
import { DEFAULT_SETTINGS, ImageMode, MergeMode } from '../src/settings'
import { parseMessageTitle, messageTemplateValues, render } from '../src/settings/template'
import { resolveArticleLikeProfile } from '../src/sync/itemRoute'
import type { Item } from '@omnivore-app/api'

const item = { title: '同步助手_20260929_a/b__c_文本', savedAt: '2026-09-29T12:34:56Z', siteName: '平台', author: '作者', url: 'https://example.com' } as Item

test('key normalization and advisory format validation', () => {
  expect(normalizeApiKey(' o​12 \n\t　﻿')).toBe('o12')
  expect(checkApiKeyFormat('o' + 'a'.repeat(27))).toBe('')
  expect(['custom', 'a'.repeat(28), 'o' + '!'.repeat(27)].map(checkApiKeyFormat)).toEqual(['length', 'prefix', 'charset'])
})
test('path insertion preserves templates and caret selection', () => {
  for (const [a,b] of [['','{{{date}}}'], ['A/','A/{{{date}}}'], ['A/{{{siteName}}}', 'A/{{{siteName}}}/{{{date}}}']]) expect(appendFolderVariable(a, '{{{date}}}')).toBe(b)
  expect(insertAtCursor('abcd', 'X', 1, 3)).toEqual({value:'aXd', cursor:2})
  expect(renderPathPreview(item, 'A/{{{title}}}', 'yyyy-MM-dd', 'folder')).not.toContain('a/b')
  for (const v of pathVariables()) expect(renderPathPreview(item, v.value, 'yyyy-MM-dd', 'filename')).toBeTruthy()
})
test.each(['文本','图片','视频','语音','文件','聊天记录','笔记','媒体'])('title parser %s', type => {
  expect(parseMessageTitle(`同步助手_20260929___a__b\n_c___${type}`)).toEqual({date:'20260929',desc:'a_b _c',type,cleanTitle:'a_b _c'})
  expect(parseMessageTitle(`同步助手_20260929__${type}`).cleanTitle).toBe(type)
})
test('unknown suffix and ordinary titles stay intact; variables are available everywhere', () => {
  expect(parseMessageTitle('同步助手_20260929_a_未知').cleanTitle).toBe('同步助手_20260929_a_未知')
  expect(messageTemplateValues(item)).toMatchObject({rawTitle:item.title,messageTitle:'a/b_c',messageType:'文本'})
  expect(render(item, '{{{messageTitle}}}|{{{messageType}}}|{{{rawTitle}}}', 'yyyy')).toBe('a/b_c|文本|' + item.title)
})
test('message profile opt-in, field fallback, independent defaults', () => {
  expect(DEFAULT_SETTINGS.messageSeparateEnabled).toBe(false)
  expect(resolveArticleLikeProfile('message', DEFAULT_SETTINGS).folder).toBe(DEFAULT_SETTINGS.folder)
  const s = {...DEFAULT_SETTINGS,messageSeparateEnabled:true,messageSeparateTemplate:'M',messageSeparateFilename:''}
  expect(resolveArticleLikeProfile('message',s)).toMatchObject({folder:s.messageSeparateFolder,template:'M',filename:s.filename})
  expect(resolveArticleLikeProfile('article',s).template).toBe(s.template)
})
test('four presets are minimal patches, preserve mixed segments, and are idempotent', () => {
  const s = {...DEFAULT_SETTINGS,folder:'A/{{{yearSaved}}}-{{{monthSaved}}}/prefix-{{{date}}}/{{{siteName}}}'}
  expect(applyPreset('no-date', s).folder).toBe('A/prefix-{{{date}}}/{{{siteName}}}')
  expect(applyPreset('platform', DEFAULT_SETTINGS).folder).toBe('笔记同步助手/{{{siteName}}}')
  expect(applyPreset('separate', DEFAULT_SETTINGS)).toEqual({mergeMode:MergeMode.NONE,messageSeparateEnabled:true})
  expect(applyPreset('defaults', {...DEFAULT_SETTINGS,folder:'X'})).toEqual({folder:DEFAULT_SETTINGS.folder})
  for (const id of ['no-date','platform','separate','defaults'] as const) {
    const patch = applyPreset(id,s)
    expect(applyPreset(id,{...s,...patch})).toEqual({})
  }
})

test('platform replaces the date segment in place and removes duplicate date levels', () => {
 expect(applyPreset('platform',{...DEFAULT_SETTINGS,folder:'A/{{{date}}}/B/{{{yearSaved}}}'}).folder).toBe('A/{{{siteName}}}/B')
 expect(applyPreset('no-date',{...DEFAULT_SETTINGS,folder:'{{{date}}}'}).folder).toBe('')
})

test('folder variables go exactly to the caret, or become a new last level without one', () => {
  expect(insertFolderVariable('A/B', 'X', null)).toEqual({ value: 'A/B/X', cursor: 5 })
  expect(insertFolderVariable('Notes-', 'X', { start: 6, end: 6 })).toEqual({ value: 'Notes-X', cursor: 7 })
  expect(insertFolderVariable('A/B', 'X', { start: 1, end: 1 })).toEqual({ value: 'AX/B', cursor: 2 })
  expect(insertFolderVariable('', 'X', null)).toEqual({ value: 'X', cursor: 1 })
  expect(templateVariablesIn('A/{{{date}}}/{{ siteName }}/{{#isMessage}}m{{/isMessage}}{{^isMessage}}a{{/isMessage}}/{{{date}}}'))
    .toEqual(['{{{date}}}', '{{ siteName }}', '{{#isMessage}}m{{/isMessage}}', '{{^isMessage}}a{{/isMessage}}'])
})

test('presets never touch diary settings or fields hidden on the settings page', () => {
  expect(PATH_KEYS).not.toContain('diaryFolder')
  expect(PATH_KEYS).not.toContain('diaryDateFormat')
  const s = { ...DEFAULT_SETTINGS, mergeMode: MergeMode.NONE, emailSettingsEnabled: false, messageSeparateEnabled: false,
    imageMode: ImageMode.REMOTE, diaryFolder: 'Daily', diaryDateFormat: 'yyyyMMdd', emailFolder: 'E', messageFolder: 'M',
    messageSeparateFolder: 'S', imageAttachmentFolder: 'I', folder: 'F' }
  expect(applyPreset('defaults', s)).toEqual({ folder: DEFAULT_SETTINGS.folder })
  for (const key of ['emailFolder', 'messageFolder', 'messageSeparateFolder', 'imageAttachmentFolder']) expect(isVisibleSetting(key, s)).toBe(false)
  const shown = { ...s, mergeMode: MergeMode.DUAL, emailSettingsEnabled: true, messageSeparateEnabled: true, imageMode: ImageMode.LOCAL }
  for (const key of ['emailFolder', 'messageFolder', 'messageSeparateFolder', 'imageAttachmentFolder']) expect(isVisibleSetting(key, shown)).toBe(true)
  expect(Object.keys(applyPreset('defaults', shown)).sort()).toEqual(['emailFolder', 'folder', 'imageAttachmentFolder', 'messageFolder', 'messageSeparateFolder'])
  expect(isVisibleSetting('messageSeparateEnabled', s)).toBe(true)
})
