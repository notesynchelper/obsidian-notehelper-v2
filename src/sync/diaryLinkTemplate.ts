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
 * - **换行原样保留**：空行完全由模板自己决定——模板第一行留空 = 这条前面空一行，
 *   末尾多留一个空行 = 这条后面空一行。只去掉最后一行尾部的空格 / 制表符。
 * - 模板语法错误会抛出，由调用方决定回落
 */
export function renderDiaryLinkTemplate(template: string, view: Record<string, unknown>): string {
	const mask = maskTemplaterTags(template)
	const rendered = mask.restore(Mustache.render(mask.text, view))
	return normalizeEntryTail(rendered)
}

/**
 * 尾部整理：去掉最后一个非空行末尾的空格 / 制表符，尾部只含空白的行归一成纯换行——
 * 换行的**个数**原样保留（那是用户表达「后面空几行」的方式）。
 */
export function normalizeEntryTail(entry: string): string {
	const m = /(?:[ \t]*\r?\n)*[ \t]*$/.exec(entry)
	if (!m) return entry
	const head = entry.slice(0, m.index).replace(/[ \t]+$/, '')
	const newlines = (m[0].match(/\n/g) || []).length
	return head + '\n'.repeat(newlines)
}

// ---------------------------------------------------------------------------
// 落盘规则：空行由模板自己决定，插件不额外补空行
//
// 把渲染结果当成「若干行文本」按文件模型写进日记：
//   - 每条链接从新的一行开始（落点前面不是行首就补一个换行）；
//   - 每条链接以**一个**换行结束（模板末尾没写换行就补一个；写了一个就是行尾；
//     多写的每一个换行都是一个空行——这就是「后面空一行」的写法）；
//   - 模板开头的空行原样保留——这就是「前面空一行」的写法；
//   - 落点在行首（顶部 / 底部 / 锚点升序）：后面的内容照旧接着，它开头的空行不动；
//     落点在某行末尾（锚点降序，紧贴开锚点的 `-->`）：先起一行，落点后那个换行改为
//     终结最后一条——与旧版单行前缀的逐字节行为一致。
// ---------------------------------------------------------------------------

/** 保证一条渲染结果以恰好一个「行尾」结束：没有换行就补一个；已有的换行（含多余的空行）原样保留 */
export function terminateEntry(entry: string): string {
	return entry.endsWith('\n') ? entry : `${entry}\n`
}

/**
 * 把 id 标记挂在渲染结果**最后一个非空行**的末尾——模板末尾的换行 / 空行留在标记后面，
 * 这样「后面空一行」不会被标记打断，单行模板则与旧版 `- [[…]] <!-- id -->` 同形。
 */
export function appendDiaryIdMarker(entry: string, marker: string): string {
	const m = /(?:\r?\n[ \t]*)*$/.exec(entry)
	const idx = m ? m.index : entry.length
	return `${entry.slice(0, idx)} ${marker}${entry.slice(idx)}`
}

/**
 * 把同批条目拼成要插进日记的那段文本。
 * @param entries 已渲染（已挂标记）的条目，按写入顺序
 * @param content 日记全文
 * @param at 落点偏移
 */
export function layoutDiaryLinkEntries(entries: string[], content: string, at: number): string {
	let joined = entries.map(terminateEntry).join('')
	const atLineStart = at === 0 || content[at - 1] === '\n'
	if (atLineStart) {
		// 落点在行首：条目都是完整的行，后面的内容照旧接着（它开头的空行是它自己的，不动）
		return joined
	}
	// 落点在某一行的中间 / 末尾（锚点降序：紧贴开锚点那行的 `-->` 之后）：先起一行；
	// 落点后面那个换行本来是这一行的行尾，现在改为终结最后一条条目，所以条目自己的行尾换行去掉
	if (content[at] === '\n' && joined.endsWith('\n')) joined = joined.slice(0, -1)
	return `\n${joined}`
}
