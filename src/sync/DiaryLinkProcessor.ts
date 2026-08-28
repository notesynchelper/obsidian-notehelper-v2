import { Item } from '@omnivore-app/api'
import { App, TFile } from 'obsidian'
import { truncateWithOmission } from '../util'
import {
  OmnivoreSettings,
  DiaryLinkType,
  DiaryWritePosition,
  DiaryLinkOrder,
  DEFAULT_DIARY_LINK_TEMPLATE,
} from '../settings'
import { DailyNoteResolver } from './DailyNoteResolver'
import { latestSyncCursor, isCursorCovered } from './cursorDedupe'
import { log, logError } from '../logger'
import { isWeChatMessage, generateMessageHeading, extractMessagePlainText } from '../settings/template'
import {
	buildDiaryLinkView,
	renderDiaryLinkTemplate,
	resolveDiaryLinkTemplate,
	appendDiaryIdMarker,
	layoutDiaryLinkEntries,
} from './diaryLinkTemplate'

/**
 * 区域内按 item.id 去重用的 HTML 注释标记。
 * 命名空间直接采用 manifest.json 的 plugin id，避免和第三方插件撞名。
 */
const DIARY_ID_MARKER_PREFIX = 'notehelper:id:'
const DIARY_ID_MARKER_REGEX = /<!-- notehelper:id:([^\s>]+) -->/g

/**
 * 表示待插入日记的链接项
 */
interface DiaryLinkItem {
	item: Item                    // 原始数据
	targetFile: string            // 目标文件名（不含路径和扩展名）
	targetPath?: string           // 目标文件完整 vault 路径（判自链接用；没给时退回比文件名）
	displayTitle: string          // 显示标题
	anchorHeading?: string        // 锚点标题（仅消息需要）
	heading: string               // 消息摘要（模板变量 heading；文章为空串）
	savedDateISO: string          // 保存日期ISO时间戳（用于分发到对应日记）
	isMessage: boolean            // 是否为企微消息
}

/**
 * 一次插入的落点方案：往哪儿插、去重要扫哪一段、前后各补什么换行。
 * 三种写入位置（锚点之间 / 文件顶部 / 文件底部）都归一成这个结构，
 * 后续的去重 + 拼接逻辑只有一份。
 */
interface InsertPlan {
	insertAt: number        // 插入偏移（content 上的下标）
	scopeStart: number      // 去重扫描范围起点
	scopeEnd: number        // 去重扫描范围终点
	order: DiaryLinkOrder   // 批次内排序方向
}

/**
 * 日记链接处理结果
 */
export interface DiaryLinkResult {
	success: number       // 成功插入的链接数
	skipped: number       // 跳过的链接数（日记不存在 / 无锚点 / 自链接）
	/**
	 * skipped 里有多少条是「自链接」（日记文件就是链接要指向的合并文件，正文已在里面）。
	 * 这是预期行为：通知层用它把这部分从 skipped 里扣掉，不弹提示、只记日志。
	 */
	selfLinkSkipped: number
	errors: string[]      // 错误信息列表
	// 详细的跳过原因统计
	skipReasons: {
		fileNotFound: string[]    // 日记文件不存在的日期列表
		anchorMissing: string[]   // 缺少锚点的日期列表
		createFailed: string[]    // 自动创建失败的日期列表
		selfLink: string[]        // 出现自链接跳过的日期列表（预期行为，不提示）
	}
}

/**
 * DiaryLinkProcessor - 日记链接处理器
 *
 * 职责：
 * - 收集同步过程中的文章/消息信息
 * - 按日期分组
 * - 同步完成后批量写入日记文件
 */
export class DiaryLinkProcessor {
	private links: DiaryLinkItem[] = []
	/** 本轮是否已经报过「模板渲染失败」——同一批几十条链接只报一次，不刷屏 */
	private templateFailureLogged = false

	constructor(
		private app: App,
		private settings: OmnivoreSettings,
		private resolver: DailyNoteResolver,
		/**
		 * 调试模式：旁路「日记不写 id」的游标去重。调试重拉的近 24h item 全落在
		 * 游标之前，不旁路会一条链接都补不进日记（与 MergeProcessor 同源理由）。
		 */
		private debugActive = false
	) {}

	/**
	 * 「日记不写 id」本轮是否生效。
	 * burn 优先：阅后即焚要按 id 精确识别，与另外两个「不写 id」开关一致地让位。
	 */
	private get noDiaryMarkers(): boolean {
		return (
			this.settings.disableDiaryLinkMarkers === true &&
			this.settings.burnAfterReading !== true
		)
	}

	/**
	 * 添加链接项（在文章/消息处理成功后调用）
	 */
	addLink(
		item: Item,
		targetFileName: string,
		anchorHeading?: string,
		/** 目标文件完整 vault 路径；与解析出的日记文件同路径 = 自链接，写入时跳过 */
		targetPath?: string,
	): void {
		if (!this.settings.enableDiaryLinks) return

		const isMessage = isWeChatMessage(item)

		// 根据链接类型过滤
		if (this.settings.diaryLinkType === DiaryLinkType.MESSAGES && !isMessage) return
		if (this.settings.diaryLinkType === DiaryLinkType.ARTICLES && isMessage) return

		// 「日记不写 id」：日记里没有标记可查，防重复改靠最新同步游标。
		// ⚠️ 必须在这里筛 —— MergeProcessor / FileProcessor 是对【全批】item 调
		// addLink 的（不走它们自己的游标过滤），已同步过的 item 照样会送进来。
		if (
			this.noDiaryMarkers &&
			!this.debugActive &&
			isCursorCovered(item.updatedAt || item.savedAt, latestSyncCursor(this.settings))
		) {
			return
		}

		// 消息摘要既是锚点的缺省值，也是模板变量 heading；文章没有摘要
		const heading = isMessage ? generateMessageHeading(item) : ''

		this.links.push({
			item,
			targetFile: targetFileName,
			targetPath,
			displayTitle: this.extractDisplayTitle(item),
			anchorHeading: isMessage ? (anchorHeading || heading) : undefined,
			heading,
			savedDateISO: item.savedAt,
			isMessage
		})
	}

	/**
	 * 提取显示标题
	 */
	private extractDisplayTitle(item: Item): string {
		if (isWeChatMessage(item)) {
			// 企微消息：使用清洗后的完整正文作为显示标题候选，
			// 由 buildBareLink 里的 diaryLinkMaxLength 统一决定是否截断。
			// 不在此处先行 slice，避免用户设置 > 10 时被预截拦截而"看起来没生效"。
			return extractMessagePlainText(item) || '消息'
		}
		return item.title
	}

	/**
	 * 构建锚点模式：如果用户输入已包含 <!-- --> 则直接使用，否则自动包装
	 */
	private buildAnchorPattern(anchor: string): string {
		const trimmed = anchor.trim()
		// 检查是否已经是 HTML 注释格式
		if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
			return trimmed
		}
		return `<!-- ${trimmed} -->`
	}

	/**
	 * 将文本里的 wikilink 语法字符替换成视觉近似的全角字符，
	 * 避免塞进 [[target|alias]] 的 alias 位置时把链接结构打散。
	 * 只处理 alias 位置真正敏感的三个：| 、]] 、[[。
	 */
	private sanitizeWikiLinkAlias(text: string): string {
		return text
			.replace(/\|/g, '\uff5c')         // | → ｜（全角竖线）
			.replace(/\]\]/g, '\uff3d\uff3d') // ]] → ］］（全角方括号）
			.replace(/\[\[/g, '\uff3b\uff3b') // [[ → ［［
	}

	/**
	 * 生成裸 wikilink（不含任何前缀 / 模板装饰）+ 截断清洗后的显示文字。
	 * 裸链接同时是「串匹配兜底去重」的比对单位：旧版前缀形态、无 id 模式、
	 * 换过模板的历史行，只要 [[…]] 这一段相同就算同一条。
	 */
	private buildBareLink(
		linkItem: DiaryLinkItem,
		diaryPath?: string,
	): { link: string; title: string; target: string } {
		const maxLen = this.settings.diaryLinkMaxLength

		let displayTitle = linkItem.displayTitle
		if (maxLen > 0) {
			displayTitle = truncateWithOmission(displayTitle, maxLen, '\u2026')
		}
		displayTitle = this.sanitizeWikiLinkAlias(displayTitle)

		const target = this.resolveLinkTarget(linkItem, diaryPath)
		const link = linkItem.isMessage && linkItem.anchorHeading
			? `[[${target}#${linkItem.anchorHeading}|${displayTitle}]]`
			: `[[${target}|${displayTitle}]]`
		return { link, title: displayTitle, target }
	}

	/**
	 * 链接目标写什么：让 Obsidian 自己给出「从这本日记出发能唯一定位到目标文件」的最短写法
	 * （`metadataCache.fileToLinktext`）。日记 `Daily Notes/2026-08-28.md` 与合并文件
	 * `journals/2026-08-28.md` 同名时，裸 `[[2026-08-28#锚点]]` 会被 Obsidian 解析成日记自己，
	 * 锚点再对也跳不到消息（真机 E2E 2026-08-28 抓到）；此时得写 `[[journals/2026-08-28#锚点]]`。
	 * 拿不到 targetPath / 文件 / API（单测 mock、极早期调用）→ 退回文件名，与旧版同形。
	 */
	private resolveLinkTarget(linkItem: DiaryLinkItem, diaryPath?: string): string {
		if (!linkItem.targetPath || diaryPath === undefined) return linkItem.targetFile
		try {
			const vault = this.app.vault as unknown as {
				getAbstractFileByPath?: (p: string) => unknown
			}
			const cache = this.app.metadataCache as unknown as {
				fileToLinktext?: (file: TFile, sourcePath: string, omitMdExtension?: boolean) => string
			}
			if (typeof vault.getAbstractFileByPath !== 'function' || typeof cache.fileToLinktext !== 'function') {
				return linkItem.targetFile
			}
			const file = vault.getAbstractFileByPath(linkItem.targetPath)
			if (!file || typeof (file as { basename?: unknown }).basename !== 'string') return linkItem.targetFile
			const text = cache.fileToLinktext(file as TFile, diaryPath, true)
			return text && text.trim() ? text : linkItem.targetFile
		} catch {
			return linkItem.targetFile
		}
	}

	/**
	 * 按「日记链接模板」渲染一条。
	 * 模板坏了（语法错误 / 渲染抛错 / 渲染成空）→ 记一次错误并回落默认模板，
	 * 绝不让整批链接丢。
	 */
	private renderLinkEntry(
		linkItem: DiaryLinkItem,
		diaryPath?: string,
	): { text: string; bareLink: string } {
		const { link, title, target } = this.buildBareLink(linkItem, diaryPath)
		const view = buildDiaryLinkView({
			item: linkItem.item,
			link,
			title,
			target,
			anchor: linkItem.isMessage ? (linkItem.anchorHeading ?? '') : '',
			heading: linkItem.heading,
			isMessage: linkItem.isMessage,
			dateSavedFormat: this.settings.dateSavedFormat,
		})
		const template = resolveDiaryLinkTemplate(this.settings.diaryLinkTemplate)

		let text: string | null = null
		try {
			const rendered = renderDiaryLinkTemplate(template, view)
			if (rendered.trim()) {
				text = rendered
			} else {
				this.reportTemplateFailure(new Error('模板渲染结果为空'))
			}
		} catch (error) {
			this.reportTemplateFailure(error)
		}
		if (text === null) {
			text = renderDiaryLinkTemplate(DEFAULT_DIARY_LINK_TEMPLATE, view)
		}
		return { text, bareLink: link }
	}

	private reportTemplateFailure(error: unknown): void {
		if (this.templateFailureLogged) return
		this.templateFailureLogged = true
		logError(
			`📔 日记链接模板渲染失败，本轮回落默认模板「${DEFAULT_DIARY_LINK_TEMPLATE}」，请检查设置里的「日记链接模板」`,
			error,
		)
	}

	/**
	 * 批量处理所有日记链接
	 * 在同步完成后调用
	 */
	async processAll(): Promise<DiaryLinkResult> {
		// 创建空结果对象的工厂函数
		const createEmptyResult = (): DiaryLinkResult => ({
			success: 0,
			skipped: 0,
			selfLinkSkipped: 0,
			errors: [],
			skipReasons: { fileNotFound: [], anchorMissing: [], createFailed: [], selfLink: [] }
		})

		if (!this.settings.enableDiaryLinks || this.links.length === 0) {
			return createEmptyResult()
		}

		const result: DiaryLinkResult = createEmptyResult()

		// 按日期分组
		const linksByDate = this.groupByDate()

		for (const [date, links] of linksByDate) {
			try {
				const processResult = await this.processDateLinks(date, links)
				// 自链接（日记文件即合并文件）：计入 skipped，但单独记数，通知层据此不提示
				if (processResult.selfLinks > 0) {
					result.skipped += processResult.selfLinks
					result.selfLinkSkipped += processResult.selfLinks
					result.skipReasons.selfLink.push(date)
				}
				const remaining = links.length - processResult.selfLinks
				if (remaining === 0) continue
				if (processResult.success) {
					result.success += remaining
				} else {
					result.skipped += remaining
					// 记录跳过原因
					if (processResult.reason === 'fileNotFound') {
						result.skipReasons.fileNotFound.push(date)
					} else if (processResult.reason === 'anchorMissing') {
						result.skipReasons.anchorMissing.push(date)
					} else if (processResult.reason === 'createFailed') {
						result.skipReasons.createFailed.push(date)
					}
				}
			} catch (error) {
				const errorMsg = `日记 ${date} 处理失败: ${error instanceof Error ? error.message : String(error)}`
				result.errors.push(errorMsg)
				logError(errorMsg, error)
			}
		}

		return result
	}

	/**
	 * 按日期分组链接
	 */
	private groupByDate(): Map<string, DiaryLinkItem[]> {
		const groups = new Map<string, DiaryLinkItem[]>()
		for (const link of this.links) {
			const dateKey = link.savedDateISO.slice(0, 10)
			const existing = groups.get(dateKey) || []
			existing.push(link)
			groups.set(dateKey, existing)
		}
		return groups
	}

	/**
	 * 处理单个日期的日记链接
	 * @returns 处理结果，包含是否成功和跳过原因
	 */
	private async processDateLinks(
		date: string,
		links: DiaryLinkItem[]
	): Promise<{
		success: boolean
		reason?: 'fileNotFound' | 'anchorMissing' | 'createFailed'
		/** 这一天里被判成自链接而跳过的条数（不算失败） */
		selfLinks: number
	}> {
		const dateISO = links[0].savedDateISO
		const resolveResult = await this.resolver.resolve(dateISO)

		if (!resolveResult.file) {
			return { success: false, reason: resolveResult.reason || 'fileNotFound', selfLinks: 0 }
		}

		const diaryFile = resolveResult.file

		// 自链接：日记文件就是链接要指向的那个文件（用户把合并消息文件当日记用，
		// 消息文件夹 = 日记文件夹、按天一个文件）。正文已经在里面了，再写一条指向
		// 自己的双链只会让同一条消息出现两遍 → 跳过。这是预期行为，只记日志不算失败。
		const targets = links.filter((link) => !this.isSelfLink(link, diaryFile))
		const selfLinks = links.length - targets.length
		if (selfLinks > 0) {
			log(`📔 跳过 ${selfLinks} 条指向日记自身的链接（日记文件即消息合并文件）: ${diaryFile.path}`)
		}
		if (targets.length === 0) {
			return { success: true, selfLinks }
		}

		// 读取日记内容
		const content = await this.app.vault.read(diaryFile)

		// 按写入位置算出落点 + 去重范围 + 批次排序方向
		const plan = this.buildInsertPlan(content, diaryFile.path)
		if (!plan) {
			return { success: false, reason: 'anchorMissing', selfLinks }
		}

		const scopeContent = content.slice(plan.scopeStart, plan.scopeEnd)

		// 先扫出范围里所有已带标记的 item.id，用于按 id 做主路径去重
		const existingIds = new Set<string>()
		for (const m of scopeContent.matchAll(DIARY_ID_MARKER_REGEX)) {
			existingIds.add(m[1])
		}

		// 生成新链接（范围内去重：① 按 id 命中 → ② 串匹配兜底覆盖存量裸链接）
		// 先按写入顺序排批次，再逐条生成 —— 决定的是「这一批多条链接彼此的先后」，
		// 与「整批插在区域顶部还是底部」由同一个 order 一起决定，见 buildInsertPlan。
		//
		// 「日记不写 id」开启时不再追加标记；但**已有的历史标记仍参与去重**
		// （上面 existingIds 照扫），与另外两个「不写 id」开关的承诺一致。
		const noMarkers = this.noDiaryMarkers
		const newLinks: string[] = []
		for (const link of this.sortLinks(targets, plan.order)) {
			if (existingIds.has(link.item.id)) continue
			const entry = this.renderLinkEntry(link, diaryFile.path)
			// 串匹配兜底只看裸 [[…]]：旧版前缀形态、无 id 模式、换过模板的历史行都能认出来
			if (scopeContent.includes(entry.bareLink)) continue
			// id 标记挂在渲染结果最后一个非空行的末尾（单行模板 = 与旧版同形；模板末尾的空行留在标记后面）
			newLinks.push(
				noMarkers
					? entry.text
					: appendDiaryIdMarker(entry.text, `<!-- ${DIARY_ID_MARKER_PREFIX}${link.item.id} -->`),
			)
			existingIds.add(link.item.id)
		}

		if (newLinks.length === 0) {
			log(`📔 所有链接已存在，跳过: ${diaryFile.path}`)
			return { success: true, selfLinks }
		}

		// 空行由模板自己决定（第一行留空 = 前面空一行；末尾多留一个空行 = 后面空一行），
		// 这里只保证每条从新行开始、以一个换行结束；单行模板与历史实现逐字节一致。
		const at = plan.insertAt
		const linksText = layoutDiaryLinkEntries(newLinks, content, at)
		const nextContent = content.slice(0, at) + linksText + content.slice(at)

		// 写入文件
		await this.app.vault.modify(diaryFile, nextContent)
		log(`📔 已向日记添加 ${newLinks.length} 个链接: ${diaryFile.path}`)

		return { success: true, selfLinks }
	}

	/**
	 * 自链接判定：链接要指向的文件就是当前日记文件本身。
	 * 有完整路径按路径比（同名不同目录不算）；老调用方没给路径时退回比文件名。
	 */
	private isSelfLink(link: DiaryLinkItem, diaryFile: TFile): boolean {
		return link.targetPath !== undefined
			? link.targetPath === diaryFile.path
			: link.targetFile === diaryFile.basename
	}

	/**
	 * 批次内排序：按 savedAt 时间排。
	 * DESC = 新的在前，ASC = 新的在后。时间相同的保持收集顺序（Array#sort 稳定）。
	 */
	private sortLinks(links: DiaryLinkItem[], order: DiaryLinkOrder): DiaryLinkItem[] {
		return [...links].sort((a, b) => {
			const timeA = new Date(a.savedDateISO).getTime()
			const timeB = new Date(b.savedDateISO).getTime()
			return order === DiaryLinkOrder.ASC ? timeA - timeB : timeB - timeA
		})
	}

	/**
	 * 解析生效的写入位置 / 排序方向。
	 * 顶部与底部本身就蕴含了方向（顶部=新的在最上、底部=新的在最下），
	 * 所以只有「锚点之间」才读用户选的 diaryLinkOrder。
	 */
	private effectivePosition(): DiaryWritePosition {
		return this.settings.diaryWritePosition || DiaryWritePosition.ANCHOR
	}

	private effectiveOrder(position: DiaryWritePosition): DiaryLinkOrder {
		if (position === DiaryWritePosition.TOP) return DiaryLinkOrder.DESC
		if (position === DiaryWritePosition.BOTTOM) return DiaryLinkOrder.ASC
		return this.settings.diaryLinkOrder || DiaryLinkOrder.DESC
	}

	/**
	 * 按写入位置算落点。返回 null = 锚点模式但日记里没有成对锚点（跳过）。
	 */
	private buildInsertPlan(content: string, diaryPath: string): InsertPlan | null {
		const position = this.effectivePosition()
		const order = this.effectiveOrder(position)

		if (position === DiaryWritePosition.TOP) {
			// 顶部：前置元数据（YAML frontmatter）之后，绝不插到 --- 之前把属性块打散。
			// 去重范围放大到整个文件（没有锚点圈定区域）。
			const at = this.frontMatterEnd(content)
			return { insertAt: at, scopeStart: 0, scopeEnd: content.length, order }
		}

		if (position === DiaryWritePosition.BOTTOM) {
			return { insertAt: content.length, scopeStart: 0, scopeEnd: content.length, order }
		}

		// 锚点之间：需要两个相同的锚点标记
		const anchorPattern = this.buildAnchorPattern(this.settings.diaryAnchor)
		const firstAnchorIndex = content.indexOf(anchorPattern)
		if (firstAnchorIndex === -1) {
			log(`📔 日记文件缺少锚点 ${anchorPattern}，跳过: ${diaryPath}`)
			return null
		}

		const secondAnchorIndex = content.indexOf(anchorPattern, firstAnchorIndex + anchorPattern.length)
		if (secondAnchorIndex === -1) {
			log(`📔 日记文件只有一个锚点，需要两个相同的锚点标记，跳过: ${diaryPath}`)
			return null
		}

		const regionStart = firstAnchorIndex + anchorPattern.length
		const regionEnd = secondAnchorIndex
		return {
			// 降序 = 整批插在区域顶部（新的压在最上）；升序 = 整批追加到区域底部（新的沉到最下）
			insertAt: order === DiaryLinkOrder.ASC ? regionEnd : regionStart,
			scopeStart: regionStart,
			scopeEnd: regionEnd,
			order,
		}
	}

	/**
	 * 返回前置元数据块结束后的偏移（没有 frontmatter 则为 0）。
	 * 只认「文件第一行就是 ---」这种标准 YAML frontmatter。
	 */
	private frontMatterEnd(content: string): number {
		if (!content.startsWith('---')) return 0
		const firstLineEnd = content.indexOf('\n')
		if (firstLineEnd === -1) return 0
		// 首行必须只有 ---（允许尾随空白 / \r）
		if (content.slice(0, firstLineEnd).trim() !== '---') return 0

		const closeRegex = /^---[ \t]*\r?$/m
		const rest = content.slice(firstLineEnd + 1)
		const match = closeRegex.exec(rest)
		if (!match) return 0

		const closeEnd = firstLineEnd + 1 + match.index + match[0].length
		// 跳过闭合行后面那个换行，落点定位到正文第一行的行首
		return content[closeEnd] === '\n' ? closeEnd + 1 : closeEnd
	}

	/**
	 * 重置（用于新一轮同步）
	 */
	reset(): void {
		this.links = []
		this.templateFailureLogged = false
	}

	/**
	 * 获取当前收集的链接数量
	 */
	get linkCount(): number {
		return this.links.length
	}
}
