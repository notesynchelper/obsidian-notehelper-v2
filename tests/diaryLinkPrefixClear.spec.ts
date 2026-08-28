/**
 * 日记双链「前缀清空」验证 —— 模板时代的版本
 *
 * 历史用户关切（旧「双链前缀」单行输入框时代）：
 *   1. 每条日记链接默认前面带 "- "（Markdown 列表项 bullet）。
 *   2. 如果把前缀清空，同步落盘的结果里每条链接前面能不能不带 "- "。
 *   3. 输入框是否「能真的清空」——会不会被代码静默复位回默认 "- "。
 *
 * 「双链前缀」已升级成「日记链接模板」（diaryLinkTemplate，见 diaryLinkTemplate.spec.ts）：
 *   - 旧默认 "- "  ⇔ 模板 `- {{{link}}}`（DEFAULT）
 *   - 旧清空 ""    ⇔ 模板 `{{{link}}}`
 *   - 旧自定义 "> " ⇔ 模板 `> {{{link}}}`
 *   老数据在加载时按 migrateDiaryLinkTemplate 推导，输出逐字节不变。
 *
 * 本 spec 仍直接驱动生产代码 src/sync/DiaryLinkProcessor.ts 的 processAll，
 * 断言写进日记文件的真实行首；数据层断言改成「模板语义 + 旧前缀迁移」。
 * （UI onChange 这一层由 real-obsidian E2E 真机点穿。）
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

import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	OmnivoreSettings,
	DiaryLinkType,
	migrateDiaryLinkTemplate,
} from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

jest.mock('../src/logger', () => ({
	log: jest.fn(),
	logError: jest.fn(),
}))

jest.mock('../src/util', () => {
	const actual = jest.requireActual('../src/util')
	return {
		...actual,
		formatDate: jest.fn((iso: string) => iso.slice(0, 10)),
	}
})

const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const ANCHOR = 'notehelper-links'
const ANCHOR_TAG = `<!-- ${ANCHOR} -->`

interface FakeVault {
	files: Map<string, string>
	read(file: InstanceType<typeof MockTFile>): Promise<string>
	modify(file: InstanceType<typeof MockTFile>, content: string): Promise<void>
}

function buildVault(initial: Record<string, string> = {}): FakeVault {
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

function makeDiaryContent(body: string): string {
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
	const fakeApp = { vault } as any
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	return new DiaryLinkProcessor(fakeApp, settings, stubResolver)
}

function baseItem(overrides: Partial<any> = {}): any {
	return {
		id: 'item-1',
		title: 'Some Article Title',
		content: '<p>some content</p>',
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

/** 取锚点区域内所有含 [[ 的链接行（已 trim） */
function regionLinkLines(content: string): string[] {
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	const region = content.slice(first + ANCHOR_TAG.length, second)
	return region.split('\n').map(l => l.trim()).filter(l => l.includes('[['))
}

/**
 * 模拟老用户：data.json 里只有 diaryLinkPrefix、没有 diaryLinkTemplate，
 * 走 main.ts 加载时的同一套迁移，再跑一次同步。
 */
async function syncOnceWithLegacyPrefix(
	prefix: string,
): Promise<{ lines: string[]; region: string; template: string }> {
	const saved: Partial<OmnivoreSettings> = { diaryLinkPrefix: prefix }
	const loaded = Object.assign({}, DEFAULT_SETTINGS, saved)
	const migrated = migrateDiaryLinkTemplate(saved)
	if (migrated !== undefined) loaded.diaryLinkTemplate = migrated

	const diaryFile = new MockTFile(DIARY_PATH)
	const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })
	const processor = buildProcessor(
		{ diaryLinkPrefix: prefix, diaryLinkTemplate: loaded.diaryLinkTemplate },
		vault,
		diaryFile,
	)
	processor.addLink(baseItem(), 'article-file', undefined)
	await processor.processAll()
	const content = vault.files.get(DIARY_PATH)!
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	return {
		lines: regionLinkLines(content),
		region: content.slice(first + ANCHOR_TAG.length, second),
		template: loaded.diaryLinkTemplate,
	}
}

describe('旧「双链前缀」经迁移后的落盘结果（逐字节同旧版）', () => {
	it('默认前缀 "- " → 模板「- {{{link}}}」→ 每条链接行首是 "- [["', async () => {
		const { lines, template } = await syncOnceWithLegacyPrefix('- ')
		expect(template).toBe(DEFAULT_SETTINGS.diaryLinkTemplate)
		expect(lines.length).toBe(1)
		expect(lines[0].startsWith('- [[')).toBe(true)
		// 完整行（含 id 标记注释）
		expect(lines[0]).toBe('- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->')
	})

	it('清空前缀 "" → 模板「{{{link}}}」→ 行首是 "[["，整段不含 "- [["（真的不带 bullet）', async () => {
		const { lines, region, template } = await syncOnceWithLegacyPrefix('')
		expect(template).toBe('{{{link}}}')
		expect(lines.length).toBe(1)
		expect(lines[0].startsWith('[[')).toBe(true)
		expect(lines[0].startsWith('- ')).toBe(false)
		expect(region.includes('- [[')).toBe(false)
		expect(lines[0]).toBe('[[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->')
	})

	it('自定义前缀 "> " → 模板「> {{{link}}}」→ 行首原样 "> [["', async () => {
		const { lines, template } = await syncOnceWithLegacyPrefix('> ')
		expect(template).toBe('> {{{link}}}')
		expect(lines[0].startsWith('> [[')).toBe(true)
	})

	it('前缀不自动补空格："-"（无空格）→ 行首 "-[["', async () => {
		const { lines } = await syncOnceWithLegacyPrefix('-')
		expect(lines[0].startsWith('-[[')).toBe(true)
	})
})

describe('「输入框能真的清空」——数据层不会把用户值复位成默认', () => {
	it('DEFAULT_SETTINGS：旧字段 diaryLinkPrefix 仍是 "- "，新字段 diaryLinkTemplate 是「- {{{link}}}」', () => {
		expect(DEFAULT_SETTINGS.diaryLinkPrefix).toBe('- ')
		expect(DEFAULT_SETTINGS.diaryLinkTemplate).toBe('- {{{link}}}')
	})

	it('加载合并 Object.assign({}, DEFAULT_SETTINGS, loadedData) 保留用户存的模板（含裸 {{{link}}}）', () => {
		const savedData = { diaryLinkTemplate: '{{{link}}}' }
		const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData)
		expect(loaded.diaryLinkTemplate).toBe('{{{link}}}') // 未被复位成默认
	})

	it('老数据里的空前缀 "" 不会被 Object.assign 复位，迁移后仍推导出裸 {{{link}}}', () => {
		const savedData = { diaryLinkPrefix: '' }
		const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData)
		expect(loaded.diaryLinkPrefix).toBe('')
		expect(migrateDiaryLinkTemplate(savedData)).toBe('{{{link}}}')
	})

	it('saveData/loadData 的 JSON round-trip 保留模板原文（换行 / 空白都不丢）', () => {
		const loaded = Object.assign({}, DEFAULT_SETTINGS, { diaryLinkTemplate: '---\n{{{timeSaved}}}\n{{{link}}}' })
		const roundTripped = JSON.parse(JSON.stringify(loaded))
		expect(Object.prototype.hasOwnProperty.call(roundTripped, 'diaryLinkTemplate')).toBe(true)
		expect(roundTripped.diaryLinkTemplate).toBe('---\n{{{timeSaved}}}\n{{{link}}}')
	})
})
