import { MergeMode } from '../src/settings'
import { normalizeSingleFileNameInput, presetWarningKey } from '../src/settings/presets'
import zh from '../src/i18n/zh'
import en from '../src/i18n/en'

describe('消息每条单独一篇预设的提示', () => {
  it('从按天合并或双写切到不合并时提示不再生成合并文件', () => {
    expect(presetWarningKey(MergeMode.DUAL, MergeMode.NONE)).toBe('presets.dailyFilesStop')
    expect(presetWarningKey(MergeMode.MESSAGES, MergeMode.NONE)).toBe('presets.dailyFilesStop')
  })
  it('从全部合并提示文章不再合并；未改变模式时不提示', () => {
    expect(presetWarningKey(MergeMode.ALL, MergeMode.NONE)).toBe('presets.articlesUnmerged')
    expect(presetWarningKey(MergeMode.NONE, MergeMode.NONE)).toBeNull()
    expect(presetWarningKey(MergeMode.DUAL, undefined)).toBeNull()
  })
  it('中英文均说明合并文件的变化', () => {
    expect(zh.presets.dailyFilesStop).toContain('不再生成每天的合并文件')
    expect(en.presets.dailyFilesStop).toContain('Daily merged files will no longer')
  })
})

describe('合并文件名清空', () => {
  it('清空存为只含日期的模板，非空原样保留', () => {
    expect(normalizeSingleFileNameInput('')).toBe('{{{date}}}')
    expect(normalizeSingleFileNameInput('企微_{{{date}}}')).toBe('企微_{{{date}}}')
  })
})
