/**
 * RelayRunner.runOn 单测
 *
 * 不依赖真实 Obsidian，构造最小 App/vault/plugins/commands/workspace mock，
 * 用可控的内容演进序列和 executeCommandById spy 来驱动。
 */
import type { App, TFile, WorkspaceLeaf } from 'obsidian'
import { ImageUploadRelay } from '../../src/settings'
import { RELAY_TARGETS, PASTE_IMAGE_RENAME_TARGET } from '../../src/imageUploadRelay/targets'
import { RelayRunner } from '../../src/imageUploadRelay/relayRunner'

interface FileState {
  path: string
  /** 序列式内容：每次 cachedRead 取下一项，到末尾后保持最后一项 */
  contents: string[]
  readIdx: number
}

function makeFile(path: string, contents: string[]): { file: TFile; state: FileState } {
  const state: FileState = { path, contents, readIdx: 0 }
  const file = { path, basename: path.replace(/\.md$/, '') } as unknown as TFile
  return { file, state }
}

interface MockAppOptions {
  enabledTarget?: ImageUploadRelay
  /** 每当 executeCommandById 被调用时执行的副作用（通常用来推进文件内容） */
  onExecuteCommand?: (commandId: string) => void
  /** executeCommandById 是否返回 true */
  executeCommandReturns?: boolean
  /** iutk 的 replaceOriginalDoc；默认 true（只有当 target=IUTK 时用到） */
  iutkReplaceOriginalDoc?: boolean
  /** 模拟 getMostRecentLeaf / setActiveLeaf */
  recordLeafActivity?: { setActiveCalled?: boolean }
  /** openFile 是否 throw */
  openFileThrows?: boolean
  /** preflight 时禁用 target（用于 preflight fail 场景） */
  noPlugin?: boolean
  /** 注册改名接力目标（Paste image rename）而非上传目标 */
  renameTarget?: boolean
}

function makeApp(states: FileState[], opts: MockAppOptions = {}): App {
  const target = opts.renameTarget
    ? PASTE_IMAGE_RENAME_TARGET
    : opts.enabledTarget !== undefined
      ? RELAY_TARGETS[opts.enabledTarget as Exclude<ImageUploadRelay, ImageUploadRelay.NONE>]
      : undefined

  const enabled = new Set<string>()
  const pluginInstance: Record<string, unknown> = {}
  const commands: Record<string, unknown> = {}

  if (target && !opts.noPlugin) {
    enabled.add(target.pluginId)
    pluginInstance[target.pluginId] = {
      settings:
        target.replaceOriginalBySetting === null
          ? undefined
          : { [target.replaceOriginalBySetting]: opts.iutkReplaceOriginalDoc !== false },
    }
    commands[target.commandId] = {}
  }

  const leafDetach = jest.fn()
  const leaf = {
    openFile: jest.fn(async () => {
      if (opts.openFileThrows) throw new Error('openFile failed')
    }),
    detach: leafDetach,
  } as unknown as WorkspaceLeaf

  const app = {
    vault: {
      cachedRead: jest.fn(async (file: TFile) => {
        const state = states.find((s) => s.path === file.path)
        if (!state) throw new Error(`unknown file ${file.path}`)
        const content = state.contents[Math.min(state.readIdx, state.contents.length - 1)]
        state.readIdx += 1
        return content
      }),
      getAbstractFileByPath: jest.fn((path: string) =>
        states.some((s) => s.path === path) ? ({} as unknown) : null,
      ),
    },
    plugins: {
      enabledPlugins: enabled,
      plugins: pluginInstance,
    },
    commands: {
      commands,
      executeCommandById: jest.fn((id: string) => {
        opts.onExecuteCommand?.(id)
        return opts.executeCommandReturns ?? true
      }),
    },
    workspace: {
      // getLeaf('tab') 与 getLeaf(true) 都返回同一个专用 relay leaf
      getLeaf: jest.fn(() => leaf),
      getMostRecentLeaf: jest.fn(() => leaf),
      setActiveLeaf: jest.fn(() => {
        if (opts.recordLeafActivity) opts.recordLeafActivity.setActiveCalled = true
      }),
    },
    isMobile: false,
  } as unknown as App

  // 暴露 detach spy 给测试断言
  ;(app as unknown as { __relayLeafDetach: jest.Mock }).__relayLeafDetach = leafDetach

  return app
}

// 默认 imageAttachmentFolder：与 DEFAULT_SETTINGS 保持一致（纯静态路径）
const DEFAULT_FOLDER = '笔记同步助手/images'

const fastRunnerOpts = {
  imageAttachmentFolder: DEFAULT_FOLDER,
  // 0 延迟 + 伪时钟，轮询不会真睡
  pollMs: 0,
  now: (() => {
    let t = 0
    return () => (t += 10)
  })(),
  sleep: async () => undefined,
}

describe('RelayRunner 构造', () => {
  it('传入 NONE 抛错', () => {
    const app = makeApp([])
    expect(() =>
      new RelayRunner(app, ImageUploadRelay.NONE, fastRunnerOpts),
    ).toThrow()
  })
})

describe('RelayRunner.runOn', () => {
  it('空文件列表 → total=0，不调用命令', async () => {
    const app = makeApp([], { enabledTarget: ImageUploadRelay.IAUP })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([])
    expect(summary.total).toBe(0)
    expect(summary.ok).toBe(0)
  })

  it('preflight 失败（插件未启用）→ 跳过所有文件，发 Notice', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const app = makeApp([{ path: 'a.md', contents: ['![[笔记同步助手/images/a.jpg]]'], readIdx: 0 }], {
      enabledTarget: ImageUploadRelay.IAUP,
      noPlugin: true, // 不注册 plugin
    })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([file])
    expect(summary.total).toBe(0)
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands.executeCommandById
    expect(exec).not.toHaveBeenCalled()
  })

  it('无本地图片的笔记被预过滤，不进入调度', async () => {
    const { file: f1 } = makeFile('nope.md', ['只有文字，没有图片'])
    const app = makeApp(
      [{ path: 'nope.md', contents: ['只有文字，没有图片'], readIdx: 0 }],
      { enabledTarget: ImageUploadRelay.IAUP },
    )
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([f1])
    expect(summary.total).toBe(0)
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands.executeCommandById
    expect(exec).not.toHaveBeenCalled()
  })

  it('只含用户手写本地图片（不在 imageAttachmentFolder 前缀下）→ 不调度，避免误上传', async () => {
    const { file: f1 } = makeFile('user-authored.md', [
      '![[assets/diagram.png]]\n![[my-vault/pic.jpg]]',
    ])
    const app = makeApp(
      [{
        path: 'user-authored.md',
        contents: ['![[assets/diagram.png]]\n![[my-vault/pic.jpg]]'],
        readIdx: 0,
      }],
      { enabledTarget: ImageUploadRelay.IAUP },
    )
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([f1])
    expect(summary.total).toBe(0)
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands.executeCommandById
    expect(exec).not.toHaveBeenCalled()
  })

  it('正常路径：触发命令后内容更新为 md → status=ok', async () => {
    const { file } = makeFile('a.md', [
      '![[笔记同步助手/images/a.jpg]]',
      '![[笔记同步助手/images/a.jpg]]',     // preflight check 再读一次
      '![[笔记同步助手/images/a.jpg]]',     // openFile 前读一次用来 countLocalImages
      '![](https://cdn/a.jpg)',// 第一次 waitForRelayDone 读
    ])
    const state = { path: 'a.md', contents: [
      '![[笔记同步助手/images/a.jpg]]',
      '![[笔记同步助手/images/a.jpg]]',
      '![[笔记同步助手/images/a.jpg]]',
      '![](https://cdn/a.jpg)',
    ], readIdx: 0 }

    const app = makeApp([state], {
      enabledTarget: ImageUploadRelay.IAUP,
    })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([file])

    expect(summary.total).toBe(1)
    expect(summary.ok).toBe(1)
    expect(summary.reports[0].status).toBe('ok')

    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands.executeCommandById
    expect(exec).toHaveBeenCalledWith(RELAY_TARGETS[ImageUploadRelay.IAUP].commandId)
  })

  it('executeCommandById 返回 false → status=command_failed，继续下一文件', async () => {
    const { file: f1 } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const { file: f2 } = makeFile('b.md', ['![[笔记同步助手/images/b.jpg]]'])
    // f2 通过：命令返回 true 后内容直接替换
    const s1 = { path: 'a.md', contents: ['![[笔记同步助手/images/a.jpg]]'], readIdx: 0 }
    const s2 = {
      path: 'b.md',
      contents: [
        '![[笔记同步助手/images/b.jpg]]',
        '![[笔记同步助手/images/b.jpg]]',
        '![[笔记同步助手/images/b.jpg]]',
        '![](https://cdn/b.jpg)',
      ],
      readIdx: 0,
    }

    // 第一次 executeCommandById 返 false；第二次返 true
    let callIdx = 0
    const app = makeApp([s1, s2], {
      enabledTarget: ImageUploadRelay.IAUP,
      executeCommandReturns: true, // 默认走下面的 jest.fn 覆盖
    })
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands.executeCommandById
    exec.mockImplementation(() => {
      callIdx += 1
      return callIdx !== 1
    })

    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([f1, f2])

    expect(summary.total).toBe(2)
    expect(summary.reports[0].status).toBe('command_failed')
    expect(summary.reports[1].status).toBe('ok')
    expect(summary.failed).toBe(1)
    expect(summary.ok).toBe(1)
  })

  it('超时：本地 wiki 永不消失 → status=timeout', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const s = {
      path: 'a.md',
      contents: ['![[笔记同步助手/images/a.jpg]]'], // 恒定不变
      readIdx: 0,
    }
    const app = makeApp([s], { enabledTarget: ImageUploadRelay.IAUP })

    // 用足够小的 timeoutMs 让 waitForRelayDone 必然超时
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, {
      imageAttachmentFolder: DEFAULT_FOLDER,
      pollMs: 0,
      now: (() => {
        let t = 0
        return () => (t += 1000) // 每次读时间 +1s
      })(),
      sleep: async () => undefined,
      computeTimeoutMs: () => 100, // 10 次 poll 后必然超时
    })
    const summary = await runner.runOn([file])
    expect(summary.reports[0].status).toBe('timeout')
    expect(summary.failed).toBe(1)
  })

  it('结束时 detach 专用 relay leaf，不去动用户的 leaf', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const s = {
      path: 'a.md',
      contents: [
        '![[笔记同步助手/images/a.jpg]]',
        '![[笔记同步助手/images/a.jpg]]',
        '![[笔记同步助手/images/a.jpg]]',
        '![](https://cdn/a.jpg)',
      ],
      readIdx: 0,
    }
    const app = makeApp([s], { enabledTarget: ImageUploadRelay.IAUP })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    await runner.runOn([file])

    const detach = (app as unknown as { __relayLeafDetach: jest.Mock }).__relayLeafDetach
    expect(detach).toHaveBeenCalledTimes(1)

    // setActiveLeaf 绝不应被调用：我们不再去动用户的 leaf
    const ws = (app as unknown as {
      workspace: { setActiveLeaf: jest.Mock }
    }).workspace
    expect(ws.setActiveLeaf).not.toHaveBeenCalled()
  })

  it('单文件抛错后也要 detach relay leaf（不留孤儿 tab）', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const s = {
      path: 'a.md',
      contents: ['![[笔记同步助手/images/a.jpg]]', '![[笔记同步助手/images/a.jpg]]'],
      readIdx: 0,
    }
    const app = makeApp([s], {
      enabledTarget: ImageUploadRelay.IAUP,
      openFileThrows: true,
    })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    await runner.runOn([file])
    const detach = (app as unknown as { __relayLeafDetach: jest.Mock }).__relayLeafDetach
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('onProgress / onPhaseStart / onPhaseDone 钩子被调用', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const s = {
      path: 'a.md',
      contents: [
        '![[笔记同步助手/images/a.jpg]]',
        '![[笔记同步助手/images/a.jpg]]',
        '![[笔记同步助手/images/a.jpg]]',
        '![](https://cdn/a.jpg)',
      ],
      readIdx: 0,
    }
    const app = makeApp([s], { enabledTarget: ImageUploadRelay.IAUP })

    const onPhaseStart = jest.fn()
    const onProgress = jest.fn()
    const onPhaseDone = jest.fn()
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    await runner.runOn([file], { onPhaseStart, onProgress, onPhaseDone })

    expect(onPhaseStart).toHaveBeenCalledWith(1)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
    expect(onPhaseDone).toHaveBeenCalledWith(true)
  })

  it('openFile 抛异常 → status=error，不影响下一文件', async () => {
    const { file } = makeFile('a.md', ['![[笔记同步助手/images/a.jpg]]'])
    const s = {
      path: 'a.md',
      contents: ['![[笔记同步助手/images/a.jpg]]', '![[笔记同步助手/images/a.jpg]]'],
      readIdx: 0,
    }
    const app = makeApp([s], {
      enabledTarget: ImageUploadRelay.IAUP,
      openFileThrows: true,
    })
    const runner = new RelayRunner(app, ImageUploadRelay.IAUP, fastRunnerOpts)
    const summary = await runner.runOn([file])
    expect(summary.reports[0].status).toBe('error')
    expect(summary.failed).toBe(1)
  })
})

describe('RelayRunner.runOn（改名接力 kind=rename）', () => {
  it('可用 RelayTarget 直接构造（而非 ImageUploadRelay 枚举）', () => {
    const app = makeApp([], { renameTarget: true })
    expect(() => new RelayRunner(app, PASTE_IMAGE_RENAME_TARGET, fastRunnerOpts)).not.toThrow()
  })

  it('正常路径：触发 batch-rename-all-images 后 _MD5 哈希名被改成标题名 → status=ok', async () => {
    // 本地化产物带 _MD5 标记（imageProcessor 的 `${hash}_MD5`）；改名后 _MD5 消失
    const s = {
      path: 'a.md',
      contents: [
        '![[笔记同步助手/images/a3f9c2_MD5.png]]', // 预过滤 hasLocalImages
        '![[笔记同步助手/images/a3f9c2_MD5.png]]', // initialContent → 记录新鲜原始链接
        '![[笔记同步助手/images/我的笔记.png]]', // 改名后：_MD5 原始链接消失（后续读稳定收敛）
      ],
      readIdx: 0,
    }
    const { file } = makeFile('a.md', s.contents)
    const app = makeApp([s], { renameTarget: true })
    const runner = new RelayRunner(app, PASTE_IMAGE_RENAME_TARGET, fastRunnerOpts)
    const summary = await runner.runOn([file])

    expect(summary.total).toBe(1)
    expect(summary.ok).toBe(1)
    expect(summary.reports[0].status).toBe('ok')

    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands
      .executeCommandById
    expect(exec).toHaveBeenCalledWith(PASTE_IMAGE_RENAME_TARGET.commandId)
  })

  it('已改名笔记（无 _MD5 标记）→ skipped，绝不重复触发命令（防命名抖动）', async () => {
    // 图片早已被改成标题名，不再带 _MD5；重复同步不应再触发 batch → 否则会 标题.png ↔ 标题-1.png 抖动
    const s = {
      path: 'a.md',
      contents: ['![[笔记同步助手/images/我的笔记.png]]'],
      readIdx: 0,
    }
    const { file } = makeFile('a.md', s.contents)
    const app = makeApp([s], { renameTarget: true })
    const runner = new RelayRunner(app, PASTE_IMAGE_RENAME_TARGET, fastRunnerOpts)
    const summary = await runner.runOn([file])
    expect(summary.reports[0]?.status).toBe('skipped')
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands
      .executeCommandById
    expect(exec).not.toHaveBeenCalled()
  })

  it('改名插件未启用 → preflight 跳过，不触发命令', async () => {
    const s = { path: 'a.md', contents: ['![[笔记同步助手/images/a3f9c2_MD5.png]]'], readIdx: 0 }
    const { file } = makeFile('a.md', s.contents)
    const app = makeApp([s], { renameTarget: true, noPlugin: true })
    const runner = new RelayRunner(app, PASTE_IMAGE_RENAME_TARGET, fastRunnerOpts)
    const summary = await runner.runOn([file])
    expect(summary.total).toBe(0)
    const exec = (app as unknown as { commands: { executeCommandById: jest.Mock } }).commands
      .executeCommandById
    expect(exec).not.toHaveBeenCalled()
  })

  it('改名后 _MD5 原始链接始终残留（内容持续变化）→ status=timeout', async () => {
    // 构造：原始链接一直在，内容每次读都变（禁止稳定收敛）→ 必然超时
    const changing = Array.from(
      { length: 40 },
      (_, i) => `变化${i} ![[笔记同步助手/images/a3f9c2_MD5.png]]`,
    )
    const s = {
      path: 'a.md',
      contents: [
        '![[笔记同步助手/images/a3f9c2_MD5.png]]', // 预过滤
        '![[笔记同步助手/images/a3f9c2_MD5.png]]', // initialContent
        ...changing,
      ],
      readIdx: 0,
    }
    const { file } = makeFile('a.md', s.contents)
    const app = makeApp([s], { renameTarget: true })
    const runner = new RelayRunner(app, PASTE_IMAGE_RENAME_TARGET, {
      imageAttachmentFolder: DEFAULT_FOLDER,
      pollMs: 0,
      renameStableReads: 999, // 禁止稳定收敛，逼出超时
      now: (() => {
        let t = 0
        return () => (t += 1000)
      })(),
      sleep: async () => undefined,
      computeTimeoutMs: () => 100,
    })
    const summary = await runner.runOn([file])
    expect(summary.reports[0].status).toBe('timeout')
    expect(summary.failed).toBe(1)
  })
})
