/**
 * 合并模式也要认领「升级前」的旧合并文件（codex review P1，2026-09-03）
 *
 * `singleFileName` 模板里带 `#` 的用户，升级到 3.2.11+ 之后算出来的合并文件路径
 * 变成全角＃。旧实现只在【单篇】路径上认领旧路径，合并路径没认 —— 于是当天的消息
 * 被写进一个新建的合并文件，同一天的历史被劈成两半（旧文件从此不再追加）。
 *
 * 认领本身也有护栏：用户从「不合并」切到「合并/双写」时，旧路径上很可能坐着一篇
 * 【独立笔记】。把它标成合并文件再往里追加消息是不可逆的内容搅混，所以只认领有
 * 【正向证据】的那种 —— 已被登记成合并文件，或顶层 frontmatter 带本插件写的合并指纹
 *（44 字符 Bloom 的 syncedIds / 旧格式 messages 数组）。
 * 「没有 id」不算证据（「不写 id」模式的独立笔记同样没有 id）；
 * 「有 syncedIds 这个键」也不算（用户模板可以写任意字段）。
 */

jest.mock('obsidian', () => {
  const actual = jest.requireActual('../src/__mocks__/obsidian')
  class Plugin {
    app: unknown
    constructor(app?: unknown) {
      this.app = app
    }
  }
  return { ...actual, addIcon: jest.fn(), Plugin }
})

jest.mock('../src/settingsTab', () => ({ OmnivoreSettingTab: jest.fn() }))

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

jest.mock('obsidian-daily-notes-interface', () => ({
  getDailyNoteSettings: jest.fn(() => ({ format: 'YYYY-MM-DD', folder: '', template: '' })),
  createDailyNote: jest.fn(),
  appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

import { TFile } from 'obsidian'
import OmnivorePlugin from '../src/main'
import { legacyPathOf } from '../src/sync/legacyPathClaim'
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../src/util'
import { bloomFromIds } from '../src/compressIds'

const ID = '550e8400-e29b-41d4-a716-446655440077'
// 合并 digest 的正向证据：顶层 frontmatter 带【真的 Bloom 指纹】（44 字符 base64url）
const BLOOM = bloomFromIds([ID])
const DIGEST = `---\nsyncedIds: ${BLOOM}\n---\n\n## 消息\n`
// 旧格式的 digest：messages 数组
const DIGEST_LEGACY = `---\nmessages:\n  - id: ${ID}\n---\n\n## 消息\n`
const STANDALONE = `---\nid: ${ID}\ntitle: 一篇独立笔记\n---\n\n正文\n`
// 「不写 id」模式下的独立笔记：既没有 id 也没有 syncedIds —— 只看「无 id」会误认它
const STANDALONE_NO_ID = '---\ntitle: 不写 id 模式的独立笔记\n---\n\n正文\n'
// 用户自定义前置元数据模板里恰好写了 syncedIds —— 值不是 Bloom 形状，不能当证据
const STANDALONE_FAKE_MARKER = '---\ntitle: 我的笔记\nsyncedIds: 我的标签\n---\n\n正文\n'

function tfile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop()!
  f.basename = f.name.replace(/\.md$/, '')
  return f
}

function makeItem() {
  return {
    id: ID,
    title: '同步助手_20260903_x_文本',
    savedAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    content: 'hi',
    url: '',
    slug: 's',
    labels: [],
    highlights: [],
  }
}

function makePlugin(files: Record<string, string>) {
  const created: string[] = []
  const plugin = Object.create(OmnivorePlugin.prototype) as OmnivorePlugin
  Object.assign(plugin, {
    settings: { burnAfterReading: false },
    app: {
      vault: {
        getAbstractFileByPath: (p: string) =>
          Object.prototype.hasOwnProperty.call(files, p) ? tfile(p) : null,
        read: async (f: TFile) => files[f.path] ?? '',
        create: async (p: string, c: string) => {
          created.push(p)
          files[p] = c
          return tfile(p)
        },
      },
    },
  })
  return { plugin, created }
}

function makeSyncContext(mergePaths: string[] = []) {
  const marked: string[] = []
  return {
    marked,
    ctx: {
      markMergeFile: (f: TFile) => marked.push(f.path),
      isMergeFilePath: (p: string) => mergePaths.includes(p),
      findMergeFileById: () => undefined,
      findFileByExactId: () => undefined,
      findFileById: () => undefined,
    },
  }
}

// resolveOrCreateMergeTarget 是私有方法：按名字取出来调，钉的是它的行为契约。
function resolveMergeTarget(
  plugin: OmnivorePlugin,
  args: [unknown, string, unknown, unknown, boolean?, string?, string?],
): Promise<TFile | null> {
  const fn = (plugin as unknown as Record<string, (...a: unknown[]) => Promise<TFile | null>>)
    .resolveOrCreateMergeTarget
  return fn.apply(plugin, args)
}

// 旧路径一律用真正的 legacyPathOf 算，不手写答案（codex 应修 #4）
function pathsFor(rawFolder: string, rawFilename: string) {
  const current = `${replaceIllegalCharsFolder(rawFolder)}/${replaceIllegalCharsFile(rawFilename)}.md`
  return { current, legacyPath: legacyPathOf(rawFolder, rawFilename, current) }
}

describe('resolveOrCreateMergeTarget：认领升级前的旧合并文件', () => {
  it('旧合并文件存在（半角 #、带 syncedIds）→ 复用它，不新建全角＃那份', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    expect(current).toBe('消息/同步助手_2026-09-03＃日报.md')
    expect(legacyPath).toBe('消息/同步助手_2026-09-03#日报.md')

    const { plugin, created } = makePlugin({ [legacyPath!]: DIGEST })
    const { marked, ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(legacyPath)
    expect(created).toEqual([])
    expect(marked).toEqual([legacyPath])
  })

  it('🔴 旧路径上坐着一篇独立笔记（有顶层 id）→ 不认领，照旧新建（绝不把消息追加进单篇）', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    const { plugin, created } = makePlugin({ [legacyPath!]: STANDALONE })
    const { marked, ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(current)
    expect(created).toEqual([current])
    expect(marked).toEqual([current])
  })

  it('🔴「不写 id」模式的独立笔记（无 id 也无 syncedIds）→ 同样不认领（只看「无 id」会误认它）', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    const { plugin, created } = makePlugin({ [legacyPath!]: STANDALONE_NO_ID })
    const { marked, ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(current)
    expect(created).toEqual([current])
    expect(marked).toEqual([current])
  })

  it('🔴 独立笔记的自定义 frontmatter 里恰好有 syncedIds（不是 Bloom 形状）→ 不认领', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    const { plugin, created } = makePlugin({ [legacyPath!]: STANDALONE_FAKE_MARKER })
    const { ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(current)
    expect(created).toEqual([current])
  })

  it('旧格式 digest（messages 数组）→ 照样认领', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    const { plugin, created } = makePlugin({ [legacyPath!]: DIGEST_LEGACY })
    const { ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(legacyPath)
    expect(created).toEqual([])
  })

  it('旧路径已被登记成合并文件 → 即使读不出 digest 形状也照常认领', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03#日报')
    const { plugin, created } = makePlugin({ [legacyPath!]: STANDALONE })
    const { ctx } = makeSyncContext([legacyPath!])

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(legacyPath)
    expect(created).toEqual([])
  })

  it('没有旧路径可认领 → 照旧新建（零回归）', async () => {
    const { current, legacyPath } = pathsFor('消息', '同步助手_2026-09-03')
    expect(legacyPath).toBeUndefined()

    const { plugin, created } = makePlugin({})
    const { ctx } = makeSyncContext()

    const target = await resolveMergeTarget(plugin, [
      null,
      current,
      ctx,
      makeItem(),
      false,
      '',
      legacyPath,
    ])

    expect(target?.path).toBe(current)
    expect(created).toEqual([current])
  })

})

/**
 * 双写：独立副本必须避让【两条】合并路径 —— 认领到的旧路径 + 按当前配置算出的新路径。
 * 只比认领后那条时，下一轮 path-first 分支会把这里刚建出来的独立笔记当成合并文件
 *（codex 阻断 #2）。
 */
describe('writeDualStandaloneCopy：两条合并路径都要避让', () => {
  function dualPlugin() {
    const processed: string[] = []
    const ensured: string[] = []
    const plugin = Object.create(OmnivorePlugin.prototype) as OmnivorePlugin
    Object.assign(plugin, {
      settings: {},
      ensureFolderExists: async (f: string) => {
        ensured.push(f)
      },
    })
    return { plugin, processed, ensured }
  }

  const runDual = (
    plugin: OmnivorePlugin,
    params: Record<string, unknown>,
  ): Promise<void> => {
    const fn = (plugin as unknown as Record<string, (p: unknown) => Promise<void>>)
      .writeDualStandaloneCopy
    return fn.call(plugin, params)
  }

  const baseParams = (processed: string[], mergeTargetPaths: string[]) => ({
    item: makeItem(),
    content: '正文',
    folderTemplate: '消息',
    folderDateFormat: 'yyyy-MM-dd',
    filenameTemplate: 'A＃',
    filenameDateFormat: 'yyyy-MM-dd',
    mergeTargetPaths,
    fileProcessor: {
      process: async (_i: unknown, path: string) => {
        processed.push(path)
      },
    },
    skipByCursor: false,
  })

  it('独立副本路径 == 认领后的旧合并路径 → 跳过', async () => {
    const { plugin, processed } = dualPlugin()
    await runDual(plugin, baseParams(processed, ['消息/A＃.md', '消息/别的.md']))
    expect(processed).toEqual([])
  })

  it('🔴 独立副本路径 == 按当前配置算出的新合并路径（认领后不同）→ 同样跳过', async () => {
    const { plugin, processed } = dualPlugin()
    // 合并原文 `A#` → 认领到旧的 `消息/A#.md`，但当前配置算出来仍是 `消息/A＃.md`
    await runDual(plugin, baseParams(processed, ['消息/A#.md', '消息/A＃.md']))
    expect(processed).toEqual([])
  })

  it('两条都不撞 → 照常写独立副本', async () => {
    const { plugin, processed } = dualPlugin()
    await runDual(plugin, baseParams(processed, ['消息/别的.md', '消息/也不同.md']))
    expect(processed).toEqual(['消息/A＃.md'])
  })
})
