/**
 * 图床接力前置检测
 *
 * 在「打开设置 UI」和「每次真正触发 relay 前」都跑一次，
 * 避免插件被禁用 / 命令漂移 / 关键设置未开导致用户 sync 时才看到失败。
 */
import { App } from 'obsidian'
import { RelayTarget } from './targets'

export type RelayReadyReason =
  | 'plugin_disabled'         // 插件未启用（或未安装）
  | 'plugin_not_loaded'       // 启用但实例未 ready
  | 'command_missing'         // 命令 id 在当前 Obsidian 里查不到（插件版本漂移）
  | 'replace_original_off'    // 目标插件设置里「原地改写」开关没打开
  | 'auto_update_links_off'   // Obsidian 核心「自动更新内部链接」被关（改名会断链）

export interface RelayReadyResult {
  ok: boolean
  reason?: RelayReadyReason
}

/**
 * 不能对 Obsidian 的内部 plugins/commands API 做强类型约束
 * （官方 d.ts 没暴露），这里集中用一层私有接口来屏蔽 `any`。
 */
interface InternalPluginRegistry {
  enabledPlugins?: Set<string>
  plugins?: Record<string, { settings?: Record<string, unknown> } | undefined>
}
interface InternalCommandRegistry {
  commands?: Record<string, unknown>
}
interface InternalVaultConfig {
  getConfig?: (key: string) => unknown
}

/**
 * 判断第三方插件是否处于可接力状态
 *
 * 返回值故意区分多个 reason，由调用方（settingsTab 状态角标 / 运行时 Notice）
 * 各自给出具体文案。
 */
export function checkRelayReady(app: App, target: RelayTarget): RelayReadyResult {
  const plugins = (app as unknown as { plugins?: InternalPluginRegistry }).plugins
  if (!plugins?.enabledPlugins?.has(target.pluginId)) {
    return { ok: false, reason: 'plugin_disabled' }
  }
  const instance = plugins.plugins?.[target.pluginId]
  if (!instance) {
    return { ok: false, reason: 'plugin_not_loaded' }
  }

  const commands = (app as unknown as { commands?: InternalCommandRegistry }).commands
  if (!commands?.commands?.[target.commandId]) {
    return { ok: false, reason: 'command_missing' }
  }

  if (target.replaceOriginalBySetting) {
    const settings = instance.settings
    if (settings && settings[target.replaceOriginalBySetting] === false) {
      return { ok: false, reason: 'replace_original_off' }
    }
  }

  if (target.requiresAlwaysUpdateLinks) {
    // Obsidian 核心「自动更新内部链接」默认开启；只有当明确读到 false 才拦（读不到 API
    // 时宽容放行，避免老版本 / 测试环境误拦）。改名类插件靠它把 `![[旧名]]` 更新到新名。
    const vault = (app as unknown as { vault?: InternalVaultConfig }).vault
    const alwaysUpdate = vault?.getConfig?.('alwaysUpdateLinks')
    if (alwaysUpdate === false) {
      return { ok: false, reason: 'auto_update_links_off' }
    }
  }

  return { ok: true }
}

/** 把 reason 翻译成用户可读中文，供 Notice / 状态角标复用 */
export function describeRelayReason(target: RelayTarget, reason: RelayReadyReason): string {
  switch (reason) {
    case 'plugin_disabled':
      return `未启用「${target.displayName}」插件`
    case 'plugin_not_loaded':
      return `「${target.displayName}」已启用但尚未加载完成`
    case 'command_missing':
      return `「${target.displayName}」的命令 ${target.commandId} 不存在，可能版本不兼容`
    case 'replace_original_off':
      return `请到「${target.displayName}」设置里打开 Replace original document，否则结果只会进剪贴板`
    case 'auto_update_links_off':
      return `请打开 Obsidian 设置 →「文件与链接」→「自动更新内部链接」，否则「${target.displayName}」改名后会留下断链`
  }
}
