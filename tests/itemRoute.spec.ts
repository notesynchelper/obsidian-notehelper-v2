import { Item } from '@omnivore-app/api'
import { DEFAULT_SETTINGS, MergeMode } from '../src/settings'
import { isEmailItem, resolveArticleLikeProfile, resolveItemKind, shouldMergeItem, templateNeedsVariable } from '../src/sync/itemRoute'
import { resolveEffectiveSyncSettings } from '../src/sync/DebugMode'
import { isWeChatMessage, parseMessageTitle, render, renderItemContent, standaloneMessageItem } from '../src/settings/template'

const body = { title: 'Re: 周报/9月', siteName: 'Email', url: 'email://<test@example.com>' } as Item
const attachment = { ...body, url: 'https://relay-1.bijitongbu.site/p/test.pdf' }
const article = { ...body, siteName: 'Website', labels: [{ name: 'email' }] } as Item
const message = { ...body, title: '同步助手_20260928_123_文本' }

describe.each([false, true])('emailSettingsEnabled=%s', enabled => {
  describe.each([false, true])('emailIncludeAttachmentDocs=%s', attachments => {
    test.each(Object.values(MergeMode))('routing and merging: %s', mode => {
      const s = { ...DEFAULT_SETTINGS, emailSettingsEnabled: enabled, emailIncludeAttachmentDocs: attachments, mergeMode: mode }
      for (const [item, kind] of [
        [body, enabled ? 'email' : 'article'],
        [attachment, enabled && attachments ? 'email' : 'article'],
        [article, 'article'], [message, 'message'],
      ] as const) {
        expect(resolveItemKind(item, s)).toBe(kind)
        const expected = kind === 'email' ? false : mode === MergeMode.ALL ||
          (kind === 'message' && mode !== MergeMode.NONE)
        expect(shouldMergeItem(resolveItemKind(item, s), mode)).toBe(expected)
      }
    })
  })
})

test('standalone messages preserve raw identity while cleaning filename and body variables', () => {
  const rawTitle = '同步助手_20260928_报告/A_B_文件'
  const original = { ...message, title: rawTitle, content: '消息正文', savedAt: '2026-09-28T12:00:00Z', labels: [], highlights: [] } as Item
  const clean = standaloneMessageItem(original)
  expect(clean.title).toBe('报告/A_B')
  expect(isWeChatMessage(clean)).toBe(true)
  expect(resolveItemKind(clean, DEFAULT_SETTINGS)).toBe('message')
  expect(render(clean, '{{{title}}}|{{{rawTitle}}}|{{{messageTitle}}}|{{{messageType}}}', 'yyyy-MM-dd', { pathSafe: true }))
    .toBe('报告-A_B|同步助手_20260928_报告-A_B_文件|报告-A_B|文件')
  expect(renderItemContent(clean, '{{{title}}}\n{{{rawTitle}}}\n{{{messageTitle}}}\n{{{messageType}}}\n{{{content}}}', 'LOCATION', undefined,
    'yyyy-MM-dd', 'yyyy-MM-dd', false, [], '', '', '')).toContain('报告/A_B\n' + rawTitle + '\n报告/A_B\n文件\n消息正文')
  expect(original.title).toBe(rawTitle)
})

test.each(['同步助手_20260928___图片', '同步助手_20260928___聊天记录'])('empty message description falls back to media type: %s', title => {
  expect(parseMessageTitle(title).cleanTitle).toBe(title.split('_').pop())
})

test('independent message profiles override separately and fall back when empty', () => {
  const s = { ...DEFAULT_SETTINGS, messageSeparateEnabled: true, messageSeparateFolder: 'Messages', messageSeparateTemplate: 'MSG {{{content}}}' }
  expect(resolveArticleLikeProfile('message', s)).toMatchObject({ folder: 'Messages', template: 'MSG {{{content}}}' })
  expect(resolveArticleLikeProfile('message', { ...s, messageSeparateTemplate: '' }).template).toBe(s.template)
  const debug = resolveEffectiveSyncSettings(s, true)
  expect(debug.messageSeparateEnabled).toBe(false)
  expect(s.messageSeparateEnabled).toBe(true)
})

test('email detection uses source, not labels or URL alone', () => {
  expect(isEmailItem(body)).toBe(true)
  expect(isEmailItem(attachment)).toBe(true)
  expect(isEmailItem(article)).toBe(false)
})

test('profile fields independently override and fall back; ordinary items retain article profile', () => {
  const s = { ...DEFAULT_SETTINGS, folder: 'Articles', emailFolder: 'Mail', emailFolderDateFormat: 'yyyy',
    emailFilename: 'Mail-{{{title}}}', emailFilenameDateFormat: 'MM',
    emailTemplate: 'MAIL {{{content}}}', emailFrontMatterTemplate: 'from: {{{author}}}' }
  const expected = { folder: 'Mail', folderDateFormat: 'yyyy', filename: 'Mail-{{{title}}}', filenameDateFormat: 'MM',
    template: 'MAIL {{{content}}}', frontMatterTemplate: 'from: {{{author}}}' }
  expect(resolveArticleLikeProfile('email', s)).toEqual(expected)
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const emailKey = `email${key[0].toUpperCase()}${key.slice(1)}`
    expect(resolveArticleLikeProfile('email', { ...s, [emailKey]: '' })[key]).toBe(s[key])
  }
  expect(resolveArticleLikeProfile('article', s).folder).toBe('Articles')
  expect(resolveArticleLikeProfile('message', s).template).toBe(s.template)
})

test('defaults preserve existing users and give enabled email an independent folder', () => {
  expect(DEFAULT_SETTINGS.emailSettingsEnabled).toBe(false)
  expect(DEFAULT_SETTINGS.emailIncludeAttachmentDocs).toBe(true)
  expect(DEFAULT_SETTINGS.emailFolder).toBe('笔记同步助手/邮件/{{{date}}}')
})

test('debug routing uses default article location without mutating persisted email settings', () => {
  const s = { ...DEFAULT_SETTINGS, emailSettingsEnabled: true, emailFolder: 'CustomMail' }
  const effective = resolveEffectiveSyncSettings(s, true)
  expect(resolveItemKind(body, effective)).toBe('article')
  expect(resolveArticleLikeProfile(resolveItemKind(body, effective), effective).folder).toBe(DEFAULT_SETTINGS.folder)
  expect(s.emailSettingsEnabled).toBe(true)
  expect(s.emailFolder).toBe('CustomMail')
})

test('content and attachment dependencies include nested sections and tolerate relay expressions', () => {
  expect(templateNeedsVariable('{{#author}}{{#siteName}}{{{content}}}{{/siteName}}{{/author}}', 'content')).toBe(true)
  expect(templateNeedsVariable('{{^author}}{{{fileAttachment}}}{{/author}}', 'fileAttachment')).toBe(true)
  expect(templateNeedsVariable('<% "{{" %>{{{title}}}', 'content')).toBe(false)
})
