/**
 * 日记链接落盘的空行规则——**空行由模板自己决定，插件不额外补**（问题 7，2026-08-28 用户拍板修订）
 *
 * 用户诉求（企微工单 2026-08-16~27）：「文件底部」写入时链接紧贴上一条内容、中间没有空行。
 * 最初实现是「多行模板自动与上下各空一行」，用户要求改成模板控制。
 *
 * 规则（设计 §B2，文件模型）：
 *   - 每条链接从新的一行开始；每条以**一个**换行结束（模板没写就补一个，写了一个就是行尾，
 *     多写的每个换行都是一个空行）；模板开头的空行原样保留。
 *   - 落点后面本来就是换行时，条目的行尾换行与之合并，不凭空多出空行。
 *   - 所以「前面空一行」= 模板第一行留空；「后面空一行」= 模板末尾多留一个空行。
 *   - 单行模板（含末尾多打一个换行的）与旧版「双链前缀」逐字节一致。
 *   - id 标记挂在最后一个非空行末尾，模板末尾的空行留在标记后面。
 */

jest.mock('obsidian', () => {
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
		App: jest.fn(),
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
}))

import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	OmnivoreSettings,
	DiaryLinkType,
	DiaryWritePosition,
	DiaryLinkOrder,
} from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const ANCHOR = 'notehelper-links'
const TAG = `<!-- ${ANCHOR} -->`
/** 三行模板：分隔线 + 时间 + 链接 —— 工单用户要的样子 */
const BLOCK_TEMPLATE = '---\n{{{timeSaved}}}\n{{{link}}}'

interface FakeVault {
	files: Map<string, string>
	read(file: { path: string }): Promise<string>
	modify(file: { path: string }, content: string): Promise<void>
}

function buildVault(initial: string): FakeVault {
	const files = new Map<string, string>([[DIARY_PATH, initial]])
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

/** 同一天内不同时刻的文章（jest TZ=UTC，timeSaved = HH:00:00） */
function articleAt(hour: number, label: string): any {
	const iso = `2024-01-15T${String(hour).padStart(2, '0')}:00:00.000Z`
	return {
		id: `item-${label}`,
		title: label,
		content: '<p>c</p>',
		savedAt: iso,
		updatedAt: iso,
		createdAt: iso,
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
	}
}

/** 期望的一块：`---\nHH:00:00\n[[file-X|X]] <!-- notehelper:id:item-X -->` */
function block(hour: number, label: string): string {
	return `---\n${String(hour).padStart(2, '0')}:00:00\n[[file-${label}|${label}]] <!-- notehelper:id:item-${label} -->`
}

function line(label: string): string {
	return `- [[file-${label}|${label}]] <!-- notehelper:id:item-${label} -->`
}

async function sync(
	vault: FakeVault,
	overrides: Partial<OmnivoreSettings>,
	items: any[],
): Promise<string> {
	const diaryFile = new MockTFile(DIARY_PATH)
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryAnchor: ANCHOR,
		diaryLinkMaxLength: 0,
		diaryLinkType: DiaryLinkType.ALL,
		...overrides,
	}
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	const p = new DiaryLinkProcessor({ vault } as never, settings, stubResolver)
	for (const it of items) p.addLink(it, `file-${it.title}`, undefined)
	await p.processAll()
	return vault.files.get(DIARY_PATH)!
}

const BOTTOM = { diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: BLOCK_TEMPLATE }
const TOP = { diaryWritePosition: DiaryWritePosition.TOP, diaryLinkTemplate: BLOCK_TEMPLATE }

/** 第一行留空的三行模板：用户要的「与上文空一行 + 分隔线 + 时间 + 链接」 */
const GAP_TEMPLATE = '\n---\n{{{timeSaved}}}\n{{{link}}}'
const BOTTOM_GAP = { diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: GAP_TEMPLATE }
const TOP_GAP = { diaryWritePosition: DiaryWritePosition.TOP, diaryLinkTemplate: GAP_TEMPLATE }

describe('单行模板：与旧版逐字节一致', () => {
	it('底部：同批相连成列表，前面只补一个换行，条目之间没有空行', async () => {
		const v = buildVault('# 头\n\n正文')
		const after = await sync(v, { diaryWritePosition: DiaryWritePosition.BOTTOM }, [
			articleAt(9, 'A'),
			articleAt(12, 'B'),
		])
		expect(after).toBe(`# 头\n\n正文\n${line('A')}\n${line('B')}\n`)
	})

	it('单行模板末尾多打一个换行 = 行尾，不会多出空行（与不打时逐字节相同）', async () => {
		const v = buildVault('# 头\n\n正文\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: '- {{{link}}}\n' },
			[articleAt(9, 'A'), articleAt(12, 'B')],
		)
		expect(after).toBe(`# 头\n\n正文\n${line('A')}\n${line('B')}\n`)
	})

	it('顶部 + 前置元数据：紧贴属性块之后、正文之前，与旧版一致', async () => {
		const v = buildVault('---\na: 1\n---\n# 头\n')
		const after = await sync(v, { diaryWritePosition: DiaryWritePosition.TOP }, [articleAt(9, 'A')])
		expect(after).toBe(`---\na: 1\n---\n${line('A')}\n# 头\n`)
	})

	it('锚点之间：紧挨锚点，与旧版一致', async () => {
		const v = buildVault(`# 头\n\n${TAG}\n${TAG}\n`)
		const after = await sync(v, {}, [articleAt(9, 'A')])
		expect(after).toBe(`# 头\n\n${TAG}\n${line('A')}\n${TAG}\n`)
	})
})

describe('多行模板但没留空行：紧挨着上下内容写（插件不自动补空行）', () => {
	it('底部：块紧跟正文，块尾一个换行收尾', async () => {
		const v = buildVault('# 头\n\n正文\n')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n${block(10, 'A')}\n`)
	})

	it('底部 + 文件末尾没有换行：只起一行，不空行', async () => {
		const v = buildVault('# 头\n\n正文')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n${block(10, 'A')}\n`)
	})

	it('底部 + 同批多条：条目之间也不空行', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, BOTTOM, [articleAt(12, 'B'), articleAt(9, 'A')])
		expect(after).toBe(`正文\n${block(9, 'A')}\n${block(12, 'B')}\n`)
	})

	it('顶部 + 前置元数据：块紧贴属性块之后、正文之前', async () => {
		const v = buildVault('---\na: 1\n---\n# 头\n')
		const after = await sync(v, TOP, [articleAt(10, 'A')])
		expect(after).toBe(`---\na: 1\n---\n${block(10, 'A')}\n# 头\n`)
	})

	it('锚点之间：块紧挨两个锚点', async () => {
		const v = buildVault(`# 头\n\n${TAG}\n${TAG}\n`)
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC, diaryLinkTemplate: BLOCK_TEMPLATE },
			[articleAt(10, 'A')],
		)
		expect(after).toBe(`# 头\n\n${TAG}\n${block(10, 'A')}\n${TAG}\n`)
	})
})

describe('模板第一行留空 = 前面空一行', () => {
	it('底部：文件以单个换行结尾 → 正文与块之间恰好一个空行', async () => {
		const v = buildVault('# 头\n\n正文\n')
		const after = await sync(v, BOTTOM_GAP, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n${block(10, 'A')}\n`)
	})

	it('底部：文件末尾没有换行 → 先起一行再空一行', async () => {
		const v = buildVault('# 头\n\n正文')
		const after = await sync(v, BOTTOM_GAP, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n${block(10, 'A')}\n`)
	})

	it('底部：文件末尾本来就有空行 → 模板的空行照加（两个空行——模板说了算，插件不去重）', async () => {
		const v = buildVault('# 头\n\n正文\n\n')
		const after = await sync(v, BOTTOM_GAP, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n\n${block(10, 'A')}\n`)
	})

	it('底部 + 同批多条：每条前面各空一行，按时间升序', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, BOTTOM_GAP, [articleAt(12, 'B'), articleAt(9, 'A')])
		expect(after).toBe(`正文\n\n${block(9, 'A')}\n\n${block(12, 'B')}\n`)
	})

	it('底部多轮同步：新块接在旧块之下、之间一个空行；同批重跑逐字节不变', async () => {
		const v = buildVault('正文\n')
		await sync(v, BOTTOM_GAP, [articleAt(9, 'A')])
		const afterFirst = await sync(v, BOTTOM_GAP, [articleAt(20, 'B')])
		expect(afterFirst).toBe(`正文\n\n${block(9, 'A')}\n\n${block(20, 'B')}\n`)
		const afterRepeat = await sync(v, BOTTOM_GAP, [articleAt(9, 'A'), articleAt(20, 'B')])
		expect(afterRepeat).toBe(afterFirst)
	})

	it('空文件：模板开头的空行也原样落盘（模板说了算）', async () => {
		const v = buildVault('')
		const after = await sync(v, BOTTOM_GAP, [articleAt(10, 'A')])
		expect(after).toBe(`\n${block(10, 'A')}\n`)
	})

	it('顶部 + 前置元数据：属性块之后空一行、块、正文紧跟（后面没留空行就不空）', async () => {
		const v = buildVault('---\na: 1\n---\n# 头\n')
		const after = await sync(v, TOP_GAP, [articleAt(10, 'A')])
		expect(after).toBe(`---\na: 1\n---\n\n${block(10, 'A')}\n# 头\n`)
	})

	it('顶部多轮：新块压在旧块之上、之间一个空行；同批按时间降序', async () => {
		const v = buildVault('# 头\n')
		await sync(v, TOP_GAP, [articleAt(9, 'A')])
		const after = await sync(v, TOP_GAP, [articleAt(20, 'B'), articleAt(21, 'C')])
		expect(after).toBe(`\n${block(21, 'C')}\n\n${block(20, 'B')}\n\n${block(9, 'A')}\n# 头\n`)
	})

	it('锚点之间（降序）：开锚点之后空一行，块，闭锚点紧跟', async () => {
		const v = buildVault(`# 头\n\n${TAG}\n${TAG}\n`)
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC, diaryLinkTemplate: GAP_TEMPLATE },
			[articleAt(10, 'A')],
		)
		expect(after).toBe(`# 头\n\n${TAG}\n\n${block(10, 'A')}\n${TAG}\n`)
	})

	it('锚点之间（升序）多轮：新块追加在下方，块间一个空行', async () => {
		const opts = { diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.ASC, diaryLinkTemplate: GAP_TEMPLATE }
		const v = buildVault(`${TAG}\n${TAG}\n`)
		await sync(v, opts, [articleAt(9, 'A')])
		const after = await sync(v, opts, [articleAt(20, 'B')])
		expect(after).toBe(`${TAG}\n\n${block(9, 'A')}\n\n${block(20, 'B')}\n${TAG}\n`)
	})

	it('缺锚点仍然跳过、文件不动', async () => {
		const v = buildVault('# 头\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC, diaryLinkTemplate: GAP_TEMPLATE },
			[articleAt(10, 'A')],
		)
		expect(after).toBe('# 头\n')
	})
})

describe('模板末尾多留一个空行 = 后面空一行；id 标记挂在最后一个非空行', () => {
	const TRAIL = { diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: '---\n{{{link}}}\n\n' }

	it('底部：块后面空一行，标记在链接行末尾、空行在标记后面', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, TRAIL, [articleAt(10, 'A')])
		expect(after).toBe('正文\n---\n[[file-A|A]] <!-- notehelper:id:item-A -->\n\n')
	})

	it('底部 + 同批多条：每条后面各空一行', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, TRAIL, [articleAt(9, 'A'), articleAt(12, 'B')])
		expect(after).toBe(
			'正文\n---\n[[file-A|A]] <!-- notehelper:id:item-A -->\n\n---\n[[file-B|B]] <!-- notehelper:id:item-B -->\n\n',
		)
	})

	it('顶部：块后面空一行再接正文（模板尾空行与落点后的换行合并，不会变成两个空行）', async () => {
		const v = buildVault('# 头\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.TOP, diaryLinkTemplate: '- {{{link}}}\n\n' },
			[articleAt(10, 'A')],
		)
		expect(after).toBe('- [[file-A|A]] <!-- notehelper:id:item-A -->\n\n# 头\n')
	})

	it('「日记不写 id」：没有标记时模板尾空行同样保留', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, { ...TRAIL, disableDiaryLinkMarkers: true }, [articleAt(10, 'A')])
		expect(after).toBe('正文\n---\n[[file-A|A]]\n\n')
	})

	it('模板末尾只有空格 / 制表符 → 去掉，不算空行', async () => {
		const v = buildVault('正文\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: '- {{{link}}}  \t' },
			[articleAt(10, 'A')],
		)
		expect(after).toBe(`正文\n${line('A')}\n`)
	})
})

describe('区域里已有旧版单行链接：新块按模板落在其后，旧行不动', () => {
	it('升序锚点区域：留空第一行的模板与旧行之间空一行', async () => {
		const v = buildVault(`${TAG}\n- [[file-X|X]] <!-- notehelper:id:item-X -->\n${TAG}\n`)
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.ASC, diaryLinkTemplate: GAP_TEMPLATE },
			[articleAt(10, 'A')],
		)
		expect(after).toBe(
			`${TAG}\n- [[file-X|X]] <!-- notehelper:id:item-X -->\n\n${block(10, 'A')}\n${TAG}\n`,
		)
	})
})

// 纯函数层：layoutDiaryLinkEntries / appendDiaryIdMarker / terminateEntry
import { layoutDiaryLinkEntries, appendDiaryIdMarker, terminateEntry, normalizeEntryTail } from '../src/sync/diaryLinkTemplate'

describe('layoutDiaryLinkEntries：落盘拼接规则', () => {
	it('落点在行首、后面是空行 → 条目完整成行，后面的空行是别人的、不动', () => {
		expect(layoutDiaryLinkEntries(['- a'], 'X\n\nY', 2)).toBe('- a\n')
	})
	it('落点在某行末尾、后面是那行的换行（锚点降序）→ 先起一行，行尾换行合并（旧版同形）', () => {
		expect(layoutDiaryLinkEntries(['- a'], 'X\nY', 1)).toBe('\n- a')
	})
	it('落点在某行末尾且是文件末尾 → 起一行，以一个换行收尾', () => {
		expect(layoutDiaryLinkEntries(['- a'], 'X', 1)).toBe('\n- a\n')
	})
	it('文件末尾（行首）→ 以一个换行收尾', () => {
		expect(layoutDiaryLinkEntries(['- a', '- b'], 'X\n', 2)).toBe('- a\n- b\n')
	})
	it('条目自带尾空行 → 行首落点原样保留', () => {
		expect(layoutDiaryLinkEntries(['- a\n\n'], 'X\n\nY', 2)).toBe('- a\n\n')
	})
	it('空文件 + 模板开头空行 → 原样', () => {
		expect(layoutDiaryLinkEntries(['\n- a'], '', 0)).toBe('\n- a\n')
	})
})

describe('appendDiaryIdMarker / terminateEntry', () => {
	it('无尾换行：标记接在末尾（与旧版同形）', () => {
		expect(appendDiaryIdMarker('- [[a]]', '<!-- m -->')).toBe('- [[a]] <!-- m -->')
	})
	it('有尾空行：标记挂在最后一个非空行，空行留在后面', () => {
		expect(appendDiaryIdMarker('---\n[[a]]\n\n', '<!-- m -->')).toBe('---\n[[a]] <!-- m -->\n\n')
	})
	it('尾部是空白行「\\n  \\n」：仍挂在最后一个非空行', () => {
		expect(appendDiaryIdMarker('[[a]]\n  \n', '<!-- m -->')).toBe('[[a]] <!-- m -->\n  \n')
	})
	it('normalizeEntryTail：去掉最后非空行的尾空格，尾部空白行归一为纯换行、个数不变', () => {
		expect(normalizeEntryTail('- [[a]]  \n\n')).toBe('- [[a]]\n\n')
		expect(normalizeEntryTail('x\n  \n')).toBe('x\n\n')
		expect(normalizeEntryTail('x  \t')).toBe('x')
		expect(normalizeEntryTail('\n---\nx')).toBe('\n---\nx')
		expect(normalizeEntryTail('a\n\nb')).toBe('a\n\nb')
	})
	it('terminateEntry：没换行补一个，有换行原样', () => {
		expect(terminateEntry('x')).toBe('x\n')
		expect(terminateEntry('x\n')).toBe('x\n')
		expect(terminateEntry('x\n\n')).toBe('x\n\n')
	})
})
