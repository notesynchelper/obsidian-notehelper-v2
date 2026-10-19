import { MergeMode } from '../src/settings'
import { decideMergeIntro, shouldSuppressMergeIntroOnLoad } from '../src/sync/MergeIntro'

const base = {
  alreadyShown: false,
  debugActive: false,
  successCount: 3,
  mergeMode: MergeMode.MESSAGES,
  mergedPaths: ['Synced/同步助手_20261019.md'],
  manualSync: true,
}

describe('decideMergeIntro', () => {
  it('首次写入合并文件：提示并打开第一个合并文件', () => {
    expect(decideMergeIntro(base)).toEqual({
      notify: true,
      open: true,
      path: 'Synced/同步助手_20261019.md',
      activate: true,
    })
  })

  it('DUAL 同样触发', () => {
    expect(decideMergeIntro({ ...base, mergeMode: MergeMode.DUAL }).notify).toBe(true)
  })

  it('NONE / ALL 不触发', () => {
    expect(decideMergeIntro({ ...base, mergeMode: MergeMode.NONE }).notify).toBe(false)
    expect(decideMergeIntro({ ...base, mergeMode: MergeMode.ALL }).notify).toBe(false)
  })

  it('已提示过 / 调试模式 / 无成功 / 无合并文件：不触发', () => {
    expect(decideMergeIntro({ ...base, alreadyShown: true }).notify).toBe(false)
    expect(decideMergeIntro({ ...base, debugActive: true }).notify).toBe(false)
    expect(decideMergeIntro({ ...base, successCount: 0 }).notify).toBe(false)
    expect(decideMergeIntro({ ...base, mergedPaths: [] }).notify).toBe(false)
  })

  it('自动同步：照常提示并打开，但不抢焦点', () => {
    const d = decideMergeIntro({ ...base, manualSync: false })
    expect(d.notify).toBe(true)
    expect(d.open).toBe(true)
    expect(d.activate).toBe(false)
  })

  it('不触发时 path 为空', () => {
    expect(decideMergeIntro({ ...base, alreadyShown: true }).path).toBeUndefined()
  })
})

describe('shouldSuppressMergeIntroOnLoad', () => {
  it('有同步历史的老用户直接标记为已提示', () => {
    expect(shouldSuppressMergeIntroOnLoad({ alreadyShown: false, initialSyncCompleted: true, hasSyncHistory: false })).toBe(true)
    expect(shouldSuppressMergeIntroOnLoad({ alreadyShown: false, initialSyncCompleted: false, hasSyncHistory: true })).toBe(true)
  })
  it('新用户不抑制；已标记不必处理', () => {
    expect(shouldSuppressMergeIntroOnLoad({ alreadyShown: false, initialSyncCompleted: false, hasSyncHistory: false })).toBe(false)
    expect(shouldSuppressMergeIntroOnLoad({ alreadyShown: true, initialSyncCompleted: true, hasSyncHistory: true })).toBe(false)
  })
})
