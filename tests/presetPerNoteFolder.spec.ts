import { DEFAULT_SETTINGS, ImageMode } from '../src/settings'
import { applyPreset, PRESETS } from '../src/settings/presets'
import { render } from '../src/settings/template'
import { itemToLocalizerMeta } from '../src/common/localizerItemMeta'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { TFile, normalizePath } from 'obsidian'
import { downloadImage, isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import { calculateMD5, detectImageFormat, saveImageToVault } from '../src/imageLocalizer/imageProcessor'
import { downloadAttachment, isRemoteAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { replaceIllegalCharsFolder } from '../src/util'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/attachmentLocalizer/attachmentDownloader')
jest.mock('../src/logger', () => ({
  log: jest.fn(), logError: jest.fn(), logInfo: jest.fn(), logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))
jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }))

const ROOT = '笔记同步助手/{{{title}}}'

describe('default filename template keeps local media alongside the note', () => {
  const title = 'Hello World 2026'
  const item = {
    id: 'i1', title, siteName: 'ex.com', originalArticleUrl: 'https://ex.com/1', author: 'Al',
    description: null, slug: 's', labels: null, highlights: null, updatedAt: null,
    savedAt: '2026-05-25T10:30:00.000Z', pageType: 'ARTICLE', content: null, publishedAt: null,
    url: 'https://ex.com/1', image: null, readAt: null, wordsCount: null, readingProgressPercent: 0,
    isArchived: false, archivedAt: null, contentReader: null,
  } as unknown as import('@omnivore-app/api').Item
  const articleFolder = replaceIllegalCharsFolder(normalizePath(render(item, ROOT, 'yyyy-MM-dd', { pathSafe: true })))
  function makeFile(): TFile {
    const file = new TFile()
    file.path = `x/${title}.md`
    file.basename = title
    return file
  }
  function makeVault(content: string, onBinary?: (path: string) => void) {
    const vault = {
      read: jest.fn().mockResolvedValue(content), modify: jest.fn(),
      process: jest.fn(async (_file: TFile, fn: (text: string) => string) => fn(content)),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(async (path: string) => onBinary?.(path)), createFolder: jest.fn(),
    }
    return vault as unknown as import('obsidian').Vault
  }

  test('image localizer uses the article folder', async () => {
    ;(isRemoteImage as jest.Mock).mockImplementation((url: string) => url.startsWith('http'))
    ;(downloadImage as jest.Mock).mockResolvedValueOnce({ success: true, data: new ArrayBuffer(10) })
    ;(detectImageFormat as jest.Mock).mockReturnValueOnce('jpg')
    ;(calculateMD5 as jest.Mock).mockReturnValueOnce('cafe')
    ;(saveImageToVault as jest.Mock).mockImplementation(async (_vault: unknown, folder: string, name: string) => `${folder}/${name}`)
    const loc = new ImageLocalizer({ vault: makeVault('![](https://cdn.ex.com/p.jpg)') } as import('obsidian').App,
      { enablePngToJpeg: false, jpegQuality: 85, attachmentFolder: ROOT, folderDateFormat: 'yyyy-MM-dd', maxRetries: 1, retryDelay: 1 })
    await loc.enqueueFile(makeFile(), itemToLocalizerMeta(item))
    await loc.processQueue()
    expect((saveImageToVault as jest.Mock).mock.calls[0][1]).toBe(articleFolder)
  })

  test('attachment localizer uses the article folder', async () => {
    ;(isRemoteAttachment as jest.Mock).mockReturnValue(true)
    ;(downloadAttachment as jest.Mock).mockResolvedValueOnce({ success: true, data: new ArrayBuffer(10) })
    let folder = ''
    const vault = makeVault('## 附件\n📎 [r.pdf](https://cdn.ex.com/r.pdf) (1MB)\n', path => { folder = path.replace(/\/[^/]+$/, '') })
    const loc = new AttachmentLocalizer({ vault } as import('obsidian').App,
      { attachmentFolder: ROOT, folderDateFormat: 'yyyy-MM-dd', maxRetries: 1, retryDelay: 1 })
    await loc.enqueueFile(makeFile(), itemToLocalizerMeta(item))
    await loc.processQueue()
    expect(folder).toBe(articleFolder)
  })
})

describe('preset per-note-folder', () => {
  test('registered', () => {
    expect(PRESETS.map((p) => p.id)).toContain('per-note-folder')
  })

  test('article, image and attachment folders share the same template', () => {
    const s = { ...DEFAULT_SETTINGS, imageMode: ImageMode.LOCAL }
    expect(applyPreset('per-note-folder', s)).toEqual({
      folder: ROOT, imageAttachmentFolder: ROOT, attachmentFolder: ROOT,
    })
  })

  test('strips date segments, keeps other segments, no duplicate title', () => {
    const s = { ...DEFAULT_SETTINGS, imageMode: ImageMode.LOCAL, folder: 'A/{{{yearSaved}}}/{{{siteName}}}/{{{date}}}' }
    expect(applyPreset('per-note-folder', s).folder).toBe('A/{{{siteName}}}/{{{title}}}')
    const withTitle = { ...s, folder: 'A/{{{title}}}' }
    expect(applyPreset('per-note-folder', withTitle).folder).toBeUndefined()
    expect(applyPreset('per-note-folder', withTitle).imageAttachmentFolder).toBe('A/{{{title}}}')
  })

  test('image folder untouched when image mode is not local', () => {
    const s = { ...DEFAULT_SETTINGS, imageMode: ImageMode.REMOTE }
    const patch = applyPreset('per-note-folder', s)
    expect(patch.imageAttachmentFolder).toBeUndefined()
    expect(patch.folder).toBe(ROOT)
    expect(patch.attachmentFolder).toBe(ROOT)
  })

  test('idempotent', () => {
    const s = { ...DEFAULT_SETTINGS, imageMode: ImageMode.LOCAL }
    const patch = applyPreset('per-note-folder', s)
    expect(applyPreset('per-note-folder', { ...s, ...patch })).toEqual({})
  })
})
