import { Item } from '@omnivore-app/api'
import { MergeMode, OmnivoreSettings } from '../settings'
import { isWeChatMessage, preParseTemplate } from '../settings/template'
import { maskTemplaterTags } from './templaterRelay'

export type ItemKind = 'message' | 'email' | 'article'

export const isEmailItem = (item: Item): boolean => item.siteName === 'Email'
export const isEmailBody = (item: Item): boolean =>
  isEmailItem(item) && (item.url ?? '').startsWith('email://')

export function resolveItemKind(item: Item, settings: OmnivoreSettings): ItemKind {
  if (isWeChatMessage(item)) return 'message'
  if (
    settings.emailSettingsEnabled && isEmailItem(item) &&
    (settings.emailIncludeAttachmentDocs || isEmailBody(item))
  ) return 'email'
  return 'article'
}

export function shouldMergeItem(kind: ItemKind, mode: MergeMode): boolean {
  return kind !== 'email' && (
    mode === MergeMode.ALL ||
    (kind === 'message' && (mode === MergeMode.MESSAGES || mode === MergeMode.DUAL))
  )
}

export function resolveArticleLikeProfile(kind: ItemKind, s: OmnivoreSettings) {
  const email = kind === 'email'
  const message = kind === 'message' && s.messageSeparateEnabled
  return {
    folder: (message && s.messageSeparateFolder) || (email && s.emailFolder) || s.folder,
    folderDateFormat: (message && s.messageSeparateFolderDateFormat) || (email && s.emailFolderDateFormat) || s.folderDateFormat,
    filename: (message && s.messageSeparateFilename) || (email && s.emailFilename) || s.filename,
    filenameDateFormat: (message && s.messageSeparateFilenameDateFormat) || (email && s.emailFilenameDateFormat) || s.filenameDateFormat,
    frontMatterTemplate: (message && s.messageSeparateFrontMatterTemplate) || (email && s.emailFrontMatterTemplate) || s.frontMatterTemplate,
    template: (message && s.messageSeparateTemplate) || (email && s.emailTemplate) || s.template,
  }
}

/** Include variables inside sections as well as top-level template variables. */
export function templateNeedsVariable(template: string, variable: string): boolean {
  const visit = (tokens: ReturnType<typeof preParseTemplate>): boolean =>
    tokens.some(token => token[1] === variable ||
      (Array.isArray(token[4]) && visit(token[4])))
  return visit(preParseTemplate(maskTemplaterTags(template).text))
}
