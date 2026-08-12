/**
 * RELAY_TARGETS 白名单一致性测试
 *
 * 用途：防止未来有人误改 commandId / pluginId —— 这些值是从调研文档
 *   docs/plans/2026-04-17-image-upload-plugin-integration-research.md
 * 里逐字抠出来的，和第三方插件源码一一对应，错一个字符就会让整个 relay 静默失败。
 */
import { ImageUploadRelay } from '../../src/settings'
import {
  RELAY_TARGETS,
  PASTE_IMAGE_RENAME_TARGET,
  getRelayTarget,
  isRelayActive,
} from '../../src/imageUploadRelay/targets'

describe('RELAY_TARGETS 白名单', () => {
  it('三个候选插件的 commandId 与调研文档匹配', () => {
    expect(RELAY_TARGETS[ImageUploadRelay.IAUP].commandId).toBe(
      'obsidian-image-auto-upload-plugin:Upload all images',
    )
    expect(RELAY_TARGETS[ImageUploadRelay.IUTK].commandId).toBe(
      'image-upload-toolkit:publish-page',
    )
    expect(RELAY_TARGETS[ImageUploadRelay.CIUP].commandId).toBe(
      'obsidian-image-uploader:upload-all-local-images',
    )
  })

  it('pluginId 与 manifest id 匹配', () => {
    expect(RELAY_TARGETS[ImageUploadRelay.IAUP].pluginId).toBe(
      'obsidian-image-auto-upload-plugin',
    )
    expect(RELAY_TARGETS[ImageUploadRelay.IUTK].pluginId).toBe('image-upload-toolkit')
    expect(RELAY_TARGETS[ImageUploadRelay.CIUP].pluginId).toBe('obsidian-image-uploader')
  })

  it('只有 IUTK 需要 replaceOriginalDoc 设置检测，其他两个为 null', () => {
    expect(RELAY_TARGETS[ImageUploadRelay.IAUP].replaceOriginalBySetting).toBeNull()
    expect(RELAY_TARGETS[ImageUploadRelay.IUTK].replaceOriginalBySetting).toBe(
      'replaceOriginalDoc',
    )
    expect(RELAY_TARGETS[ImageUploadRelay.CIUP].replaceOriginalBySetting).toBeNull()
  })

  it('每个目标都有 displayName 和 homepage', () => {
    for (const target of Object.values(RELAY_TARGETS)) {
      expect(target.displayName.length).toBeGreaterThan(0)
      expect(target.homepage).toMatch(/^https:\/\/github\.com\//)
    }
  })

  it('三个上传目标的 kind 都是 upload', () => {
    expect(RELAY_TARGETS[ImageUploadRelay.IAUP].kind).toBe('upload')
    expect(RELAY_TARGETS[ImageUploadRelay.IUTK].kind).toBe('upload')
    expect(RELAY_TARGETS[ImageUploadRelay.CIUP].kind).toBe('upload')
  })
})

describe('PASTE_IMAGE_RENAME_TARGET（改名接力）', () => {
  it('kind=rename，指向 Paste image rename 的「instant」批量命令', () => {
    // ⚠️ commandId 逐字对应插件源码 src/main.ts:118-121
    // （batch-rename-embeded-files 是交互式 modal，不可自动触发，必须用 all-images）
    expect(PASTE_IMAGE_RENAME_TARGET.kind).toBe('rename')
    expect(PASTE_IMAGE_RENAME_TARGET.pluginId).toBe('obsidian-paste-image-rename')
    expect(PASTE_IMAGE_RENAME_TARGET.commandId).toBe(
      'obsidian-paste-image-rename:batch-rename-all-images',
    )
  })

  it('改名插件天然原地改写 + 有引导链接，无需 replaceOriginal 检测', () => {
    expect(PASTE_IMAGE_RENAME_TARGET.replaceOriginalBySetting).toBeNull()
    expect(PASTE_IMAGE_RENAME_TARGET.displayName.length).toBeGreaterThan(0)
    expect(PASTE_IMAGE_RENAME_TARGET.homepage).toMatch(/^https:\/\/github\.com\//)
  })

  it('依赖 Obsidian「自动更新内部链接」核心开关（改名后靠它更新 wiki 链接）', () => {
    expect(PASTE_IMAGE_RENAME_TARGET.requiresAlwaysUpdateLinks).toBe(true)
    // 上传目标不依赖该开关（它们自己改写链接）
    expect(RELAY_TARGETS[ImageUploadRelay.IAUP].requiresAlwaysUpdateLinks).toBeUndefined()
  })
})

describe('getRelayTarget / isRelayActive', () => {
  it('NONE 模式返回 null / 非 active', () => {
    expect(getRelayTarget(ImageUploadRelay.NONE)).toBeNull()
    expect(isRelayActive(ImageUploadRelay.NONE)).toBe(false)
  })

  it('其他模式返回对应目标', () => {
    expect(getRelayTarget(ImageUploadRelay.IAUP)).toBe(RELAY_TARGETS[ImageUploadRelay.IAUP])
    expect(getRelayTarget(ImageUploadRelay.IUTK)).toBe(RELAY_TARGETS[ImageUploadRelay.IUTK])
    expect(getRelayTarget(ImageUploadRelay.CIUP)).toBe(RELAY_TARGETS[ImageUploadRelay.CIUP])
    expect(isRelayActive(ImageUploadRelay.IAUP)).toBe(true)
  })
})
