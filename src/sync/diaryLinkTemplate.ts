import { Item } from '@omnivore-app/api'
import Mustache from 'mustache'
import { DEFAULT_DIARY_LINK_TEMPLATE } from '../settings'
import { buildDateView, functionMap } from '../settings/template'
import { maskTemplaterTags } from './templaterRelay'

/**
 * 日记链接模板的渲染底座（纯函数，DiaryLinkProcessor 与设置页预览共用）。
 *
 * 一条日记链接 = 模板按下面的 view 渲染出来的文本；旧版「双链前缀」被
 * `${前缀}{{{link}}}` 这个模板完全覆盖（见 settings/index.ts 的迁移）。
 */

/** 组装 view 需要的原料：链接本体 + 它来自哪条 item */
export interface DiaryLinkViewSource {
	item: Item
	/** 完整 wikilink：`[[目标#锚点|显示文字]]` / `[[目标|显示文字]]` */
	link: string
	/** 截断 + 清洗后的显示文字（即 `|` 后面那段） */
	title: string
	/** 目标文件名（不含路径 / 扩展名） */
	target: string
	/** 消息在合并文件里的锚点标题；文章为空串 */
	anchor: string
	/** 消息摘要；文章为空串 */
	heading: string
	isMessage: boolean
	/** settings.dateSavedFormat，决定 dateSaved 的样子 */
	dateSavedFormat: string
}

/**
 * 模板 view：
 *   link / title / target / anchor / heading / isMessage / savedAt
 *   + buildDateView（dateSaved / date / timeSaved / timeSavedShort / yearSaved…）
 *   + 文章模板同一套内置函数（formatDate / upperCase / lowerCase / upperCaseFirst / mapValue / extract）
 */
export function buildDiaryLinkView(src: DiaryLinkViewSource): Record<string, unknown> {
	return {
		...functionMap,
		...buildDateView(src.item, src.dateSavedFormat),
		link: src.link,
		title: src.title,
		target: src.target,
		anchor: src.anchor,
		heading: src.heading,
		isMessage: src.isMessage,
		savedAt: src.item.savedAt,
	}
}

/** 设置里存的模板为空 / 全是空白 → 按默认模板 */
export function resolveDiaryLinkTemplate(raw: string | undefined | null): string {
	return raw && raw.trim() ? raw : DEFAULT_DIARY_LINK_TEMPLATE
}

/**
 * 渲染一条日记链接。
 * - Templater 标签 `<% %>` 先掩码再还原（与文章 / 消息模板一致，原样保留给 Templater）
 * - 去掉尾部空白（模板末尾多打的换行不会在日记里留出空行）；开头的空行保留——
 *   那是用户故意写的
 * - 模板语法错误会抛出，由调用方决定回落
 */
export function renderDiaryLinkTemplate(template: string, view: Record<string, unknown>): string {
	const mask = maskTemplaterTags(template)
	const rendered = mask.restore(Mustache.render(mask.text, view))
	return rendered.replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// 块间距：多行模板写进日记时的空行规则
//
// 单行模板（去掉尾部空白后不含换行）沿用旧版拼法：同批 `\n` 相连成列表，前后只按需
// 补一个 `\n`。多行模板才进「块模式」：同批条目之间空一行，整块与前后既有内容之间
// 至少一个空行——按拼接处**实际已有**的换行数补差，用户模板自带的开头空行、
// 文件里本来就有的空行都算数，不会叠成两个空行。
// ---------------------------------------------------------------------------

/** 多行模板 = 去掉尾部空白后仍含换行（模板末尾多打的换行不算） */
export function isBlockTemplate(template: string): boolean {
	return template.replace(/\s+$/, '').includes('\n')
}

function countNewlines(s: string): number {
	return (s.match(/\n/g) || []).length
}

function trailingNewlines(s: string): number {
	const m = /(?:\r?\n)*$/.exec(s)
	return m ? countNewlines(m[0]) : 0
}

function leadingNewlines(s: string): number {
	const m = /^(?:\r?\n)*/.exec(s)
	return m ? countNewlines(m[0]) : 0
}

/**
 * left 与 right 拼接处要补多少换行，才能让两边的最后 / 第一个非空行之间恰好隔出一个空行。
 * 任一侧为空串 → 不补（文件开头 / 文件末尾没有「前后内容」可言）。
 */
export function blankLineGap(left: string, right: string): string {
	if (!left || !right) return ''
	const have = trailingNewlines(left) + leadingNewlines(right)
	return have >= 2 ? '' : '\n'.repeat(2 - have)
}

/** 块模式下把同批条目拼起来：条目之间恰好一个空行 */
export function joinLinkBlocks(entries: string[]): string {
	return entries.reduce((acc, entry) => acc + blankLineGap(acc, entry) + entry, '')
}
