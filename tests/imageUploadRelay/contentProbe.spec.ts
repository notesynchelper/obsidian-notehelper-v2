/**
 * hasLocalImages / waitForRelayDone / buildScopedLocalImageRegex 单测
 *
 * 构造一个最小 App + Vault mock，把 cachedRead 用一个可变内容源驱动。
 */
import type { App, TFile } from 'obsidian'
import {
  hasLocalImages,
  waitForRelayDone,
  buildScopedLocalImageRegex,
  isPurelyTemplatedFolder,
  LOCAL_IMAGE_WIKI_REGEX,
} from '../../src/imageUploadRelay/contentProbe'

type ReadStream = () => string | Promise<string>

function makeApp(read: ReadStream, opts: { fileExists?: boolean } = {}): App {
  const fileExists = opts.fileExists ?? true
  return {
    vault: {
      cachedRead: jest.fn(async () => read()),
      getAbstractFileByPath: jest.fn(() => (fileExists ? ({} as unknown) : null)),
    },
  } as unknown as App
}

const fakeFile = { path: 'test.md' } as unknown as TFile

// 构造本插件默认设置下的 scoped regex（DEFAULT_SETTINGS 里实际就是纯静态）
const DEFAULT_SCOPED = buildScopedLocalImageRegex('笔记同步助手/images')

describe('LOCAL_IMAGE_WIKI_REGEX (宽松兜底，不做接力决策)', () => {
  it('匹配任意本地 wiki 图片（包括用户手写的）', () => {
    const samples = [
      '![[笔记同步助手/images/abc.jpg]]',
      '![[assets/diagram.png]]', // 用户手写：也会被宽松正则匹配
      '![[a/b/c.jpeg|w=100]]',
    ]
    for (const s of samples) {
      expect(LOCAL_IMAGE_WIKI_REGEX.test(s)).toBe(true)
    }
  })
})

describe('buildScopedLocalImageRegex', () => {
  describe('纯静态 folder', () => {
    it('整段 literal → 路径必须整体匹配该前缀', () => {
      const re = buildScopedLocalImageRegex('笔记同步助手/images')
      expect(re.test('![[笔记同步助手/images/a.jpg]]')).toBe(true)
      expect(re.test('![[assets/a.jpg]]')).toBe(false)
    })

    it('强制 `/` 边界：不匹配 sibling 同名前缀目录', () => {
      const re = buildScopedLocalImageRegex('笔记同步助手/images')
      expect(re.test('![[笔记同步助手/images-2/a.jpg]]')).toBe(false)
      expect(re.test('![[笔记同步助手/images_backup/a.jpg]]')).toBe(false)
    })

    it('正则特殊字符被转义', () => {
      const re = buildScopedLocalImageRegex('a.b+c')
      expect(re.test('![[a.b+c/x.jpg]]')).toBe(true)
      expect(re.test('![[aXbcc/x.jpg]]')).toBe(false)
    })

    it('支持所有候选插件扩展名的并集', () => {
      const re = buildScopedLocalImageRegex('folder')
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif']) {
        expect(re.test(`![[folder/a.${ext}]]`)).toBe(true)
      }
    })
  })

  describe('混合模板 folder：保留所有 literal 段', () => {
    it('前缀 + 模板尾巴：`笔记同步助手/images/{{{date}}}`', () => {
      const re = buildScopedLocalImageRegex('笔记同步助手/images/{{{date}}}')
      expect(re.test('![[笔记同步助手/images/2026-04-21/a.jpg]]')).toBe(true)
      // 用户手写的不同 folder 不匹配
      expect(re.test('![[assets/diagram.png]]')).toBe(false)
      expect(re.test('![[笔记同步助手/images-2/a.jpg]]')).toBe(false)
    })

    it('模板开头 + 尾部 literal：`{{{date}}}/images`', () => {
      const re = buildScopedLocalImageRegex('{{{date}}}/images')
      expect(re.test('![[2026-04-21/images/a.jpg]]')).toBe(true)
      // 用户手写的 assets 不匹配
      expect(re.test('![[assets/diagram.png]]')).toBe(false)
      // 根目录 images（无 date 段）也不再匹配——路径段数量必须和 folder 对齐
      expect(re.test('![[images/a.jpg]]')).toBe(false)
    })

    it('关键修复：literal 夹在中间时，用户手写的同前缀图片不被误中（`assets/{{{date}}}/images`）', () => {
      const re = buildScopedLocalImageRegex('assets/{{{date}}}/images')
      // 本插件本地化产物：assets/<date>/images/<file>
      expect(re.test('![[assets/2026-04-21/images/a.jpg]]')).toBe(true)
      // 用户手写的 `assets/manual/diagram.png`：段数对了但最后一段不是 `images`
      expect(re.test('![[assets/manual/diagram.png]]')).toBe(false)
      // 用户手写的 `assets/some/pic.png`：middle 段任意，但需要末尾 `images/`
      expect(re.test('![[assets/foo/bar.png]]')).toBe(false)
    })

    it('纯模板段可跨多段：`folderDateFormat=yyyy/MM/dd` 的多级日期路径能命中', () => {
      // `{{{date}}}` 展开可能含 `/`（如 2026/04/21）
      const re = buildScopedLocalImageRegex('images/{{{date}}}')
      expect(re.test('![[images/2026/04/21/a.jpg]]')).toBe(true)
      expect(re.test('![[images/2026-04-21/a.jpg]]')).toBe(true)
      // 但用户手写的 assets 前缀不会误中（段要从 `images/` 起）
      expect(re.test('![[assets/2026/04/21/a.jpg]]')).toBe(false)
    })

    it('literal 夹在中间 + 多段日期：`assets/{{{date}}}/images` 也能正确识别', () => {
      const re = buildScopedLocalImageRegex('assets/{{{date}}}/images')
      expect(re.test('![[assets/2026/04/21/images/a.jpg]]')).toBe(true)
      expect(re.test('![[assets/2026-04-21/images/a.jpg]]')).toBe(true)
      // 负例：虽然段数对了但最后一段不是 `images`
      expect(re.test('![[assets/manual/some/diagram.png]]')).toBe(false)
      expect(re.test('![[assets/2026/04/21/a.jpg]]')).toBe(false)
    })

    it('混合段（`img-{{{date}}}`）配合多段 folderDateFormat 也能匹配', () => {
      // folderDateFormat='yyyy/MM/dd' 时 `{{{date}}}` → `2026/04/21`
      // 整段 literal + template 形如 `img-2026/04/21`
      const re = buildScopedLocalImageRegex('images/img-{{{date}}}')
      expect(re.test('![[images/img-2026/04/21/a.jpg]]')).toBe(true)
      expect(re.test('![[images/img-2026-04-21/a.jpg]]')).toBe(true)
      // 负例：literal 前缀不是 `img-`
      expect(re.test('![[images/foo-2026/a.jpg]]')).toBe(false)
      // 负例：顶级 folder 不是 `images`
      expect(re.test('![[assets/img-2026/a.jpg]]')).toBe(false)
    })
  })

  describe('纯模板 folder：退化为宽松正则（不静默跳过）', () => {
    it('完全模板 → 退化 + 可被 isPurelyTemplatedFolder 识别', () => {
      const re = buildScopedLocalImageRegex('{{{folder}}}/{{{date}}}')
      expect(re.test('![[任意/路径/a.jpg]]')).toBe(true)
      expect(re.source).toBe(LOCAL_IMAGE_WIKI_REGEX.source)
    })

    it('相邻多个模板块（同一段内）算纯模板 → 退化兜底 + isPurelyTemplatedFolder=true', () => {
      // `{{{folder}}}{{{date}}}` 看似有 "内容" 但没有任何 literal 字符
      expect(isPurelyTemplatedFolder('{{{folder}}}{{{date}}}')).toBe(true)
      expect(isPurelyTemplatedFolder('{{{a}}}{{{b}}}/{{{c}}}')).toBe(true)

      const re = buildScopedLocalImageRegex('{{{folder}}}{{{date}}}')
      expect(re.source).toBe(LOCAL_IMAGE_WIKI_REGEX.source)
    })

    it('空字符串 → 宽松兜底', () => {
      const re = buildScopedLocalImageRegex('')
      expect(re.source).toBe(LOCAL_IMAGE_WIKI_REGEX.source)
    })
  })
})

describe('isPurelyTemplatedFolder', () => {
  it('任何含 literal 段的 folder → false', () => {
    expect(isPurelyTemplatedFolder('笔记同步助手/images')).toBe(false)
    expect(isPurelyTemplatedFolder('笔记同步助手/images/{{{date}}}')).toBe(false)
    expect(isPurelyTemplatedFolder('{{{date}}}/images')).toBe(false)
    expect(isPurelyTemplatedFolder('assets/{{{date}}}/images')).toBe(false)
  })

  it('完全由模板变量组成 → true', () => {
    expect(isPurelyTemplatedFolder('{{{folder}}}/{{{date}}}')).toBe(true)
    expect(isPurelyTemplatedFolder('{{{date}}}')).toBe(true)
    expect(isPurelyTemplatedFolder('')).toBe(true)
  })
})

describe('hasLocalImages', () => {
  it('含本插件本地化产物 → true', async () => {
    const app = makeApp(() => '正文\n![[笔记同步助手/images/2026/a.jpg]]\n')
    await expect(hasLocalImages(app, fakeFile, DEFAULT_SCOPED)).resolves.toBe(true)
  })
  it('只含用户手写的本地图片（不在我们的 folder 下）→ false（不应被接力）', async () => {
    const app = makeApp(() => '正文\n![[assets/diagram.png]]\n')
    await expect(hasLocalImages(app, fakeFile, DEFAULT_SCOPED)).resolves.toBe(false)
  })
  it('已是远端 md 链接 → false', async () => {
    const app = makeApp(() => '正文\n![](https://cdn.test/a.jpg)\n')
    await expect(hasLocalImages(app, fakeFile, DEFAULT_SCOPED)).resolves.toBe(false)
  })
})

describe('waitForRelayDone', () => {
  it('成功：本地 wiki 被替换为 md → ok=true', async () => {
    const pages = [
      '![[笔记同步助手/images/a.jpg]]\n![[笔记同步助手/images/b.jpg]]',
      '![[笔记同步助手/images/b.jpg]]', // 替换了一半
      '![](https://cdn.test/a.jpg)\n![](https://cdn.test/b.jpg)', // 全部完成
    ]
    let idx = 0
    const app = makeApp(() => pages[Math.min(idx++, pages.length - 1)])

    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 5000,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 10,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(true)
    expect(result.remainingLocal).toBe(0)
    expect(result.hasRemote).toBe(true)
  })

  it('超时：本插件 wiki 一直残留 → ok=false，计入剩余数', async () => {
    const app = makeApp(
      () => '![[笔记同步助手/images/a.jpg]]\n![[笔记同步助手/images/b.jpg]]',
    )

    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 200,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 50,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(false)
    expect(result.remainingLocal).toBe(2)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(200)
  })

  it('scopedRegex 限定：用户手写的本地图片不会阻塞完成检测', async () => {
    // 笔记里始终保留用户手写的 `![[assets/diagram.png]]`（不在我们的 folder 下）
    // 本插件本地化产物从 1 张变 0 张 → 应判 ok=true
    const pages = [
      '![[笔记同步助手/images/a.jpg]]\n![[assets/diagram.png]]',
      '![](https://cdn.test/a.jpg)\n![[assets/diagram.png]]', // 只替换了我们的那张
    ]
    let idx = 0
    const app = makeApp(() => pages[Math.min(idx++, pages.length - 1)])

    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 1000,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 10,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(true)
    expect(result.remainingLocal).toBe(0)
  })

  it('文件被删/rename（vault 确认不存在）→ ok=true', async () => {
    const app = makeApp(
      () => {
        throw new Error('ENOENT')
      },
      { fileExists: false },
    )
    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 1000,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 10,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(true)
    expect(result.remainingLocal).toBe(0)
  })

  it('持续 I/O 错误但文件仍在 vault → 超时后 ok=false（不伪装成功）', async () => {
    const app = makeApp(
      () => {
        throw new Error('EACCES transient')
      },
      { fileExists: true },
    )
    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 100,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 20,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it('成功但无远端 URL（插件把图片替换成 plain 文本）→ 仍 ok=true', async () => {
    const pages = [
      '![[笔记同步助手/images/a.jpg]]',
      '(图片已外链到其他位置)',
    ]
    let idx = 0
    const app = makeApp(() => pages[Math.min(idx++, pages.length - 1)])

    let nowTick = 0
    const result = await waitForRelayDone(app, fakeFile, {
      timeoutMs: 1000,
      scopedRegex: DEFAULT_SCOPED,
      pollMs: 10,
      now: () => nowTick,
      sleep: async (ms) => { nowTick += ms },
    })
    expect(result.ok).toBe(true)
    expect(result.remainingLocal).toBe(0)
    expect(result.hasRemote).toBe(false)
  })
})
