import { DEFAULT_SETTINGS, ImageMode, MergeMode, OmnivoreSettings } from './index'
export const PRESETS = [
  { id: 'no-date' },
  { id: 'platform' },
  { id: 'separate' },
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
  if (key.startsWith('messageSeparate') && key !== 'messageSeparateEnabled')
    return (
      s.messageSeparateEnabled &&
      [MergeMode.NONE, MergeMode.DUAL].includes(s.mergeMode)
    )
  if (key.startsWith('email')) return s.emailSettingsEnabled
  if (['messageFolder', 'singleFileName', 'singleFileDateFormat'].includes(key))
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
  if (id === 'separate') {
    patch.mergeMode = MergeMode.NONE
    patch.messageSeparateEnabled = true
  }
  if (id === 'defaults')
    for (const key of PATH_KEYS) patch[key] = DEFAULT_SETTINGS[key]
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) =>
        s[key as keyof OmnivoreSettings] !== value && isVisibleSetting(key, s),
    ),
  )
}
