/**
 * 日记链接的目标写法：同名文件时必须带路径（真机 E2E 2026-08-28 抓到的 bug）
 *
 * 日记 `Daily Notes/2024-01-15.md` 与消息合并文件 `journals/2024-01-15.md` 同名，
 * 旧版写裸 `[[2024-01-15#锚点]]` → Obsidian 从日记出发解析成日记自己，点了跳不到消息。
 * 现在让 Obsidian 的 `metadataCache.fileToLinktext(file, 日记路径)` 给出唯一定位的最短写法。
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
	return { App: jest.fn(), TFile: MockTFile, normalizePath: (p: string) => p, Notice: jest.fn() }
})
jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))

import { TFile as MockTFileType } from 'obsidian'
import { DEFAULT_SETTINGS, OmnivoreSettings, DiaryLinkType, DiaryWritePosition } from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

const MockTFile = MockTFileType as unknown as new (path: string) => { path: string; basename: string }
const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const JOURNAL_PATH = 'journals/2024-01-15.md'

function message(id: string, text: string): any {
	const iso = '2024-01-15T09:00:00.000Z'
	return {
		id, title: `同步助手_20240115_${id}`, content: text, savedAt: iso, updatedAt: iso, createdAt: iso,
		url: '', slug: '', author: null, siteName: '企业微信', siteIcon: null, publishedAt: null, readAt: null,
		isArchived: false, contentReader: 'WEB', pageType: 'ARTICLE', state: 'SUCCEEDED', description: null,
		labels: [], highlights: [], image: null, words: null, wordsCount: null,
		readingProgressTopPercent: 0, readingProgressPercent: 0, readingProgressAnchorIndex: 0,
	}
}

function makeApp(opts: { linktext?: (file: { path: string }, source: string) => string; noApi?: boolean }) {
	const files = new Map<string, string>([[DIARY_PATH, '# 日记\n']])
	const known = new Map<string, unknown>([[JOURNAL_PATH, new MockTFile(JOURNAL_PATH)]])
	const app: any = {
		vault: {
			async read(f: { path: string }) { return files.get(f.path) ?? '' },
			async modify(f: { path: string }, c: string) { files.set(f.path, c) },
		},
	}
	if (!opts.noApi) {
		app.vault.getAbstractFileByPath = (p: string) => known.get(p) ?? null
		app.metadataCache = { fileToLinktext: jest.fn(opts.linktext ?? ((f: { path: string }) => f.path.replace(/\.md$/, ''))) }
	}
	return { app, files }
}

async function run(app: any, targetPath: string | undefined, targetName = '2024-01-15') {
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryLinkType: DiaryLinkType.MESSAGES,
		diaryWritePosition: DiaryWritePosition.BOTTOM,
	}
	const diaryFile = new MockTFile(DIARY_PATH)
	const resolver = { resolve: jest.fn(async () => ({ file: diaryFile })) } as unknown as DailyNoteResolver
	const p = new DiaryLinkProcessor(app, settings, resolver)
	p.addLink(message('m1', '这个链接的设置最好能像消息模板设置一样'), targetName, '这个链接的设置最好能', targetPath)
	await p.processAll()
}

describe('日记链接目标：交给 Obsidian 算唯一写法', () => {
	it('同名文件 → 链接带路径 [[journals/2024-01-15#锚点|…]]，且是按日记路径问的', async () => {
		const { app, files } = makeApp({})
		await run(app, JOURNAL_PATH)
		expect(files.get(DIARY_PATH)).toContain('[[journals/2024-01-15#这个链接的设置最好能|这个链接的设置最好能像消息模板设置一样]]')
		expect(app.metadataCache.fileToLinktext).toHaveBeenCalledWith(expect.objectContaining({ path: JOURNAL_PATH }), DIARY_PATH, true)
	})

	it('Obsidian 认为不同名（给出短写法）→ 照旧裸文件名', async () => {
		const { app, files } = makeApp({ linktext: () => '2024-01-15' })
		await run(app, JOURNAL_PATH)
		expect(files.get(DIARY_PATH)).toContain('[[2024-01-15#这个链接的设置最好能|')
		expect(files.get(DIARY_PATH)).not.toContain('journals/')
	})

	it('没有 targetPath（旧调用形状）→ 退回文件名，与旧版同形（同名会被当自链接跳过，故用不同名）', async () => {
		const { app, files } = makeApp({})
		await run(app, undefined, '消息合并')
		expect(files.get(DIARY_PATH)).toContain('[[消息合并#这个链接的设置最好能|')
		expect(app.metadataCache.fileToLinktext).not.toHaveBeenCalled()
	})

	it('宿主没有 fileToLinktext / getAbstractFileByPath（mock 环境）→ 退回文件名', async () => {
		const { app, files } = makeApp({ noApi: true })
		await run(app, JOURNAL_PATH)
		expect(files.get(DIARY_PATH)).toContain('[[2024-01-15#这个链接的设置最好能|')
	})

	it('fileToLinktext 抛错 → 退回文件名，不丢链接', async () => {
		const { app, files } = makeApp({ linktext: () => { throw new Error('boom') } })
		await run(app, JOURNAL_PATH)
		expect(files.get(DIARY_PATH)).toContain('[[2024-01-15#这个链接的设置最好能|')
	})
})

it('independent messages link to the whole note with clean title, merged links retain anchors', async () => {
 const { app, files } = makeApp({})
 const settings = {...DEFAULT_SETTINGS, enableDiaryLinks:true, messageSeparateEnabled:true, diaryWritePosition:DiaryWritePosition.BOTTOM}
 const resolver = {resolve:jest.fn(async()=>({file:new MockTFile(DIARY_PATH)}))} as unknown as DailyNoteResolver
 const p = new DiaryLinkProcessor(app,settings,resolver)
 p.addLink({...message('clean','正文摘要'),title:'干净标题',rawTitle:'同步助手_20240115_干净标题_文本'},'干净标题',undefined,'Messages/干净标题.md')
 await p.processAll()
 expect(files.get(DIARY_PATH)).toContain('[[干净标题|干净标题]]')
 expect(files.get(DIARY_PATH)).not.toContain('#正文摘要')
})
