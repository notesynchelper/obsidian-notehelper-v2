/**
 * 「升级前旧路径」的认领范围（codex review P1，2026-09-03）
 *
 * 3.2.11 起文件名里的半角 `#` 会被换成全角＃（wikilink 指不回带 # 的文件名）。
 * 升级后同一篇文章算出来的是新路径，所以要认领旧路径，否则：
 *   • 单篇：同一篇文章再建一份；
 *   • 合并：当天的合并文件被劈成两半。
 *
 * 但旧路径【不能】拿新路径「把所有全角＃换回半角」反推 —— 标题里本来就带全角＃的
 * 文章没被清洗改动过，反推出来的是一条**别人的**路径；那个文件若没有 frontmatter id，
 * 会被 handleExistingFile 整份覆写（用户自己的 `C#入门.md` 被一篇文章顶掉）。
 * 正确的判据只能来自清洗【前】的原文 —— 由 legacyPathOf 负责。
 */

import { TFile, TFolder } from 'obsidian'
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../src/util'
import { findLegacyClaimFile, legacyPathOf } from '../src/sync/legacyPathClaim'

const ID = '550e8400-e29b-41d4-a716-446655440099'

function tfile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop()!
  f.basename = f.name.replace(/\.md$/, '')
  return f
}

function makeItem(title: string, content = 'body') {
  return {
    id: ID,
    title,
    savedAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    content,
    url: 'https://example.com',
    slug: 's',
    labels: [],
    highlights: [],
  }
}

describe('清洗器：keepLinkUnsafeChars 只跳过「# → ＃」这一步', () => {
  it('默认把半角 # 换成全角＃', () => {
    expect(replaceIllegalCharsFile('C#入门')).toBe('C＃入门')
    expect(replaceIllegalCharsFolder('lang/C#')).toBe('lang/C＃')
  })

  it('keepLinkUnsafeChars 时原样保留半角 #（这就是升级前的名字）', () => {
    expect(replaceIllegalCharsFile('C#入门', { keepLinkUnsafeChars: true })).toBe('C#入门')
    expect(replaceIllegalCharsFolder('lang/C#', { keepLinkUnsafeChars: true })).toBe('lang/C#')
  })

  it('原文本来就是全角＃ → 两种模式输出一致（没被改动过，就没有旧路径）', () => {
    expect(replaceIllegalCharsFile('C＃入门')).toBe('C＃入门')
    expect(replaceIllegalCharsFile('C＃入门', { keepLinkUnsafeChars: true })).toBe('C＃入门')
  })

  it('其余非法字符照旧替换，不受选项影响', () => {
    expect(replaceIllegalCharsFile('a/b:c', { keepLinkUnsafeChars: true })).toBe('a-b-c')
  })
})

describe('legacyPathOf：旧路径只能从清洗前的原文算', () => {
  const pathOf = (rawFolder: string, rawFilename: string) =>
    `${replaceIllegalCharsFolder(rawFolder)}/${replaceIllegalCharsFile(rawFilename)}.md`

  it('原文带半角 # → 给出升级前那条路径', () => {
    const current = pathOf('Synced', 'C#入门')
    expect(current).toBe('Synced/C＃入门.md')
    expect(legacyPathOf('Synced', 'C#入门', current)).toBe('Synced/C#入门.md')
  })

  it('🔴 原文本来就带全角＃ → undefined（绝不去认领同名的半角 # 文件）', () => {
    const current = pathOf('Synced', 'C＃入门')
    expect(current).toBe('Synced/C＃入门.md')
    expect(legacyPathOf('Synced', 'C＃入门', current)).toBeUndefined()
  })

  it('原文里没有井号 → undefined', () => {
    const current = pathOf('Synced', '一篇正常的文章')
    expect(legacyPathOf('Synced', '一篇正常的文章', current)).toBeUndefined()
  })

  it('多层文件夹：每一段的半角 # 都还原，全角＃原样不动', () => {
    const current = pathOf('库/lang#tag/C＃', '周刊#410')
    expect(current).toBe('库/lang＃tag/C＃/周刊＃410.md')
    expect(legacyPathOf('库/lang#tag/C＃', '周刊#410', current)).toBe(
      '库/lang#tag/C＃/周刊#410.md',
    )
  })

  it('同名里同时有半角 # 与全角＃ → 只还原前者', () => {
    const current = pathOf('Synced', 'A#B＃C')
    expect(current).toBe('Synced/A＃B＃C.md')
    expect(legacyPathOf('Synced', 'A#B＃C', current)).toBe('Synced/A#B＃C.md')
  })

  it('文件名清洗后为空 → 两边都回退 untitled，没有旧路径', () => {
    const current = pathOf('Synced', '   ')
    expect(current).toBe('Synced/untitled.md')
    expect(legacyPathOf('Synced', '   ', current)).toBeUndefined()
  })

  it('重复斜杠经 normalizePath 归一后仍能对上（不因路径写法差异误判成有旧路径）', () => {
    const current = 'Synced/一篇正常的文章.md'
    expect(legacyPathOf('Synced/', '一篇正常的文章', current)).toBeUndefined()
  })
})

describe('findLegacyClaimFile：只认调用方算好的那条旧路径', () => {
  const vaultWith = (files: string[], folders: string[] = []) => ({
    vault: {
      getAbstractFileByPath: (p: string) => {
        if (files.includes(p)) return tfile(p)
        if (folders.includes(p)) {
          const d = new TFolder()
          d.path = p
          return d
        }
        return null
      },
    },
  })

  it('旧路径存在 → 认领', () => {
    const app = vaultWith(['Synced/C#入门.md'])
    const f = findLegacyClaimFile(app as never, 'Synced/C＃入门.md', 'Synced/C#入门.md')
    expect(f?.path).toBe('Synced/C#入门.md')
  })

  it('没有旧路径（清洗没改动过名字）→ 不认领', () => {
    const app = vaultWith(['Synced/C#入门.md'])
    expect(findLegacyClaimFile(app as never, 'Synced/C＃入门.md', undefined)).toBeNull()
  })

  it('旧路径与新路径相同 → 不认领（没有可迁移的东西）', () => {
    const app = vaultWith(['Synced/一篇文章.md'])
    expect(
      findLegacyClaimFile(app as never, 'Synced/一篇文章.md', 'Synced/一篇文章.md'),
    ).toBeNull()
  })

  it('旧路径上坐着的是文件夹 → 不认领', () => {
    const app = vaultWith([], ['Synced/C#入门.md'])
    expect(findLegacyClaimFile(app as never, 'Synced/C＃入门.md', 'Synced/C#入门.md')).toBeNull()
  })

  it('旧路径不存在 → 不认领', () => {
    const app = vaultWith([])
    expect(findLegacyClaimFile(app as never, 'Synced/C＃入门.md', 'Synced/C#入门.md')).toBeNull()
  })
})

describe('FileProcessor：认领旧路径 vs 绝不误伤同名的半角 # 文件', () => {
  function makeCtx(existing: string[]) {
    const created: string[] = []
    const modified: Array<[string, string]> = []
    return {
      burnTracker: { recordCursor: () => {}, recordDelete: () => {} },
      imageLocalizer: null,
      attachmentLocalizer: null,
      settings: { burnAfterReading: false },
      successTracker: { recordSuccess: () => {} },
      diaryLinkProcessor: { addLink: () => {} },
      findFileByExactId: () => undefined,
      findFileById: () => undefined,
      findStandaloneFileById: () => undefined,
      isMergeFilePath: () => false,
      enqueueFileForImageLocalization: async () => {},
      enqueueFileForAttachmentLocalization: async () => {},
      addProcessedFile: () => {},
      app: {
        vault: {
          getAbstractFileByPath: (p: string) => (existing.includes(p) ? tfile(p) : null),
          read: async () => '用户自己写的笔记，没有 frontmatter id',
          create: async (p: string) => {
            created.push(p)
            return tfile(p)
          },
          modify: async (f: TFile, c: string) => {
            modified.push([f.path, c])
          },
        },
      },
      _created: created,
      _modified: modified,
    }
  }

  // legacyPath 一律由真正的 legacyPathOf 算，不手写答案 —— 否则实现哪天退回
  // 「从清洗后路径反推」，这些用例照样全绿（codex 应修 #4）。
  const legacyFor = (rawFolder: string, rawFilename: string) => {
    const current = `${replaceIllegalCharsFolder(rawFolder)}/${replaceIllegalCharsFile(rawFilename)}.md`
    return { current, legacyPath: legacyPathOf(rawFolder, rawFilename, current) }
  }

  it('标题真的带半角 # → 认领升级前那份，不再建第二份', async () => {
    const ctx = makeCtx(['Synced/C#入门.md'])
    const { FileProcessor } = await import('../src/sync/FileProcessor')
    const p = new FileProcessor(ctx as never)
    const { current, legacyPath } = legacyFor('Synced', 'C#入门')
    expect(legacyPath).toBe('Synced/C#入门.md')
    await p.process(makeItem('C#入门') as never, current, '新正文', 'Synced', 'C＃入门', {
      legacyPath,
    })
    expect(ctx._created).toEqual([])
    expect(ctx._modified.map(([path]) => path)).toEqual(['Synced/C#入门.md'])
  })

  it('🔴 标题本来就带全角＃（清洗没动过）→ 建自己的新文件，绝不碰用户的 C#入门.md', async () => {
    const ctx = makeCtx(['Synced/C#入门.md'])
    const { FileProcessor } = await import('../src/sync/FileProcessor')
    const p = new FileProcessor(ctx as never)
    const { current, legacyPath } = legacyFor('Synced', 'C＃入门')
    expect(legacyPath).toBeUndefined()
    await p.process(makeItem('C＃入门') as never, current, '新正文', 'Synced', 'C＃入门', {
      legacyPath,
    })
    expect(ctx._modified).toEqual([])
    expect(ctx._created).toEqual(['Synced/C＃入门.md'])
  })
})

/**
 * 接线门：legacyPathOf 必须吃【清洗前】的原文。
 *
 * 上面那些行为用例都是把算好的 legacyPath 注进去的，挡不住「主流程哪天改成传清洗后的
 * folderName / customFilename」这类回归（codex 应修 #4）—— 那会让本文件开头描述的
 * 覆写风险原样回来。这里直接对源码下断言，钉死调用参数与两条下游传参。
 */
describe('main.ts 接线：旧路径只能来自清洗前的原文', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../src/main.ts'),
    'utf-8',
  ) as string

  it('两处 legacyPathOf 调用都传 raw* 变量，绝不传清洗后的 folderName / customFilename', () => {
    const calls = [...src.matchAll(/legacyPathOf\(([^)]*)\)/g)].map((m) =>
      m[1].replace(/\s+/g, ' ').trim(),
    )
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args).toMatch(/^raw[A-Za-z]*, raw[A-Za-z]*,/)
      expect(args).not.toContain('folderName')
      expect(args).not.toContain('customFilename')
    }
  })

  it('单篇与合并两条下游都把 legacyPath 传下去', () => {
    // fileProcessor.process(..., { legacyPath })：单篇 + 双写独立副本各一处
    const processCalls = [...src.matchAll(/fileProcessor\.process\([\s\S]{0,400}?\)\n/g)]
      .map((m) => m[0])
      .filter((c) => c.includes('legacyPath'))
    expect(processCalls.length).toBeGreaterThanOrEqual(2)
    // resolveOrCreateMergeTarget(..., legacyPath)
    expect(src).toMatch(/resolveOrCreateMergeTarget\([\s\S]{0,400}?legacyPath,/)
  })
})
