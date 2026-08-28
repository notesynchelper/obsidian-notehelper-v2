/**
 * 日记链接「块间距」——多行模板写入日记时的空行规则（问题 7）
 *
 * 用户诉求（企微工单 2026-08-16~27）：「文件底部」写入时链接紧贴上一条内容、
 * 中间没有空行，挤在一起不好看。
 *
 * 规则（设计 §B2）：
 *   - 单行模板（去掉尾部空白后不含换行）：行为与旧版逐字节一致——同批 `\n` 相连成列表，
 *     前后只按需补一个 `\n`。
 *   - 多行模板：同批条目之间空一行；整块与前后既有内容之间**至少一个空行**
 *     （前面：before 非空且不以空行结尾就补到有空行；后面同理）。
 *     用户模板自带的开头空行不重复叠加——按拼接后的实际字符判断，不是无脑加。
 *   - 三种写入位置（锚点之间 ASC/DESC、顶部、底部）+ 文件末尾无换行 / 一个换行 /
 *     已有空行三种边界都要成立；多轮同步幂等（不累加空行）。
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

describe('单行模板：与旧版逐字节一致（块间距只对多行模板生效）', () => {
	it('底部：同批相连成列表，前面只补一个换行，条目之间没有空行', async () => {
		const v = buildVault('# 头\n\n正文')
		const after = await sync(v, { diaryWritePosition: DiaryWritePosition.BOTTOM }, [
			articleAt(9, 'A'),
			articleAt(12, 'B'),
		])
		expect(after).toBe(`# 头\n\n正文\n${line('A')}\n${line('B')}\n`)
	})

	it('单行模板尾部多打了换行仍算单行（去尾部空白后无换行），不触发块间距', async () => {
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

describe('多行模板 · 文件底部', () => {
	it('文件以单个换行结尾 → 块前空一行，块后一个换行收尾', async () => {
		const v = buildVault('# 头\n\n正文\n')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n${block(10, 'A')}\n`)
	})

	it('文件末尾没有换行 → 补到有一个空行', async () => {
		const v = buildVault('# 头\n\n正文')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n${block(10, 'A')}\n`)
	})

	it('文件末尾已经有空行 → 不再叠加', async () => {
		const v = buildVault('# 头\n\n正文\n\n')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n正文\n\n${block(10, 'A')}\n`)
	})

	it('同批多条：条目之间恰好一个空行，且按时间升序', async () => {
		const v = buildVault('正文\n')
		const after = await sync(v, BOTTOM, [articleAt(12, 'B'), articleAt(9, 'A')])
		expect(after).toBe(`正文\n\n${block(9, 'A')}\n\n${block(12, 'B')}\n`)
	})

	it('多轮同步：新块接在旧块之下、之间一个空行，幂等不累加', async () => {
		const v = buildVault('正文\n')
		await sync(v, BOTTOM, [articleAt(9, 'A')])
		const afterFirst = await sync(v, BOTTOM, [articleAt(20, 'B')])
		expect(afterFirst).toBe(`正文\n\n${block(9, 'A')}\n\n${block(20, 'B')}\n`)
		// 同一批再来一次：文件逐字节不变
		const afterRepeat = await sync(v, BOTTOM, [articleAt(9, 'A'), articleAt(20, 'B')])
		expect(afterRepeat).toBe(afterFirst)
	})

	it('空文件：块直接落在开头，没有前导空行', async () => {
		const v = buildVault('')
		const after = await sync(v, BOTTOM, [articleAt(10, 'A')])
		expect(after).toBe(`${block(10, 'A')}\n`)
	})
})

describe('多行模板 · 文件顶部', () => {
	it('无前置元数据：块在最上方（前面没有内容就不加空行），与正文之间空一行', async () => {
		const v = buildVault('# 头\n正文\n')
		const after = await sync(v, TOP, [articleAt(10, 'A')])
		expect(after).toBe(`${block(10, 'A')}\n\n# 头\n正文\n`)
	})

	it('有前置元数据：属性块之后空一行、块、再空一行接正文', async () => {
		const v = buildVault('---\na: 1\n---\n# 头\n')
		const after = await sync(v, TOP, [articleAt(10, 'A')])
		expect(after).toBe(`---\na: 1\n---\n\n${block(10, 'A')}\n\n# 头\n`)
	})

	it('正文本来就以空行开头 → 不再叠加', async () => {
		const v = buildVault('---\na: 1\n---\n\n# 头\n')
		const after = await sync(v, TOP, [articleAt(10, 'A')])
		expect(after).toBe(`---\na: 1\n---\n\n${block(10, 'A')}\n\n# 头\n`)
	})

	it('多轮同步：新块压在旧块之上、之间一个空行；同批按时间降序', async () => {
		const v = buildVault('# 头\n')
		await sync(v, TOP, [articleAt(9, 'A')])
		const after = await sync(v, TOP, [articleAt(20, 'B'), articleAt(21, 'C')])
		expect(after).toBe(`${block(21, 'C')}\n\n${block(20, 'B')}\n\n${block(9, 'A')}\n\n# 头\n`)
	})
})

describe('多行模板 · 锚点之间', () => {
	const ANCHOR_DESC = {
		diaryWritePosition: DiaryWritePosition.ANCHOR,
		diaryLinkOrder: DiaryLinkOrder.DESC,
		diaryLinkTemplate: BLOCK_TEMPLATE,
	}
	const ANCHOR_ASC = { ...ANCHOR_DESC, diaryLinkOrder: DiaryLinkOrder.ASC }

	it('降序：块与两个锚点之间各空一行', async () => {
		const v = buildVault(`# 头\n\n${TAG}\n${TAG}\n`)
		const after = await sync(v, ANCHOR_DESC, [articleAt(10, 'A')])
		expect(after).toBe(`# 头\n\n${TAG}\n\n${block(10, 'A')}\n\n${TAG}\n`)
	})

	it('降序多轮：新块在上，块间一个空行，闭合锚点前仍只有一个空行', async () => {
		const v = buildVault(`${TAG}\n${TAG}\n`)
		await sync(v, ANCHOR_DESC, [articleAt(9, 'A')])
		const after = await sync(v, ANCHOR_DESC, [articleAt(20, 'B')])
		expect(after).toBe(`${TAG}\n\n${block(20, 'B')}\n\n${block(9, 'A')}\n\n${TAG}\n`)
	})

	it('升序多轮：新块追加在下方，块间一个空行', async () => {
		const v = buildVault(`${TAG}\n${TAG}\n`)
		await sync(v, ANCHOR_ASC, [articleAt(9, 'A')])
		const after = await sync(v, ANCHOR_ASC, [articleAt(20, 'B')])
		expect(after).toBe(`${TAG}\n\n${block(9, 'A')}\n\n${block(20, 'B')}\n\n${TAG}\n`)
	})

	it('区域里已有旧版单行链接：多行块与旧行之间空一行，旧行不动', async () => {
		const v = buildVault(`${TAG}\n- [[file-X|X]] <!-- notehelper:id:item-X -->\n${TAG}\n`)
		const after = await sync(v, ANCHOR_ASC, [articleAt(10, 'A')])
		expect(after).toBe(
			`${TAG}\n- [[file-X|X]] <!-- notehelper:id:item-X -->\n\n${block(10, 'A')}\n\n${TAG}\n`,
		)
	})

	it('缺锚点仍然跳过、文件不动（块间距不改变锚点语义）', async () => {
		const v = buildVault('# 头\n')
		const after = await sync(v, ANCHOR_DESC, [articleAt(10, 'A')])
		expect(after).toBe('# 头\n')
	})
})

describe('多行模板 · 用户自带的空行不重复叠加', () => {
	it('模板开头故意留了空行 → 与前文之间仍只有一个空行', async () => {
		const v = buildVault('正文\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: '\n---\n{{{link}}}' },
			[articleAt(10, 'A')],
		)
		expect(after).toBe('正文\n\n---\n[[file-A|A]] <!-- notehelper:id:item-A -->\n')
	})

	it('模板开头留空行 + 同批多条 → 条目之间也只有一个空行', async () => {
		const v = buildVault('正文\n')
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.BOTTOM, diaryLinkTemplate: '\n---\n{{{link}}}' },
			[articleAt(9, 'A'), articleAt(12, 'B')],
		)
		expect(after).toBe(
			'正文\n\n---\n[[file-A|A]] <!-- notehelper:id:item-A -->\n\n---\n[[file-B|B]] <!-- notehelper:id:item-B -->\n',
		)
	})

	it('锚点区域已经以空行开头 / 结尾 → 不再多加', async () => {
		const v = buildVault(`${TAG}\n\n\n${TAG}\n`)
		const after = await sync(
			v,
			{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC, diaryLinkTemplate: BLOCK_TEMPLATE },
			[articleAt(10, 'A')],
		)
		expect(after).toBe(`${TAG}\n\n${block(10, 'A')}\n\n\n${TAG}\n`)
	})
})

// codex review 2026-08-28：只含空格 / 制表符的行也算空行，否则会在它旁边再补一个真空行
import { blankLineGap, joinLinkBlocks } from '../src/sync/diaryLinkTemplate'

describe('blankLineGap：空白行（只有空格/制表符）算作空行', () => {
	it('左侧以「\\n  \\n」结尾（看不见的空行）→ 已经隔开，不再补', () => {
		expect(blankLineGap('正文\n  \n', '---\nx')).toBe('')
	})
	it('右侧以「  \\n」开头 → 与左侧的单个换行合起来刚好一个空行', () => {
		expect(blankLineGap('正文\n', '  \n---')).toBe('')
	})
	it('左侧只有一个换行 + 右侧无空行 → 补一个换行（原规则不变）', () => {
		expect(blankLineGap('正文\n', '---')).toBe('\n')
	})
	it('左侧末尾是制表符空行「\\n\\t\\n」→ 不再补', () => {
		expect(blankLineGap('正文\n\t\n', '---')).toBe('')
	})
	it('左侧末尾只有空格没有换行 → 仍补两个换行', () => {
		expect(blankLineGap('正文  ', '---')).toBe('\n\n')
	})
	it('joinLinkBlocks：条目自带的空白尾行不会让条目间多出第二个空行', () => {
		expect(joinLinkBlocks(['a\n  \n', 'b'])).toBe('a\n  \nb')
	})
})
