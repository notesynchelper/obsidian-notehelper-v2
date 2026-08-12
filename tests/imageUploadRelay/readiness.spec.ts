/**
 * checkRelayReady 覆盖 5 个 reason 分支
 */
import type { App } from 'obsidian'
import { ImageUploadRelay } from '../../src/settings'
import { RELAY_TARGETS, PASTE_IMAGE_RENAME_TARGET } from '../../src/imageUploadRelay/targets'
import {
  checkRelayReady,
  describeRelayReason,
} from '../../src/imageUploadRelay/readiness'

type InternalApp = {
  plugins: {
    enabledPlugins: Set<string>
    plugins: Record<string, { settings?: Record<string, unknown> } | undefined>
  }
  commands: {
    commands: Record<string, unknown>
  }
  vault?: { getConfig?: (key: string) => unknown }
}

function makeApp(overrides: Partial<InternalApp> = {}): App {
  const base: InternalApp = {
    plugins: {
      enabledPlugins: new Set(),
      plugins: {},
    },
    commands: {
      commands: {},
    },
  }
  return { ...base, ...overrides } as unknown as App
}

describe('checkRelayReady', () => {
  const iaup = RELAY_TARGETS[ImageUploadRelay.IAUP]
  const iutk = RELAY_TARGETS[ImageUploadRelay.IUTK]

  it('plugin_disabled：enabledPlugins 里没有对应 id', () => {
    const app = makeApp()
    expect(checkRelayReady(app, iaup)).toEqual({ ok: false, reason: 'plugin_disabled' })
  })

  it('plugin_not_loaded：enabled 但 instance 未挂载', () => {
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iaup.pluginId]),
        plugins: {}, // 缺 instance
      },
    })
    expect(checkRelayReady(app, iaup)).toEqual({ ok: false, reason: 'plugin_not_loaded' })
  })

  it('command_missing：plugin 在但命令未注册', () => {
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iaup.pluginId]),
        plugins: { [iaup.pluginId]: {} },
      },
      commands: { commands: {} },
    })
    expect(checkRelayReady(app, iaup)).toEqual({ ok: false, reason: 'command_missing' })
  })

  it('replace_original_off：iutk 的 replaceOriginalDoc=false', () => {
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iutk.pluginId]),
        plugins: {
          [iutk.pluginId]: { settings: { replaceOriginalDoc: false } },
        },
      },
      commands: { commands: { [iutk.commandId]: {} } },
    })
    expect(checkRelayReady(app, iutk)).toEqual({
      ok: false,
      reason: 'replace_original_off',
    })
  })

  it('ok：iutk 的 replaceOriginalDoc=true 时通过', () => {
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iutk.pluginId]),
        plugins: {
          [iutk.pluginId]: { settings: { replaceOriginalDoc: true } },
        },
      },
      commands: { commands: { [iutk.commandId]: {} } },
    })
    expect(checkRelayReady(app, iutk)).toEqual({ ok: true })
  })

  it('ok：iaup 不做 replaceOriginal 检测（字段为 null），只要插件/命令齐全就通过', () => {
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iaup.pluginId]),
        plugins: { [iaup.pluginId]: {} }, // 没 settings 也不影响
      },
      commands: { commands: { [iaup.commandId]: {} } },
    })
    expect(checkRelayReady(app, iaup)).toEqual({ ok: true })
  })

  it('iutk 没 settings 对象时不视为 replace_original_off（宽容）', () => {
    // 现实里第三方插件可能还没 load 完 settings，此时不应误判
    const app = makeApp({
      plugins: {
        enabledPlugins: new Set([iutk.pluginId]),
        plugins: { [iutk.pluginId]: {} }, // settings 未定义
      },
      commands: { commands: { [iutk.commandId]: {} } },
    })
    expect(checkRelayReady(app, iutk)).toEqual({ ok: true })
  })
})

describe('checkRelayReady — 改名接力依赖「自动更新内部链接」', () => {
  const rename = PASTE_IMAGE_RENAME_TARGET
  const withPluginAndCommand = (vault?: { getConfig?: (key: string) => unknown }) =>
    makeApp({
      plugins: {
        enabledPlugins: new Set([rename.pluginId]),
        plugins: { [rename.pluginId]: {} },
      },
      commands: { commands: { [rename.commandId]: {} } },
      vault,
    })

  it('alwaysUpdateLinks=false → auto_update_links_off（改名会断链，拦下）', () => {
    const app = withPluginAndCommand({ getConfig: (k) => (k === 'alwaysUpdateLinks' ? false : undefined) })
    expect(checkRelayReady(app, rename)).toEqual({ ok: false, reason: 'auto_update_links_off' })
  })

  it('alwaysUpdateLinks=true → 通过', () => {
    const app = withPluginAndCommand({ getConfig: () => true })
    expect(checkRelayReady(app, rename)).toEqual({ ok: true })
  })

  it('读不到 getConfig（老版本/测试环境）→ 宽容放行', () => {
    const app = withPluginAndCommand(undefined)
    expect(checkRelayReady(app, rename)).toEqual({ ok: true })
  })
})

describe('describeRelayReason', () => {
  const iaup = RELAY_TARGETS[ImageUploadRelay.IAUP]

  it('每个 reason 都能得到一段中文描述', () => {
    for (const reason of [
      'plugin_disabled',
      'plugin_not_loaded',
      'command_missing',
      'replace_original_off',
      'auto_update_links_off',
    ] as const) {
      const msg = describeRelayReason(iaup, reason)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
    }
  })
})
