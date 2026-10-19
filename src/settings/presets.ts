import { DEFAULT_SETTINGS, ImageMode, MergeMode, OmnivoreSettings } from './index'
export const PRESETS = [
  { id: 'no-date' },
  { id: 'platform' },
  { id: 'separate' },
  { id: 'per-note-folder' },
  { id: 'defaults' },
] as const
export type PresetId = (typeof PRESETS)[number]['id']
const folders = [
  'folder',
  'messageFolder',
  'messageSeparateFolder',
  'emailFolder',
  'attachmentFolder',
] as const
// Diary folder / date format point at the user's existing daily notes, so a path reset must not touch them.
export const PATH_KEYS = [
  ...folders,
  'imageAttachmentFolder',
  'filename',
  'filenameDateFormat',
  'folderDateFormat',
  'singleFileName',
  'singleFileDateFormat',
  'emailFilename',
  'emailFolderDateFormat',
  'emailFilenameDateFormat',
  'messageSeparateFilename',
  'messageSeparateFolderDateFormat',
  'messageSeparateFilenameDateFormat',
] as const
/** Whether the settings page currently shows this field; presets only touch visible fields. */
export function isVisibleSetting(key: string, s: OmnivoreSettings): boolean {
  // 合并文件组只在模式 ≠ NONE 时显示；单条消息组只在 NONE / DUAL 时显示。
  if (key === 'messageSeparateEnabled')
    return [MergeMode.NONE, MergeMode.DUAL].includes(s.mergeMode)
  if (key.startsWith('messageSeparate') && key !== 'messageSeparateEnabled')
    return (
      s.messageSeparateEnabled &&
      [MergeMode.NONE, MergeMode.DUAL].includes(s.mergeMode)
    )
  if (key.startsWith('email')) return s.emailSettingsEnabled
  if (
    [
      'messageFolder',
      'singleFileName',
      'singleFileDateFormat',
      'mergeFileTemplate',
      'wechatMessageTemplate',
      'chatRecordTimestampTemplate',
      'messageSortOrder',
      'disableMessageMarkers',
    ].includes(key)
  )
    return s.mergeMode !== MergeMode.NONE
  if (key === 'imageAttachmentFolder') return s.imageMode === ImageMode.LOCAL
  return true
}
export function isDateSegment(segment: string): boolean {
  const rest = segment.replace(
    /\{\{\{?\s*(?:date|dateSaved|yearSaved|monthSaved|daySaved)\s*\}?\}\}/g,
    '',
  )
  return rest !== segment && /^[\s._-]*$/.test(rest)
}
export function applyPreset(
  id: PresetId,
  s: OmnivoreSettings,
): Partial<OmnivoreSettings> {
  const patch: Partial<OmnivoreSettings> = {}
  if (id === 'no-date')
    for (const key of folders)
      patch[key] = s[key]
        .split('/')
        .filter((p) => !isDateSegment(p))
        .join('/')
  if (id === 'platform') {
    let inserted = s.folder
      .split('/')
      .some((p) => p.trim() === '{{{siteName}}}')
    const parts = s.folder.split('/').flatMap((p) => {
      if (!isDateSegment(p)) return [p]
      if (inserted) return []
      inserted = true
      return ['{{{siteName}}}']
    })
    if (!inserted) parts.push('{{{siteName}}}')
    patch.folder = parts.filter(Boolean).join('/')
  }
  if (id === 'per-note-folder') {
    // 文章、图片、附件采用相同文件夹模板，渲染后落入同一目录。
    const parts = s.folder.split('/').filter((p) => !isDateSegment(p))
    if (!parts.some((p) => p.includes('{{{title}}}'))) parts.push('{{{title}}}')
    const target = parts.filter(Boolean).join('/')
    patch.folder = target
    patch.imageAttachmentFolder = target
    patch.attachmentFolder = target
  }
  if (id === 'separate') {
    patch.mergeMode = MergeMode.NONE
    patch.messageSeparateEnabled = true
  }
  if (id === 'defaults')
    for (const key of PATH_KEYS) patch[key] = DEFAULT_SETTINGS[key]
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) =>
        s[key as keyof OmnivoreSettings] !== value &&
        // 开关和合并模式一起改变时，以预设应用后的模式判断可见性。
        isVisibleSetting(
          key,
          key === 'messageSeparateEnabled' && patch.mergeMode
            ? { ...s, mergeMode: patch.mergeMode }
            : s,
        ),
    ),
  )
}

/** 清空合并文件名表示不要前缀，显式保存只含日期的模板。 */
export function normalizeSingleFileNameInput(value: string): string {
  return value === '' ? '{{{date}}}' : value
}

/** 应用预设前，从合并模式切到不合并时的补充提示。 */
export function presetWarningKey(
  before: MergeMode,
  after: MergeMode | undefined,
): 'presets.articlesUnmerged' | 'presets.dailyFilesStop' | null {
  if (after !== MergeMode.NONE) return null
  if (before === MergeMode.ALL) return 'presets.articlesUnmerged'
  if (before === MergeMode.DUAL || before === MergeMode.MESSAGES)
    return 'presets.dailyFilesStop'
  return null
}
