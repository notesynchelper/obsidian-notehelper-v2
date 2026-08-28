/**
 * 日记链接模板（diaryLinkTemplate）—— 取代旧「双链前缀」（diaryLinkPrefix）
 *
 * 用户诉求（企微工单 2026-08-16~27，问题 6）：日记链接只能配一个单行前缀，
 * 想要「分隔线 + 时间 + 链接」这种多行样式。于是把前缀升级成模板：
 *   - 每条链接按模板渲染，view 里有 link / title / target / anchor / heading /
 *     isMessage / dateSaved / timeSaved / timeSavedShort / savedAt + 文章模板的内置函数
 *   - 缺省 / 迁移后必须与旧「前缀 + 链接」逐字节同输出（零回归）
 *   - 模板坏了回落默认，绝不让整批链接丢
 *   - 串匹配兜底去重看裸 [[…]]，旧版前缀形态与无 id 模式都能认出来
 *
 * 本 spec 直接驱动生产代码 src/sync/DiaryLinkProcessor.ts 的 processAll，
 * 断言写进日记文件的真实内容；迁移逻辑用 migrateDiaryLinkTemplate 纯函数钉住。
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
	DEFAULT_DIARY_LINK_TEMPLATE,
	OmnivoreSettings,
	DiaryLinkType,
	DiaryWritePosition,
	migrateDiaryLinkTemplate,
} from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'
import { logError } from '../src/logger'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const ANCHOR = 'notehelper-links'
const ANCHOR_TAG = `<!-- ${ANCHOR} -->`

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

function makeDiaryContent(body = ''): string {
	return `# 2024-01-15\n\n${ANCHOR_TAG}\n${body}\n${ANCHOR_TAG}\n`
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
		...overrides,
	}
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	return new DiaryLinkProcessor({ vault } as never, settings, stubResolver)
}

function baseItem(overrides: Partial<any> = {}): any {
	return {
		id: 'item-1',
		title: 'Some Article Title',
		content: '<p>some content</p>',
		// jest 固定 TZ=UTC（jest.config.js），timeSaved 就是 10:30:00
		savedAt: '2024-01-15T10:30:00.000Z',
		updatedAt: '2024-01-15T10:30:00.000Z',
		createdAt: '2024-01-15T10:30:00.000Z',
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
		title: '同步助手_20240115_001_文本', // 触发 isWeChatMessage
		content: '<p>今天的会议纪要已整理</p>',
		...overrides,
	})
}

/** 锚点区域原文 */
function region(content: string): string {
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	return content.slice(first + ANCHOR_TAG.length, second)
}

/** 一次同步：按模板写一条文章链接，返回整份日记 */
async function syncOnce(
	overrides: Partial<OmnivoreSettings>,
	item: any = baseItem(),
	anchor?: string,
	initial = makeDiaryContent(),
): Promise<string> {
	const diaryFile = new MockTFile(DIARY_PATH)
	const vault = buildVault({ [DIARY_PATH]: initial })
	const processor = buildProcessor(overrides, vault, diaryFile)
	processor.addLink(item, 'article-file', anchor)
	await processor.processAll()
	return vault.files.get(DIARY_PATH)!
}

beforeEach(() => {
	;(logError as jest.Mock).mockClear()
})

describe('日记链接模板：默认值 = 旧「双链前缀」行为（零回归）', () => {
	it('DEFAULT_SETTINGS.diaryLinkTemplate 就是「- {{{link}}}」；旧字段 diaryLinkPrefix 仍保留为 "- "', () => {
		expect(DEFAULT_DIARY_LINK_TEMPLATE).toBe('- {{{link}}}')
		expect(DEFAULT_SETTINGS.diaryLinkTemplate).toBe('- {{{link}}}')
		expect(DEFAULT_SETTINGS.diaryLinkPrefix).toBe('- ')
	})

	it('缺省模板下的落盘结果与旧版逐字节一致（含 id 标记，前后各一个换行）', async () => {
		const after = await syncOnce({})
		expect(after).toBe(
			`# 2024-01-15\n\n${ANCHOR_TAG}\n` +
				'- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n' +
				`\n${ANCHOR_TAG}\n`,
		)
	})

	it('旧「清空前缀」语义 = 模板「{{{link}}}」→ 行首直接是 [[', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '{{{link}}}' })
		const lines = region(after).split('\n').filter((l) => l.includes('[['))
		expect(lines).toEqual(['[[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->'])
		expect(region(after).includes('- [[')).toBe(false)
	})

	it('旧「自定义前缀 "> "」语义 = 模板「> {{{link}}}」', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '> {{{link}}}' })
		expect(region(after)).toContain('\n> [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n')
	})

	it('旧字段 diaryLinkPrefix 不再参与渲染（模板才是唯一真相）', async () => {
		const after = await syncOnce({ diaryLinkPrefix: '## ', diaryLinkTemplate: '- {{{link}}}' })
		expect(region(after)).toContain('\n- [[article-file|')
		expect(region(after)).not.toContain('## [[')
	})

	it('空模板按默认处理（设置页留空 = 恢复默认）', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '' })
		expect(region(after)).toContain('\n- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n')
	})

	it('模板末尾的空格被去掉；末尾多留的空行原样落盘（后面空一行由模板决定）', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '- {{{link}}}  \n\n' })
		expect(after).toBe(
			`# 2024-01-15\n\n${ANCHOR_TAG}\n` +
				'- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n' +
				`\n\n${ANCHOR_TAG}\n`,
		)
	})
})

describe('日记链接模板：变量', () => {
	it('link / title / target：文章链接无锚点，title 是截断后的显示文字', async () => {
		const after = await syncOnce({
			diaryLinkTemplate: '{{{target}}} | {{{title}}} | {{{link}}}',
			diaryLinkMaxLength: 8,
		})
		expect(region(after)).toContain(
			'article-file | Some Ar… | [[article-file|Some Ar…]] <!-- notehelper:id:item-1 -->',
		)
	})

	it('dateSaved 按 dateSavedFormat；timeSaved / timeSavedShort 只取时分秒 / 时分', async () => {
		const after = await syncOnce({
			diaryLinkTemplate: '{{{dateSaved}}} | {{{timeSaved}}} | {{{timeSavedShort}}} | {{{link}}}',
			dateSavedFormat: 'yyyy/MM/dd HH:mm',
		})
		expect(region(after)).toContain('2024/01/15 10:30 | 10:30:00 | 10:30 | [[article-file|')
	})

	it('savedAt 是原始时间串；内置函数 formatDate / upperCase 在这里同样可用', async () => {
		const after = await syncOnce({
			diaryLinkTemplate:
				'{{#formatDate}}{{savedAt}},HH:mm{{/formatDate}} {{#upperCase}}{{title}}{{/upperCase}} {{{link}}}',
		})
		expect(region(after)).toContain('10:30 SOME ARTICLE TITLE [[article-file|Some Article Title]]')
	})

	it('消息：anchor 是锚点标题、heading 是消息摘要、isMessage 区块只对消息输出', async () => {
		const after = await syncOnce(
			{
				diaryLinkTemplate:
					'{{#isMessage}}消息 {{{anchor}}} / {{{heading}}} {{/isMessage}}{{^isMessage}}文章 {{/isMessage}}{{{link}}}',
			},
			wechatItem(),
			'今天的会议纪要已',
		)
		expect(region(after)).toContain(
			'消息 今天的会议纪要已 / 今天的会议纪要已整理 [[article-file#今天的会议纪要已|今天的会议纪要已整理]]',
		)
	})

	it('文章：anchor / heading 为空串，isMessage 反向区块输出', async () => {
		const after = await syncOnce({
			diaryLinkTemplate:
				'{{#isMessage}}消息{{/isMessage}}{{^isMessage}}文章{{/isMessage}}[{{{anchor}}}][{{{heading}}}] {{{link}}}',
		})
		expect(region(after)).toContain('文章[][] [[article-file|Some Article Title]]')
	})

	it('Templater 标签 <% %> 原样保留、不被当模板语法吃掉', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '<% tp.date.now("HH:mm") %> {{{link}}}' })
		expect(region(after)).toContain('<% tp.date.now("HH:mm") %> [[article-file|Some Article Title]]')
	})

	it('多行模板：三行原样落盘，id 标记挂在最后一行末尾', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '---\n{{{timeSaved}}}\n{{{link}}}' })
		expect(after).toContain(
			'---\n10:30:00\n[[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->',
		)
	})

	it('「日记不写 id」开着时模板输出不带标记', async () => {
		const after = await syncOnce({
			diaryLinkTemplate: '{{{timeSaved}}} {{{link}}}',
			disableDiaryLinkMarkers: true,
			syncAt: '',
			deviceSyncCursors: {},
		})
		expect(region(after)).toContain('\n10:30:00 [[article-file|Some Article Title]]\n')
		expect(after).not.toContain('notehelper:id')
	})
})

describe('日记链接模板：坏模板回落默认，绝不让整批链接丢', () => {
	it('语法错误（未闭合区块）→ 回落「- {{{link}}}」并记一次错误', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '{{#isMessage}}{{{link}}}' })
		expect(region(after)).toContain('\n- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n')
		expect(logError).toHaveBeenCalled()
	})

	it('渲染成空（区块把整条吞掉）→ 同样回落默认', async () => {
		const after = await syncOnce({ diaryLinkTemplate: '{{#isMessage}}{{{link}}}{{/isMessage}}' })
		expect(region(after)).toContain('\n- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n')
		expect(logError).toHaveBeenCalled()
	})

	it('模板正常时不记错误', async () => {
		await syncOnce({ diaryLinkTemplate: '- {{{link}}}' })
		expect(logError).not.toHaveBeenCalled()
	})
})

describe('日记链接模板：串匹配兜底看裸 [[…]]', () => {
	it('日记里已有旧版前缀形态（无 id 标记）→ 换成模板后不再写第二条', async () => {
		const after = await syncOnce(
			{ diaryLinkTemplate: '{{{timeSaved}}} {{{link}}}' },
			baseItem(),
			undefined,
			makeDiaryContent('- [[article-file|Some Article Title]]'),
		)
		expect(after.split('[[article-file|Some Article Title]]').length - 1).toBe(1)
	})

	it('日记里已有裸链接 → 默认模板也不重复', async () => {
		const after = await syncOnce(
			{},
			baseItem(),
			undefined,
			makeDiaryContent('[[article-file|Some Article Title]]'),
		)
		expect(after.split('[[article-file|Some Article Title]]').length - 1).toBe(1)
	})

	it('同一条二次同步（有 id 标记）在多行模板下也不重复', async () => {
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
		const opts = { diaryLinkTemplate: '---\n{{{timeSaved}}}\n{{{link}}}', diaryWritePosition: DiaryWritePosition.BOTTOM }

		let p = buildProcessor(opts, vault, diaryFile)
		p.addLink(baseItem(), 'article-file', undefined)
		await p.processAll()
		const afterFirst = vault.files.get(DIARY_PATH)!

		p = buildProcessor(opts, vault, diaryFile)
		p.addLink(baseItem(), 'article-file', undefined)
		await p.processAll()

		expect(vault.files.get(DIARY_PATH)).toBe(afterFirst)
	})
})

describe('迁移：旧「双链前缀」→ 日记链接模板（migrateDiaryLinkTemplate）', () => {
	it('没有存过任何数据（首次安装）→ 不迁移，用默认', () => {
		expect(migrateDiaryLinkTemplate(null)).toBeUndefined()
		expect(migrateDiaryLinkTemplate(undefined)).toBeUndefined()
	})

	it('老数据没有 diaryLinkTemplate 键、也没改过前缀 → 「- {{{link}}}」', () => {
		expect(migrateDiaryLinkTemplate({ enableDiaryLinks: true })).toBe('- {{{link}}}')
	})

	it('老数据清空过前缀 → 「{{{link}}}」（与旧输出逐字节一致）', () => {
		expect(migrateDiaryLinkTemplate({ diaryLinkPrefix: '' })).toBe('{{{link}}}')
	})

	it('老数据自定义前缀 "> " / "-" → 原样拼到链接前', () => {
		expect(migrateDiaryLinkTemplate({ diaryLinkPrefix: '> ' })).toBe('> {{{link}}}')
		expect(migrateDiaryLinkTemplate({ diaryLinkPrefix: '-' })).toBe('-{{{link}}}')
	})

	it('已有 diaryLinkTemplate 键（哪怕是空串）→ 不再按前缀推导，尊重用户存的值', () => {
		expect(migrateDiaryLinkTemplate({ diaryLinkTemplate: '{{{timeSaved}}} {{{link}}}', diaryLinkPrefix: '' })).toBeUndefined()
		expect(migrateDiaryLinkTemplate({ diaryLinkTemplate: '', diaryLinkPrefix: '> ' })).toBeUndefined()
	})

	it('加载合并 Object.assign + 迁移 → 老「空前缀」用户同步结果仍是裸 [[…]]', async () => {
		const saved = { diaryLinkPrefix: '' } as Partial<OmnivoreSettings>
		const loaded = Object.assign({}, DEFAULT_SETTINGS, saved)
		const migrated = migrateDiaryLinkTemplate(saved)
		if (migrated !== undefined) loaded.diaryLinkTemplate = migrated

		const after = await syncOnce({ diaryLinkTemplate: loaded.diaryLinkTemplate })
		expect(region(after)).toContain('\n[[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->\n')
		expect(region(after).includes('- [[')).toBe(false)
	})
})
