/**
 * waitForRenameDone / extractScopedLinks 单测
 *
 * 改名接力与上传接力的**完成判据不同**：Paste image rename 只把
 * `![[.../a3f9c2.png]]` 改成 `![[.../我的笔记.png]]`，链接**仍是本地 wiki**，
 * 永远不会像上传那样归零。所以完成判据改为「触发前记录的那批原始链接是否都消失」，
 * 并用「内容连续不变即稳定」兜住无法被改名的扩展名（svg/avif 等）。
 */
import type { App, TFile } from 'obsidian'
import {
  waitForRenameDone,
  extractScopedLinks,
  buildScopedLocalImageRegex,
} from '../../src/imageUploadRelay/contentProbe'

const FOLDER = '笔记同步助手/images'
const scoped = buildScopedLocalImageRegex(FOLDER)

function makeApp(contents: string[]): App {
  let idx = 0
  return {
    vault: {
      cachedRead: jest.fn(async () => {
        const c = contents[Math.min(idx, contents.length - 1)]
        idx += 1
        return c
      }),
      getAbstractFileByPath: jest.fn(() => ({}) as unknown),
    },
  } as unknown as App
}

const fastClock = () => {
  let t = 0
  return () => (t += 10)
}

const file = { path: 'note.md', basename: 'note' } as unknown as TFile

describe('extractScopedLinks', () => {
  it('抽取当前笔记里所有本插件本地化产物的整串（含 alias）', () => {
    const content =
      '![[笔记同步助手/images/a3f9c2.png]]\n' +
      '一些文字 ![[笔记同步助手/images/b7c1.jpg|300]] 更多文字\n' +
      '![[assets/用户自己的图.png]]' // 不在前缀下，不应被抽到
    const links = extractScopedLinks(content, scoped)
    expect(links).toEqual([
      '![[笔记同步助手/images/a3f9c2.png]]',
      '![[笔记同步助手/images/b7c1.jpg|300]]',
    ])
  })
})

describe('waitForRenameDone', () => {
  it('全部原始链接消失（被改名）→ ok，renamedCount=N，remainingOriginal=0', async () => {
    const originalLinks = [
      '![[笔记同步助手/images/a3f9c2.png]]',
      '![[笔记同步助手/images/b7c1.png]]',
    ]
    // 一次轮询就已改名完成
    const app = makeApp([
      '![[笔记同步助手/images/note.png]]\n![[笔记同步助手/images/note-1.png]]',
    ])
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 10_000,
      originalLinks,
      pollMs: 0,
      now: fastClock(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(true)
    expect(r.renamedCount).toBe(2)
    expect(r.remainingOriginal).toBe(0)
  })

  it('无法改名的扩展名（svg）残留但内容稳定 → ok（best-effort），remainingOriginal=1', async () => {
    const originalLinks = [
      '![[笔记同步助手/images/a3f9c2.png]]',
      '![[笔记同步助手/images/c.svg]]',
    ]
    // png 已改名，svg 因不在 paste-image-rename 处理列表(jpe?g|png|gif|tiff|webp)里保持不变；
    // 内容之后恒定 → 触发「稳定收敛」兜底
    const stable = '![[笔记同步助手/images/note.png]]\n![[笔记同步助手/images/c.svg]]'
    const app = makeApp([stable, stable, stable, stable])
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 10_000,
      originalLinks,
      pollMs: 0,
      stableReads: 2,
      now: fastClock(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(true)
    expect(r.renamedCount).toBe(1)
    expect(r.remainingOriginal).toBe(1)
  })

  it('可改名扩展名(png)残留 + 内容稳定 → 稳定收敛也判 ok=false，不误报成功', async () => {
    // 回归 codex P2：命令慢/缓存没就绪/静默 no-op 时，png 原始链接一直在、内容也不变。
    // 稳定收敛后残留「本该能改名」的 png → 判 ok=false（如实上报未完成），绝不误报成功。
    const originalLinks = ['![[笔记同步助手/images/a3f9c2.png]]']
    const stuck = '未改名 ![[笔记同步助手/images/a3f9c2.png]]' // 恒定不变
    const app = makeApp([stuck, stuck, stuck, stuck, stuck, stuck])
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 100,
      originalLinks,
      pollMs: 0,
      stableReads: 2, // 即便内容稳定也不许判成功（png 本该能改名）
      now: (() => {
        let t = 0
        return () => (t += 40) // 3 次读后越过 100ms 超时
      })(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.remainingOriginal).toBe(1)
  })

  it('原始链接始终残留且内容不断变化 → 超时 ok=false（不误报完成）', async () => {
    const originalLinks = ['![[笔记同步助手/images/a3f9c2.png]]']
    // 每次读到的内容都不同（禁止稳定收敛），且原始链接一直在
    const changing = Array.from(
      { length: 50 },
      (_, i) => `变化${i} ![[笔记同步助手/images/a3f9c2.png]]`,
    )
    const app = makeApp(changing)
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 100,
      originalLinks,
      pollMs: 0,
      stableReads: 2,
      now: (() => {
        let t = 0
        return () => (t += 1000) // 每次读时间 +1s，必然超时
      })(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.remainingOriginal).toBe(1)
  })

  it('scoped 原始链接已消失但批量仍在改本文件其它图（内容持续变化）→ 不提前返回，等稳定', async () => {
    // 回归 codex P1-B：batch-rename-all-images 会改本文件里每一张 embed（含用户手插的非
    // scoped 图）。scoped 原始链接消失后批量可能仍在后台改其它图；若此时就返回会 detach
    // leaf / 触发下一条命令打架。必须等内容稳定收敛（批量停手）才返回。
    const originalLinks = ['![[笔记同步助手/images/a_MD5.png]]']
    const contents = [
      '已改scoped ![[图/x.png]] 批量改其它图1', // scoped 已消失，但内容仍在变
      '已改scoped ![[图/y.png]] 批量改其它图2',
      '已改scoped ![[图/z.png]] 收敛',
      '已改scoped ![[图/z.png]] 收敛', // 稳定 1
      '已改scoped ![[图/z.png]] 收敛', // 稳定 2 → 收敛
    ]
    const app = makeApp(contents)
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 10_000,
      originalLinks,
      pollMs: 0,
      stableReads: 2,
      now: fastClock(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(true)
    expect(r.remainingOriginal).toBe(0)
    // 关键：没有在第 1 次读（scoped 已归零）就返回，而是等到内容稳定（≥4 次读）
    expect((app.vault.cachedRead as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('originalLinks 为空 → 立即 ok（调用方兜底，不应误判）', async () => {
    const app = makeApp(['无关内容'])
    const r = await waitForRenameDone(app, file, {
      timeoutMs: 10_000,
      originalLinks: [],
      pollMs: 0,
      now: fastClock(),
      sleep: async () => undefined,
    })
    expect(r.ok).toBe(true)
    expect(r.renamedCount).toBe(0)
    expect(r.remainingOriginal).toBe(0)
  })
})
