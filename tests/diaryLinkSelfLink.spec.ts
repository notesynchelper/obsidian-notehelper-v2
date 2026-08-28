/**
 * 日记链接「自链接跳过」（问题 8）
 *
 * 用户把合并消息文件当日记用：消息文件夹 = 日记文件夹、`{{{date}}}` 按天一个文件，
 * 于是「日记文件」和「消息合并文件」是同一个文件。旧实现照样往里写
 * `[[2024-01-15#锚点|正文…]]`——同一条消息的正文和指向自己的双链在同一文件里出现两遍。
 *
 * 规则（设计 §B3）：
 *   - addLink 新增第 4 个可选参数 targetPath（完整 vault 路径）；MergeProcessor /
 *     FileProcessor 调用处传实际落盘文件的 path
 *   - processDateLinks 解析出日记文件后，targetPath === diaryFile.path 的条目跳过
 *     （没给 targetPath 时退回 targetFile === diaryFile.basename）
 *   - 计入 result.skipped，skipReasons.selfLink 记日期，selfLinkSkipped 记条数；
 *     自链接是预期行为，只记日志、不弹通知（main.ts 按 selfLinkSkipped 扣掉后再决定提示）
 *   - 日记路径 == 合并文件路径 → 文件逐字节不变；同名不同目录 → 照常写；
 *     混批（一条自链接 + 一篇文章）→ 只写文章那条
 */

jest.mock('obsidian', () => {
	const actual = jest.requireActual('obsidian')
	class MockTFile {
		path: string
		basename: string
		name: string
		extension = 'md'
		constructor(path: string) {
			this.path = path
			this.name = path.split('/').pop() || ''
			this.basename = this.name.replace(/\.md$/, '')
		}
	}
	return {
		...actual,
		TFile: MockTFile,
		normalizePath: (p: string) => p,
		Notice: jest.fn(),
	}
})

jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

jest.mock('../src/logger', () => ({
	log: jest.fn(),
	logError: jest.fn(),
	Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { Item } from '@omnivore-app/api'
import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	MessageSortOrder,
	OmnivoreSettings,
	DiaryLinkType,
	DiaryWritePosition,
} from '../src/settings'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'
import type { MergeBatchItem } from '../src/sync/MergeProcessor'
import { log } from '../src/logger'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

const DAY = '2024-01-15'
/** 用户画像：消息文件夹 = 日记文件夹 = journals，按天一个文件 */
const JOURNAL_PATH = `journals/${DAY}.md`
const ANCHOR = 'notehelper-links'
const TAG = `<!-- ${ANCHOR} -->`

interface FakeVault {
	files: Map<string, string>
	read(file: { path: string }): Promise<string>
	modify(file: { path: string }, content: string): Promise<void>
}

function buildVault(initial: Record<string, string>): FakeVault {
	const files = new Map<string, string>(Object.entries(initial))
	return {
		files,
		async read(file) {
			const v = files.get(file.path)
			if (v === undefined) throw new Error(`file not found: ${file.path}`)
			return v
		},
		async modify(file, content) {
			files.set(file.path, content)
		},
	}
}

function baseItem(overrides: Partial<any> = {}): any {
	return {
		id: 'item-1',
		title: 'Some Article Title',
		content: '<p>some content</p>',
		savedAt: `${DAY}T10:30:00.000Z`,
		updatedAt: `${DAY}T10:30:00.000Z`,
		createdAt: `${DAY}T10:30:00.000Z`,
		url: '',
		slug: '',
		author: null,
		siteName: null,
		siteIcon: null,
		publishedAt: null,
		readAt: null,
		isArchived: false,
		contentReader: 'WEB',
		pageType: 'ARTICLE',
		state: 'SUCCEEDED',
		description: null,
		labels: [],
		highlights: [],
		image: null,
		words: null,
		wordsCount: null,
		readingProgressTopPercent: 0,
		readingProgressPercent: 0,
		readingProgressAnchorIndex: 0,
		...overrides,
	}
}

function wechatItem(overrides: Partial<any> = {}): any {
	return baseItem({
		id: 'msg-1',
		title: '同步助手_20240115_001_文本',
		content: '<p>万载时代项目现场，停机检修过程中发现问题</p>',
		...overrides,
	})
}

function buildProcessor(
	overrides: Partial<OmnivoreSettings>,
	vault: FakeVault,
	diaryFile: InstanceType<typeof MockTFile>,
): DiaryLinkProcessor {
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryAnchor: ANCHOR,
		diaryLinkMaxLength: 0,
		diaryLinkType: DiaryLinkType.ALL,
		diaryWritePosition: DiaryWritePosition.BOTTOM,
		...overrides,
	}
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	return new DiaryLinkProcessor({ vault } as never, settings, stubResolver)
}

const JOURNAL_BODY = `---\ndate: ${DAY}\n---\n# 晨间记录\n---\n10:30:00\n万载时代项目现场，停机检修过程中发现问题\n- - -\n`

beforeEach(() => {
	;(log as jest.Mock).mockClear()
})

describe('自链接跳过：日记文件 == 消息合并文件', () => {
	it('targetPath 与日记 path 相同 → 文件逐字节不变，计入 skipped + skipReasons.selfLink', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({}, vault, diaryFile)

		p.addLink(wechatItem(), DAY, '万载时代项目现场，停机', JOURNAL_PATH)
		const result = await p.processAll()

		expect(vault.files.get(JOURNAL_PATH)).toBe(JOURNAL_BODY)
		expect(result.success).toBe(0)
		expect(result.skipped).toBe(1)
		expect(result.selfLinkSkipped).toBe(1)
		expect(result.skipReasons.selfLink).toEqual([DAY])
		expect(result.skipReasons.fileNotFound).toEqual([])
		expect(result.skipReasons.anchorMissing).toEqual([])
		expect(result.errors).toEqual([])
	})

	it('自链接只记日志，不算错误', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({}, vault, diaryFile)

		p.addLink(wechatItem(), DAY, undefined, JOURNAL_PATH)
		const result = await p.processAll()

		expect(result.errors).toEqual([])
		const logged = (log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n')
		expect(logged).toContain(JOURNAL_PATH)
	})

	it('同名不同目录（articles/2024-01-15.md）→ 不是自链接，照常写', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({}, vault, diaryFile)

		p.addLink(baseItem({ title: DAY }), DAY, undefined, `articles/${DAY}.md`)
		const result = await p.processAll()

		expect(result.success).toBe(1)
		expect(result.skipped).toBe(0)
		expect(result.selfLinkSkipped).toBe(0)
		expect(vault.files.get(JOURNAL_PATH)).toBe(
			`${JOURNAL_BODY}- [[${DAY}|${DAY}]] <!-- notehelper:id:item-1 -->\n`,
		)
	})

	it('混批：一条自链接消息 + 一篇文章 → 只写文章那条', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({}, vault, diaryFile)

		p.addLink(wechatItem(), DAY, '万载时代项目现场，停机', JOURNAL_PATH)
		p.addLink(
			baseItem({ id: 'art-1', title: 'Philosophia - 人体是DNA的宿主' }),
			'Philosophia - 人体是DNA的宿主',
			undefined,
			'articles/Philosophia - 人体是DNA的宿主.md',
		)
		const result = await p.processAll()

		expect(result.success).toBe(1)
		expect(result.skipped).toBe(1)
		expect(result.selfLinkSkipped).toBe(1)
		expect(result.skipReasons.selfLink).toEqual([DAY])
		const after = vault.files.get(JOURNAL_PATH)!
		expect(after).toBe(
			`${JOURNAL_BODY}- [[Philosophia - 人体是DNA的宿主|Philosophia - 人体是DNA的宿主]] <!-- notehelper:id:art-1 -->\n`,
		)
		expect(after).not.toContain(`[[${DAY}#`)
	})

	it('没给 targetPath → 退回按文件名比较：同名即自链接', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({}, vault, diaryFile)

		p.addLink(wechatItem(), DAY, '万载时代项目现场，停机')
		p.addLink(baseItem({ id: 'art-1', title: '别的文章' }), '别的文章')
		const result = await p.processAll()

		expect(result.success).toBe(1)
		expect(result.selfLinkSkipped).toBe(1)
		const after = vault.files.get(JOURNAL_PATH)!
		expect(after).not.toContain(`[[${DAY}#`)
		expect(after).toContain('[[别的文章|别的文章]]')
	})

	it('三种写入位置都跳过自链接', async () => {
		const withAnchors = `# ${DAY}\n\n${TAG}\n${TAG}\n`
		const cases: Array<[DiaryWritePosition, string]> = [
			[DiaryWritePosition.ANCHOR, withAnchors],
			[DiaryWritePosition.TOP, JOURNAL_BODY],
			[DiaryWritePosition.BOTTOM, JOURNAL_BODY],
		]
		for (const [position, initial] of cases) {
			const diaryFile = new MockTFile(JOURNAL_PATH)
			const vault = buildVault({ [JOURNAL_PATH]: initial })
			const p = buildProcessor({ diaryWritePosition: position }, vault, diaryFile)
			p.addLink(wechatItem(), DAY, '万载时代项目现场，停机', JOURNAL_PATH)
			const result = await p.processAll()
			expect(vault.files.get(JOURNAL_PATH)).toBe(initial)
			expect(result.selfLinkSkipped).toBe(1)
			expect(result.skipReasons.selfLink).toEqual([DAY])
		}
	})

	it('整批都是自链接时不写文件、不报 anchorMissing（哪怕锚点缺失）', async () => {
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: JOURNAL_BODY })
		const p = buildProcessor({ diaryWritePosition: DiaryWritePosition.ANCHOR }, vault, diaryFile)

		p.addLink(wechatItem(), DAY, '万载时代项目现场，停机', JOURNAL_PATH)
		const result = await p.processAll()

		expect(result.skipped).toBe(1)
		expect(result.selfLinkSkipped).toBe(1)
		expect(result.skipReasons.anchorMissing).toEqual([])
		expect(vault.files.get(JOURNAL_PATH)).toBe(JOURNAL_BODY)
	})
})

describe('MergeProcessor 调用处传入实际落盘路径（用户画像整链路）', () => {
	function makeCtx(diary: { vault: FakeVault; diaryFile: InstanceType<typeof MockTFile> }) {
		let fileContent = ''
		const settings = {
			...DEFAULT_SETTINGS,
			messageSortOrder: MessageSortOrder.ASC,
			dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
			wechatMessageTemplate: '---\n#### {{{heading}}}\n{{{content}}}',
			sectionSeparator: '',
			sectionSeparatorEnd: '',
			enableDiaryLinks: true,
			diaryAnchor: ANCHOR,
			diaryLinkMaxLength: 0,
			diaryLinkType: DiaryLinkType.ALL,
			diaryWritePosition: DiaryWritePosition.BOTTOM,
			syncAt: '',
			deviceSyncCursors: {},
		}
		const ctx = {
			settings,
			app: {
				vault: {
					// 合并文件（MergeProcessor 用 process）——这里合并文件就是日记文件本身
					process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
						fileContent = fn(fileContent)
						diary.vault.files.set(JOURNAL_PATH, fileContent)
						return fileContent
					}),
					read: (f: { path: string }) => diary.vault.read(f),
					modify: (f: { path: string }, c: string) => diary.vault.modify(f, c),
				},
			},
			successTracker: { recordSuccess: jest.fn() },
			enqueueFileForImageLocalization: jest.fn(async () => {}),
			enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
			addProcessedFile: jest.fn(),
			imageLocalizer: null,
			getFileContent: () => fileContent,
		}
		const stubResolver = {
			resolve: jest.fn(async () => ({ file: diary.diaryFile })),
		} as unknown as DailyNoteResolver
		const diaryLinkProcessor = new DiaryLinkProcessor(ctx.app as never, settings as never, stubResolver)
		return { ...ctx, diaryLinkProcessor }
	}

	it('合并文件 path == 日记 path → 消息正文只出现一次，没有指向自己的双链', async () => {
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: '' })
		const ctx = makeCtx({ vault, diaryFile })

		const msg = wechatItem({ id: 'c1d2e3f4-0000-4000-8000-000000000001' }) as Item

		const mergeFile = { path: JOURNAL_PATH, basename: DAY } as never
		const processor = new MergeProcessor(ctx as never)
		const batch: MergeBatchItem[] = [{ item: msg, content: '' }]
		await processor.processBatch(batch, mergeFile)
		const afterMerge = vault.files.get(JOURNAL_PATH)!
		const result = await ctx.diaryLinkProcessor.processAll()

		expect(result.selfLinkSkipped).toBe(1)
		expect(result.success).toBe(0)
		expect(result.errors).toEqual([])
		const after = vault.files.get(JOURNAL_PATH)!
		// 日记侧一个字没动；消息正文只出现一次（消息模板的 heading 只取前 10 字，
		// 所以数正文后半句），没有指向自己的 [[2024-01-15#…]] 双链
		expect(after).toBe(afterMerge)
		expect(after.split('检修过程中发现问题').length - 1).toBe(1)
		expect(after).not.toContain(`[[${DAY}#`)
	})

	it('合并文件在别的目录（笔记同步助手/…）→ 日记里照常出现消息双链', async () => {
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const diaryFile = new MockTFile(JOURNAL_PATH)
		const vault = buildVault({ [JOURNAL_PATH]: `# ${DAY}\n` })
		const ctx = makeCtx({ vault, diaryFile })
		// 合并文件不是日记：process 写到别处
		let mergeContent = ''
		ctx.app.vault.process = jest.fn(async (_file: unknown, fn: (data: string) => string) => {
			mergeContent = fn(mergeContent)
			return mergeContent
		})

		const msg = wechatItem({ id: 'c1d2e3f4-0000-4000-8000-000000000003' }) as Item
		const mergeFile = { path: `笔记同步助手/${DAY}/同步助手_${DAY}.md`, basename: `同步助手_${DAY}` } as never
		const processor = new MergeProcessor(ctx as never)
		await processor.processBatch([{ item: msg, content: '' }], mergeFile)
		const result = await ctx.diaryLinkProcessor.processAll()

		expect(result.selfLinkSkipped).toBe(0)
		expect(result.success).toBe(1)
		expect(vault.files.get(JOURNAL_PATH)).toContain(`[[同步助手_${DAY}#`)
	})
})
