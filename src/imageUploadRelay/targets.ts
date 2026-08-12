/**
 * 图床接力目标白名单
 *
 * 把 ImageUploadRelay 枚举映射到「需要调用的第三方插件 id + 命令 id + 必要设置字段」。
 * commandId 直接复制自调研文档 2026-04-17-image-upload-plugin-integration-research.md
 * 的表格，已和各插件源码核对。若第三方插件后续版本改命令 id，集中在此文件调整即可。
 */
import { ImageUploadRelay } from '../settings'

/**
 * 接力目标的类别，决定「完成判据」：
 *  - `upload`：把本地 `![[...]]` 传成远端 `![](https://...)`，完成 = 本地 wiki 链接归零。
 *  - `rename`：只把图片文件改名（如 Paste image rename），链接**仍是本地 wiki**、
 *    永不归零，完成 = 触发前记录的那批原始链接是否都消失（见 waitForRenameDone）。
 */
export type RelayTargetKind = 'upload' | 'rename'

export interface RelayTarget {
  /** 目标类别，决定运行器用哪套完成判据；缺省视为 'upload' */
  kind: RelayTargetKind
  /** 第三方插件 manifest id（`app.plugins.plugins[id]`） */
  pluginId: string
  /** Obsidian 命令注册 id（`app.commands.executeCommandById(id)`） */
  commandId: string
  /** 设置 UI 里展示给用户的名字 */
  displayName: string
  /**
   * 若该插件默认不原地改写原文件，必须用户手动打开的设置字段名；
   * null 表示插件天然原地改写，无需检测该字段。
   */
  replaceOriginalBySetting: string | null
  /**
   * 是否依赖 Obsidian 核心设置「自动更新内部链接」（`alwaysUpdateLinks`）。
   *
   * 改名类插件（Paste image rename 的 batch 路径）改文件名后**不手动改写编辑器链接**，
   * 完全依赖 Obsidian 核心的自动更新内部链接来把笔记里的 `![[旧名]]` 改成 `![[新名]]`。
   * 若用户关了这个核心开关，改名会**留下断链**（图片挂掉）。故开启改名接力前必须校验它。
   */
  requiresAlwaysUpdateLinks?: boolean
  /** 给用户的安装引导链接（status=❌ 时展示） */
  homepage: string
}

export const RELAY_TARGETS: Record<Exclude<ImageUploadRelay, ImageUploadRelay.NONE>, RelayTarget> = {
  [ImageUploadRelay.IAUP]: {
    kind: 'upload',
    pluginId: 'obsidian-image-auto-upload-plugin',
    commandId: 'obsidian-image-auto-upload-plugin:Upload all images',
    displayName: 'Image auto upload (PicGo/PicList)',
    replaceOriginalBySetting: null,
    homepage: 'https://github.com/renmu123/obsidian-image-auto-upload-plugin',
  },
  [ImageUploadRelay.IUTK]: {
    kind: 'upload',
    pluginId: 'image-upload-toolkit',
    commandId: 'image-upload-toolkit:publish-page',
    displayName: 'Image Upload Toolkit',
    replaceOriginalBySetting: 'replaceOriginalDoc',
    homepage: 'https://github.com/addozhang/obsidian-image-upload-toolkit',
  },
  [ImageUploadRelay.CIUP]: {
    kind: 'upload',
    pluginId: 'obsidian-image-uploader',
    commandId: 'obsidian-image-uploader:upload-all-local-images',
    displayName: 'Obsidian Image Uploader (Creling)',
    replaceOriginalBySetting: null,
    homepage: 'https://github.com/Creling/obsidian-image-uploader',
  },
} as const

/**
 * 改名接力目标：Paste image rename（reorx/obsidian-paste-image-rename）
 *
 * 与上面三个上传目标**不同类**（kind='rename'）：它不上传图床，只把本地化落下的
 * `![[.../a3f9c2.png]]`（md5 哈希名）批量改成 `![[.../<笔记标题>.png]]`，链接仍是
 * 本地 wiki。命令逐字对应插件源码 `src/main.ts:118-121` 的
 * `batch-rename-all-images`（「instant」非交互版）；另一个
 * `batch-rename-embeded-files` 会弹交互 Modal，**不能**自动触发，故不用。
 *
 * 该插件 `isDesktopOnly:false`（支持移动端），但本插件的接力 leaf 机制目前仍只在
 * 桌面端启用（与上传接力一致），故实际调度仍受 !isMobile 门控。
 */
export const PASTE_IMAGE_RENAME_TARGET: RelayTarget = {
  kind: 'rename',
  pluginId: 'obsidian-paste-image-rename',
  commandId: 'obsidian-paste-image-rename:batch-rename-all-images',
  displayName: 'Paste image rename',
  replaceOriginalBySetting: null,
  // batch 路径改名后不手动改写链接，靠 Obsidian「自动更新内部链接」兜；关了会断链，必须校验
  requiresAlwaysUpdateLinks: true,
  homepage: 'https://github.com/reorx/obsidian-paste-image-rename',
}

/** 判断枚举值是否对应一个真实的接力目标（把 NONE 排除） */
export function isRelayActive(mode: ImageUploadRelay): mode is Exclude<ImageUploadRelay, ImageUploadRelay.NONE> {
  return mode !== ImageUploadRelay.NONE
}

/** 读取目标，NONE 返回 null */
export function getRelayTarget(mode: ImageUploadRelay): RelayTarget | null {
  return isRelayActive(mode) ? RELAY_TARGETS[mode] : null
}
