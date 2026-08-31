/**
 * 链接安全字符：文件名 / 锚点 / 日记链接三层的处理规则
 *
 * 线上工单（2026-08-28，企微用户「大峘韦传稳」）：
 *   「发现一个新问题，文章的链接打开没有连上文章本身，反而创建了一个空文件」
 *   复现文章 = 《科技爱好者周刊#410：你需要知道的 AI 三种机制》
 *
 * 根因：`#` 在磁盘上合法、文件名清洗不挡它，于是原样进了文件名；而 Obsidian 的
 * wikilink 和 markdown 内部链接**共用**「按第一个 `#` 结束文件路径」这一步 ——
 * wikilink 没有任何转义机制，markdown 那边用的是 URI 整体级解码、按规范不还原 `%23`。
 * 两条路都死 → 目标变成不存在的「科技爱好者周刊」→ 点击即新建空笔记。
 *
 * 真机穷举后的最终分工（Obsidian 1.12/1.13，
 * probe-link-charset-matrix2.js / probe-anchor-charset-matrix.js）：
 *   文件名层：只有 `#` 必须换（换全角＃），原标题写进 aliases 保住搜索
 *   链接层  ：只有成对 `[[` / `]]` 需要改写成 markdown 链接
 *   锚点层  ：`#` / `|` / 成对方括号 换全角 + 统一 NFC
 * 其余字符（`^ ( ) { } % & ' ! @ $ + = ~ ` . * 单个[ ]`、emoji、零宽、NBSP、NFD…）实测全安全。
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
		parseYaml: jest.requireActual('js-yaml').load,
		stringifyYaml: jest.requireActual('js-yaml').dump,
	}
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
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../src/util'
import { generateMessageHeading, sanitizeAnchorText } from '../src/settings/template'

const MockTFile = MockTFileType as unknown as new (path: string) => { path: string; basename: string }
const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const ISO = '2024-01-15T09:00:00.000Z'
const HASH_TITLE = '科技爱好者周刊#410：你需要知道的 AI 三种机制'
const SAFE_TITLE = '科技爱好者周刊＃410：你需要知道的 AI 三种机制'

function baseItem(id: string, title: string, content: string): any {
	return {
		id, title, content, savedAt: ISO, updatedAt: ISO, createdAt: ISO,
		url: '', slug: '', author: null, siteName: '', siteIcon: null, publishedAt: null, readAt: null,
		isArchived: false, contentReader: 'WEB', pageType: 'ARTICLE', state: 'SUCCEEDED', description: null,
		labels: [], highlights: [], image: null, words: null, wordsCount: null,
		readingProgressTopPercent: 0, readingProgressPercent: 0, readingProgressAnchorIndex: 0,
	}
}
const article = (id: string, title: string) => baseItem(id, title, '正文')
const message = (id: string, text: string) => baseItem(id, `同步助手_20240115_${id}`, text)

function makeApp(seed = '# 日记\n') {
	const files = new Map<string, string>([[DIARY_PATH, seed]])
	const app: any = {
		vault: {
			async read(f: { path: string }) { return files.get(f.path) ?? '' },
			async modify(f: { path: string }, c: string) { files.set(f.path, c) },
			getAbstractFileByPath: (p: string) => new MockTFile(p),
		},
		metadataCache: {
			fileToLinktext: (f: { path: string }) => f.path.replace(/^.*\//, '').replace(/\.md$/, ''),
		},
	}
	return { app, files }
}

async function run(app: any, linkType: DiaryLinkType, add: (p: DiaryLinkProcessor) => void) {
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryLinkType: linkType,
		diaryWritePosition: DiaryWritePosition.BOTTOM,
	}
	const diaryFile = new MockTFile(DIARY_PATH)
	const resolver = { resolve: jest.fn(async () => ({ file: diaryFile })) } as unknown as DailyNoteResolver
	const p = new DiaryLinkProcessor(app, settings, resolver)
	add(p)
	return p.processAll()
}

const ARTICLES = DiaryLinkType.ARTICLES
const MESSAGES = DiaryLinkType.MESSAGES

describe('文件名层：只把 # 换成全角，别的一个都不动', () => {
	it('标题含 # → 落盘文件名用全角＃（wikilink 才指得回来）', () => {
		expect(replaceIllegalCharsFile(HASH_TITLE)).toBe(SAFE_TITLE)
	})

	it('文件夹名同样换 —— 路径里任何一段带 # 都会把整条链接截断', () => {
		expect(replaceIllegalCharsFolder('2024/技术#笔记')).toBe('2024/技术＃笔记')
	})

	it('实测安全的字符一律保持原样，不许扩大清洗范围', () => {
		// ⚠️ 不含 * —— 它早就在 ILLEGAL_CHAR_REGEX_FILE 里（Windows 非法），与本次改动无关
		const keep = "标题^带(括号){花括号}100%&符号'引号!叹号@at$元+加=等~波浪`反引号.点[单括]"
		expect(replaceIllegalCharsFile(keep)).toBe(keep)
	})

	it('文件系统非法字符照旧换成连字符（无回归）', () => {
		expect(replaceIllegalCharsFile('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j')
	})
})

describe('锚点层：# / | / 成对方括号 换全角，其余不动', () => {
	it('以 #标签 开头的摘要（转发附言写标签时的典型形状）', () => {
		expect(sanitizeAnchorText('#太行 #项目 围挡')).toBe('＃太行 ＃项目 围挡')
	})

	it('竖线会把锚点截断 → 换全角', () => {
		expect(sanitizeAnchorText('A|B 两方案')).toBe('A｜B 两方案')
	})

	it('成对方括号会让 wikilink 词法提前结束 → 换全角', () => {
		expect(sanitizeAnchorText('标题[[内嵌]]了')).toBe('标题［［内嵌］］了')
	})

	it('实测安全的字符不许动（* ` _ ~~ ^ 单个方括号 冒号 emoji）', () => {
		const keep = '重点*强调*了`代码`_下划_~~删~~^插入[单括]结论：🎉'
		expect(sanitizeAnchorText(keep)).toBe(keep)
	})

	it('统一 NFC —— 标题缓存与链接锚点两边规范化档位不同会「看着一样却对不上」', () => {
		const nfd = 'café 咖啡'
		expect(sanitizeAnchorText(nfd)).toBe('café 咖啡')
	})

	it('消息摘要（= 锚点 = 合并文件里的标题行）走同一份清洗', () => {
		expect(generateMessageHeading(message('m1', '#太行 #项目 围挡的事'))).toBe('＃太行 ＃项目 围挡')
	})
})

describe('日记链接层：默认 wikilink，只有成对方括号才降级 markdown', () => {
	it('普通标题 → 裸 [[…|…]]', async () => {
		const { app, files } = makeApp()
		const plain = '一篇正常的文章'
		await run(app, ARTICLES, (p) => p.addLink(article('a1', plain), plain, undefined, `Articles/${plain}.md`))
		const body = files.get(DIARY_PATH)!
		expect(body).toContain(`[[${plain}|${plain}]]`)
		expect(body).not.toContain('](')
	})

	it('清洗后的全角＃标题 → 照旧 wikilink（这才是修复后的常态）', async () => {
		const { app, files } = makeApp()
		await run(app, ARTICLES, (p) => p.addLink(article('a2', SAFE_TITLE), SAFE_TITLE, undefined, `Articles/${SAFE_TITLE}.md`))
		expect(files.get(DIARY_PATH)!).toContain(`[[${SAFE_TITLE}|${SAFE_TITLE}]]`)
	})

	it('目标含成对 [[ ]] → 改写 markdown 链接，方括号百分号编码', async () => {
		const { app, files } = makeApp()
		const t = '标题[[内嵌]]了'
		await run(app, ARTICLES, (p) => p.addLink(article('a3', t), t, undefined, `Articles/${t}.md`))
		const body = files.get(DIARY_PATH)!
		expect(body).not.toContain('[[Articles')
		expect(body).toContain('(标题%5B%5B内嵌%5D%5D了.md)')
	})

	it('markdown 形态下显示文字里的方括号要转义，不能撑破 [文字](链接)', async () => {
		const { app, files } = makeApp()
		const t = '标题[[内嵌]]了'
		await run(app, ARTICLES, (p) => p.addLink(article('a4', t), t, undefined, `Articles/${t}.md`))
		const md = files.get(DIARY_PATH)!.match(/\[([^\]]*)\]\(([^)]*)\)/)
		expect(md).not.toBeNull()
		expect(md![1]).toBe('标题［［内嵌］］了')
	})

	it('% 与 & 在 markdown href 里必须编码（否则被 URI 解码 / 实体还原指错文件）', async () => {
		const { app, files } = makeApp()
		const t = '[[A]]&B 折扣100%'
		await run(app, ARTICLES, (p) => p.addLink(article('a5', t), t, undefined, `Articles/${t}.md`))
		const body = files.get(DIARY_PATH)!
		expect(body).toContain('%26')
		expect(body).toContain('%25')
	})

	it('消息锚点照旧走 wikilink（锚点已在源头清洗，不需要降级）', async () => {
		const { app, files } = makeApp()
		const target = '同步助手_20240115'
		await run(app, MESSAGES, (p) =>
			p.addLink(message('m2', '今天开会讨论了围挡'), target, '今天开会讨论了', `journals/${target}.md`))
		expect(files.get(DIARY_PATH)!).toContain(`[[${target}#今天开会讨论了|`)
	})
})

describe('换形态后仍要认得出旧的 [[…]]，不重复插入', () => {
	const t = '标题[[内嵌]]了'

	it('日记里已有旧版裸 [[…]] 行（无 id 标记）→ 再同步不再插一条', async () => {
		const legacy = `# 日记\n- [[${t}|标题［［内嵌］］了]]\n`
		const { app, files } = makeApp(legacy)
		await run(app, ARTICLES, (p) => p.addLink(article('a1', t), t, undefined, `Articles/${t}.md`))
		expect(files.get(DIARY_PATH)!).toBe(legacy)
	})

	it('日记里已有新版 markdown 形态 → 再同步也不重复', async () => {
		const { app, files } = makeApp()
		await run(app, ARTICLES, (p) => p.addLink(article('a1', t), t, undefined, `Articles/${t}.md`))
		const once = files.get(DIARY_PATH)!
		await run(app, ARTICLES, (p) => p.addLink(article('a1', t), t, undefined, `Articles/${t}.md`))
		expect(files.get(DIARY_PATH)!).toBe(once)
	})
})
