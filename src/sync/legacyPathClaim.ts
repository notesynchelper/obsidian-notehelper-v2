import { App, TFile, normalizePath } from 'obsidian'
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../util'

/**
 * 「升级前」那条旧路径：把同一份原文按【不换 # → ＃】的规则再清洗一遍。
 *
 * 3.2.11 起文件名/文件夹名里的半角 `#` 会被换成全角＃（wikilink 指不回带 # 的名字，
 * 点开只会新建一个空笔记）。升级后同一篇文章算出来的是新路径，不认旧文件的话：
 *   • 单篇：同一篇文章再建一份，用户库里凭空多出重复笔记；
 *   • 合并：当天的合并文件被劈成两半，旧那份从此不再追加。
 *
 * 🔴 必须从清洗【前】的原文重算，**绝不能**拿清洗后的路径「把所有全角＃换回半角」反推：
 * 标题里本来就带全角＃的文章根本没被清洗改动过，反推出来的是一条别人的路径；那个文件
 * 若没有 frontmatter id，会被 handleExistingFile 整份覆写（用户自己的 `C#入门.md`
 * 被一篇文章顶掉）。codex review P1，2026-09-03。
 *
 * 返回 undefined = 本次清洗没换过字符，没有旧文件可认领。
 */
export function legacyPathOf(
  rawFolder: string,
  rawFilename: string,
  currentPath: string,
): string | undefined {
  const legacyFolder = replaceIllegalCharsFolder(rawFolder, { keepLinkUnsafeChars: true })
  const legacyFilename = replaceIllegalCharsFile(rawFilename, { keepLinkUnsafeChars: true })
  const legacy = normalizePath(`${legacyFolder}/${legacyFilename}.md`)
  return legacy === currentPath ? undefined : legacy
}

/**
 * 旧路径上真有一个可认领的文件吗？
 *
 * 只做「存在 + 是文件 + 与新路径不同」这三件事；「该不该认领它」由调用方按自己的
 * 语义再把一道关（合并路径还要确认它不是一篇独立笔记，见 main.ts）。
 */
export function findLegacyClaimFile(
  app: App,
  currentPath: string,
  legacyPath?: string,
): TFile | null {
  if (!legacyPath || legacyPath === currentPath) return null
  const file = app.vault.getAbstractFileByPath(legacyPath)
  return file instanceof TFile ? file : null
}
