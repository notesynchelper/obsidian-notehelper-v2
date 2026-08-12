/**
 * 图床接力运行时内容探针
 *
 * 第三方上传插件都是 fire-and-forget（executeCommandById 立刻返回），
 * 我们通过轮询文件内容来判断「相关 wiki 链接是否已改写成 `![](url)`」。
 */
import { App, TFile } from 'obsidian'

/** 图片扩展名列表（所有候选插件并集，iaup 最宽松） */
const IMAGE_EXT_RE = '(?:png|jpe?g|gif|webp|svg|bmp|tiff|avif)'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 宽松正则：匹配 vault 里任何本地 wiki 图片嵌入。
 *
 * ⚠️ 仅作兜底，生产代码不要直接用此正则决定是否接力——否则会把用户自己手写的
 * `![[assets/diagram.png]]` 也当成接力目标，意外把用户资产上传到图床。
 * 真正的接力调度必须用 {@link buildScopedLocalImageRegex}，限定在本插件的
 * imageAttachmentFolder 前缀内。
 */
export const LOCAL_IMAGE_WIKI_REGEX = new RegExp(
  `!\\[\\[[^\\]]+\\.${IMAGE_EXT_RE}(?:\\|[^\\]]*)?\\]\\]`,
  'i',
)

const TEMPLATE_ANY_RE = /{{+[^}]*}}+/g

/**
 * 纯模板段的通配：允许展开成「多段」路径。
 *
 * 典型场景：`{{{date}}}` 配合 `folderDateFormat: 'yyyy/MM/dd'` 会渲染成
 * `2026/04/21`，跨 3 段路径。之前用 `[^/\]]+` 只能匹配单段，会导致
 * relay 对这类 folder 配置完全失效。
 */
const MULTI_SEGMENT_WILDCARD = '(?:[^/\\]]+/)*[^/\\]]+'

/**
 * 某个段是否完全由模板块组成（没有任何 literal 字符）
 *
 * 覆盖：
 *  - `{{{date}}}`（单个模板块）
 *  - `{{{folder}}}{{{date}}}`（相邻多个模板块）
 *  - `{{{a}}} {{{b}}}`（中间只有空白，无有效 literal）
 */
function segmentHasLiteral(segment: string): boolean {
  return segment.replace(TEMPLATE_ANY_RE, '').trim().length > 0
}

/**
 * 把单个路径段翻译成正则片段：
 *  - 纯模板段（`{{{date}}}` / `{{{folder}}}{{{date}}}`）→ {@link MULTI_SEGMENT_WILDCARD}，可跨多段
 *  - 混合段（`img-{{{date}}}`）→ 转义 literal + `[^\]]*?` 占位
 *    template 部分允许跨 `/`（例：`folderDateFormat='yyyy/MM/dd'` 会让
 *    `img-{{{date}}}` 展开成 `img-2026/04/21`）。用非贪婪模式让后面的
 *    literal 锚点/路径分隔符成为边界。
 *  - 纯 literal 段 → 直接转义
 */
function segmentToRegex(segment: string): string | null {
  const t = segment.trim()
  if (t.length === 0) return null
  if (!segmentHasLiteral(t)) return MULTI_SEGMENT_WILDCARD
  return t.split(TEMPLATE_ANY_RE).map(escapeRegex).join('[^\\]]*?')
}

/**
 * 基于 imageAttachmentFolder 设置构造「仅限本插件本地化产物」的正则
 *
 * 策略：把 imageAttachmentFolder 按 `/` 拆成段，逐段翻译：
 *  - 模板段 → `[^/\]]+` 单段通配（不跨 `/`，保持路径结构）
 *  - literal 段 → 严格转义后照原样
 *
 * 这样保留 folder 模板里的**所有** literal 信息，而不是只取第一个静态前缀。
 *
 * 举例：
 *  - `笔记同步助手/images` → `笔记同步助手/images/...`
 *  - `笔记同步助手/images/{{{date}}}` → `笔记同步助手/images/[^/\]]+/...`
 *  - `{{{date}}}/images` → `[^/\]]+/images/...`（用户手写的 `assets/diagram.png` 不会误中）
 *  - `assets/{{{date}}}/images` → `assets/[^/\]]+/images/...`
 *    （关键：`![[assets/manual/diagram.png]]` 不再被当成接力目标）
 *  - `{{{folder}}}/{{{date}}}` 或空 → 无 literal 可锚定，退化到宽松正则
 *    由调用方发出 warning；宁可误匹配也不静默跳过。
 */
export function buildScopedLocalImageRegex(imageAttachmentFolder: string): RegExp {
  const folder = (imageAttachmentFolder || '').trim()
  if (folder.length === 0) return LOCAL_IMAGE_WIKI_REGEX

  const parts = folder
    .split('/')
    .map(segmentToRegex)
    .filter((p): p is string => p !== null)

  if (parts.length === 0) return LOCAL_IMAGE_WIKI_REGEX

  // 至少要有一个非纯模板段；否则全部都是通配，等于无限定
  const hasAnyLiteral = parts.some((p) => p !== MULTI_SEGMENT_WILDCARD)
  if (!hasAnyLiteral) return LOCAL_IMAGE_WIKI_REGEX

  const pathPattern = parts.join('/')
  return new RegExp(
    `!\\[\\[${pathPattern}/[^\\]]+\\.${IMAGE_EXT_RE}(?:\\|[^\\]]*)?\\]\\]`,
    'i',
  )
}

/** 判断 imageAttachmentFolder 是否落入「纯模板」兜底档（调用方据此打 warning） */
export function isPurelyTemplatedFolder(imageAttachmentFolder: string): boolean {
  const folder = (imageAttachmentFolder || '').trim()
  if (folder.length === 0) return true
  const parts = folder
    .split('/')
    .map(segmentToRegex)
    .filter((p): p is string => p !== null)
  if (parts.length === 0) return true
  return !parts.some((p) => p !== MULTI_SEGMENT_WILDCARD)
}

/** 粗判是否「可能已接力成功」的 markdown 图片语法 */
const REMOTE_MD_IMAGE_REGEX = /!\[[^\]]*\]\(https?:\/\/[^)]+\)/i

/** 非 https 路径也算已写回（某些图床返回 CDN 相对路径） */
const ANY_MD_IMAGE_REGEX = /!\[[^\]]*\]\([^)]+\)/i

/**
 * 快速判断一个文件当前是否还有本地化 wiki 图片链接（限定于 scopedRegex 范围）
 * 返回 true 表示本插件本地化产物仍在这个笔记里，值得进入接力调度。
 */
export async function hasLocalImages(
  app: App,
  file: TFile,
  scopedRegex: RegExp,
): Promise<boolean> {
  const content = await app.vault.cachedRead(file)
  return scopedRegex.test(content)
}

/**
 * 抽取内容里所有「本插件本地化产物」的整串（含 `|alias`），限定于 scopedRegex 范围。
 *
 * 用于改名接力：触发 Paste image rename 前记录下这批**原始**链接整串，
 * 之后轮询判断它们是否都已从内容里消失（= 已被改成新名字）。见 {@link waitForRenameDone}。
 */
export function extractScopedLinks(content: string, scopedRegex: RegExp): string[] {
  return content.match(new RegExp(scopedRegex.source, 'gi')) ?? []
}

/**
 * 「本插件本地化刚落下、尚未被改名」的标记：文件名带 `_MD5` 后缀
 * （见 imageProcessor.ts `calculateMD5` → `${hash}_MD5`，落盘文件名 `${hash}_MD5.<ext>`）。
 *
 * 用途：改名接力只应对「新鲜的哈希名」跑，跑完文件名会变成笔记标题名、`_MD5` 消失。
 * 若不加此闸，重复同步一篇已改名的笔记会**再次**触发 batch-rename-all-images——插件对
 * 当前文件去重会让同一张图在 `标题.png` ↔ `标题-1.png` 之间来回抖动。用此标记判定
 * 「还没改名过」，已改名的笔记（无 `_MD5`）直接跳过，杜绝抖动。
 */
export const LOCALIZER_FRESH_MARKER_RE = /_MD5\.[A-Za-z0-9]+(?:\||\]\])/

/** 抽取仍带 `_MD5` 标记（尚未改名）的本地化产物链接整串 */
export function extractFreshLocalizedLinks(content: string, scopedRegex: RegExp): string[] {
  return extractScopedLinks(content, scopedRegex).filter((link) =>
    LOCALIZER_FRESH_MARKER_RE.test(link),
  )
}

export interface WaitForRenameOptions {
  /** 总超时（毫秒） */
  timeoutMs: number
  /**
   * 触发改名前记录的、scoped 范围内的**原始**链接整串（{@link extractScopedLinks}）。
   * 完成判据 = 这批原始链接是否都已从内容里消失。
   */
  originalLinks: string[]
  /** 轮询间隔（毫秒），默认 500 */
  pollMs?: number
  /**
   * 内容连续多少次读取不变即认定「已稳定收敛」（默认 2）。
   * 用于兜住 paste-image-rename 处理不了的扩展名（svg/avif/bmp 等）：这些原始链接
   * 会永久残留、永远不归零，但只要内容稳定就说明改名动作已经做完，best-effort 收工。
   */
  stableReads?: number
  /**
   * 「可被 paste-image-rename 改名」的扩展名正则（默认 {@link RENAMABLE_EXT_RE}，
   * 对应插件源码 `batch.ts` 的 `jpe?g|png|gif|tiff|webp`）。
   *
   * ⚠️ 只有当**残留的原始链接全是「改不了的扩展名」**（svg/avif/bmp 等）时，稳定收敛才
   * 判成功；只要还有一个「本该能改名」的原始链接残留，就绝不因内容暂时不变而误报成功
   * （避免命令慢/缓存没就绪/静默 no-op 时假成功）。这类情况会一直轮询到超时按失败返回。
   */
  renamableExtRe?: RegExp
  /** 时间源，仅用于测试注入 */
  now?: () => number
  /** 睡眠函数，仅用于测试注入 */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Paste image rename 的 `batch-rename-all-images` 只处理这几种扩展名
 * （逐字对应插件源码 `src/batch.ts` / `src/main.ts:240` 的
 * `/jpe?g|png|gif|tiff|webp/i`）。svg/avif/bmp 等不在其列，改名命令会跳过它们，
 * 故这些原始链接永久残留属正常，不能据此判失败。
 */
export const RENAMABLE_EXT_RE = /\.(?:jpe?g|png|gif|tiff|webp)(?:\|[^\]]*)?\]\]$/i

export interface WaitForRenameResult {
  /**
   * 是否进入「已完成」状态。改名**无数据丢失风险**（改没改成，链接始终是有效本地 wiki），
   * 故只有「内容一直在变、原始链接又始终不消失」这种异常才会 ok=false（超时）。
   */
  ok: boolean
  /** 已消失（被成功改名）的原始链接数 */
  renamedCount: number
  /** 仍残留的原始链接数（含无法被改名的扩展名） */
  remainingOriginal: number
  /** 实际等待的毫秒数 */
  elapsedMs: number
}

/**
 * 轮询等待 Paste image rename 把本地化图片改名完毕
 *
 * 与 {@link waitForRelayDone} 的关键区别：改名后链接**仍是本地 wiki**（只是换了名字），
 * 不会像上传那样归零，所以不能用「scoped 本地链接归零」当判据。
 *
 * batch-rename-all-images 是 **fire-and-forget 的异步批量**（executeCommandById 立即返回，
 * 命令内部 `for...await` 逐张改名），而且它会改名当前笔记里的**每一张** embed（不止我们
 * scoped 的那批）。因此判据以**「内容稳定收敛」**为主——内容连续 stableReads 次不变即认定
 * 「批量已停止改动这篇笔记」，避免我们只盯着 scoped 原始链接消失就提前 detach leaf / 触发
 * 下一条命令，而实际批量还在后台改这篇笔记里用户手插的其它图（会打架）。
 *
 * 停机条件（任一满足即退出）：
 * 1. 稳定收敛：内容连续 stableReads 次不变 → 批量已停手。此时若「本该能改名」的原始链接
 *    （renamable 扩展名）都已消失则判成功；否则（命令慢 / 缓存没就绪 / 静默 no-op /
 *    被前置不支持 embed 提前 return）判 ok=false，如实上报「改名未完成」，绝不误报成功。
 * 2. 文件被 rename/delete（vault 里已不存在）→ 视为完成
 * 3. 超时：到达 timeoutMs
 */
export async function waitForRenameDone(
  app: App,
  file: TFile,
  options: WaitForRenameOptions,
): Promise<WaitForRenameResult> {
  const pollMs = options.pollMs ?? 500
  const stableReads = options.stableReads ?? 2
  const renamableExtRe = options.renamableExtRe ?? RENAMABLE_EXT_RE
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const total = options.originalLinks.length
  const startedAt = now()

  if (total === 0) {
    return { ok: true, renamedCount: 0, remainingOriginal: 0, elapsedMs: 0 }
  }

  const countRemaining = (content: string): number =>
    options.originalLinks.filter((link) => content.includes(link)).length
  // 「本该能被 paste-image-rename 改名」的原始链接子集（svg/avif/bmp 等排除在外）。
  // 稳定收敛时只有这批全部消失才判成功，否则如实上报未完成（不误报）。
  const renamableOriginals = options.originalLinks.filter((link) => renamableExtRe.test(link))
  const countRemainingRenamable = (content: string): number =>
    renamableOriginals.filter((link) => content.includes(link)).length

  let lastContent: string | null = null
  let stableCount = 0
  let lastRemaining = total

  while (true) {
    let content: string
    try {
      content = await app.vault.cachedRead(file)
    } catch {
      // 只有当 vault 确认文件已不存在（被改名/删除）才算完成；否则暂时 I/O 错误，继续轮询
      if (!fileStillInVault(app, file)) {
        return {
          ok: true,
          renamedCount: total - lastRemaining,
          remainingOriginal: lastRemaining,
          elapsedMs: now() - startedAt,
        }
      }
      const elapsed = now() - startedAt
      if (elapsed >= options.timeoutMs) {
        return {
          ok: false,
          renamedCount: total - lastRemaining,
          remainingOriginal: lastRemaining,
          elapsedMs: elapsed,
        }
      }
      await sleep(pollMs)
      continue
    }

    const remaining = countRemaining(content)
    lastRemaining = remaining

    // 停机条件 1：内容稳定收敛（批量已停止改动这篇笔记）。
    // 以「稳定」为主判据——而非一见 scoped 原始链接归零就返回——才能在批量还在改这篇笔记里
    // 其它（用户手插、非 scoped）图片时继续等待，避免提前 detach leaf / 触发下一条命令打架。
    //
    // ⚠️ 只有当**残留原始链接全是改不了的扩展名**（svg/avif/bmp，renamable 残留=0）时才据稳定
    // 判成功——这类残留改名命令本就不碰、内容自然一直稳定。若还有「本该能改名」的 png/jpg 残留，
    // **不能**因两次 500ms 没变就判失败：慢磁盘 / 慢 renameFile 可能让批量在两次写入之间静默 >1s。
    // 此时继续轮询到配置的 timeout，给慢批量足够时间，仍不动才超时判 ok=false（不误报、也不误杀）。
    if (lastContent !== null && content === lastContent) {
      stableCount += 1
      if (stableCount >= stableReads && countRemainingRenamable(content) === 0) {
        return {
          ok: true,
          renamedCount: total - remaining,
          remainingOriginal: remaining,
          elapsedMs: now() - startedAt,
        }
      }
    } else {
      stableCount = 0
    }
    lastContent = content

    // 停机条件 3：超时
    const elapsed = now() - startedAt
    if (elapsed >= options.timeoutMs) {
      return {
        ok: false,
        renamedCount: total - remaining,
        remainingOriginal: remaining,
        elapsedMs: elapsed,
      }
    }

    await sleep(pollMs)
  }
}

export interface WaitForRelayOptions {
  /** 总超时（毫秒） */
  timeoutMs: number
  /**
   * 用于识别「本插件本地化产物」的正则。必须由调用方基于
   * imageAttachmentFolder 构造（{@link buildScopedLocalImageRegex}），
   * 避免把用户手写的本地图片嵌入算在内。
   */
  scopedRegex: RegExp
  /** 轮询间隔（毫秒），默认 500 */
  pollMs?: number
  /** 时间源，仅用于测试注入 */
  now?: () => number
  /** 睡眠函数，仅用于测试注入 */
  sleep?: (ms: number) => Promise<void>
}

export interface WaitForRelayResult {
  /** 是否进入「已完成」状态 */
  ok: boolean
  /** 退出时仍残留的本地 wiki 链接数量（粗略计数，供日志） */
  remainingLocal: number
  /** 是否出现了 `![](url)` 形式的远端链接 */
  hasRemote: boolean
  /** 实际等待的毫秒数 */
  elapsedMs: number
}

/** 判断文件是否仍在 vault 里（被第三方插件 rename/delete 时返回 false） */
function fileStillInVault(app: App, file: TFile): boolean {
  const vault = app.vault as unknown as {
    getAbstractFileByPath?: (path: string) => unknown
  }
  // 若 API 不可用（老版本 / 测试 mock 没提供），保守视为存在
  if (typeof vault.getAbstractFileByPath !== 'function') return true
  return vault.getAbstractFileByPath(file.path) != null
}

/**
 * 轮询等待第三方插件把本地 wiki 链接改写成 `![](url)`
 *
 * 停机条件（任一满足即退出）：
 * 1. 成功：`![[.../xxx.jpg]]` 归零——典型 iaup / iutk / ciup 替换后的结果
 * 2. 文件被第三方插件 rename/delete（vault 里已不存在）→ 视为完成
 * 3. 超时：到达 timeoutMs 仍未清零
 * 4. 持续 I/O 错误：文件仍在 vault 但 cachedRead 一直失败 → 视为失败
 *
 * 设计备忘：
 * - 不锁编辑器、不读 editor state。只看文件磁盘内容，避免跟 iaup 的
 *   `MarkdownView.editor.replaceAll` 节奏打架。
 * - 缺远端链接也算成功：若某插件把全部图片替换成 plain markdown（极少），
 *   我们只看「本地 wiki 归零」亦接受（避免永远等不到 `https?://`）。
 * - 不把任意 cachedRead 异常当成功：只有 vault 侧确认文件已消失才算完成，
 *   其他 I/O 错误保留错误语义，超时后走 ok=false，让上层报 Notice。
 */
export async function waitForRelayDone(
  app: App,
  file: TFile,
  options: WaitForRelayOptions,
): Promise<WaitForRelayResult> {
  const pollMs = options.pollMs ?? 500
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const startedAt = now()
  let lastRemainingLocal = Number.MAX_SAFE_INTEGER
  let lastHasRemote = false

  while (true) {
    let content: string
    try {
      content = await app.vault.cachedRead(file)
    } catch {
      // 只有当 vault 确认文件已不存在才算接力完成；
      // 否则就是暂时 I/O 错误，继续轮询，最终超时按失败返回
      if (!fileStillInVault(app, file)) {
        return {
          ok: true,
          remainingLocal: 0,
          hasRemote: lastHasRemote,
          elapsedMs: now() - startedAt,
        }
      }
      const elapsed = now() - startedAt
      if (elapsed >= options.timeoutMs) {
        return {
          ok: false,
          remainingLocal:
            lastRemainingLocal === Number.MAX_SAFE_INTEGER ? -1 : lastRemainingLocal,
          hasRemote: lastHasRemote,
          elapsedMs: elapsed,
        }
      }
      await sleep(pollMs)
      continue
    }

    const remaining = (
      content.match(new RegExp(options.scopedRegex.source, `gi`)) ?? []
    ).length
    const hasRemote = REMOTE_MD_IMAGE_REGEX.test(content)
    const hasAny = ANY_MD_IMAGE_REGEX.test(content)
    lastRemainingLocal = remaining
    lastHasRemote = hasRemote

    // 停机条件 1：本地 wiki 归零
    if (remaining === 0) {
      return {
        ok: true,
        remainingLocal: 0,
        hasRemote: hasRemote || hasAny,
        elapsedMs: now() - startedAt,
      }
    }

    // 停机条件 2：超时
    const elapsed = now() - startedAt
    if (elapsed >= options.timeoutMs) {
      return {
        ok: false,
        remainingLocal: lastRemainingLocal,
        hasRemote: lastHasRemote,
        elapsedMs: elapsed,
      }
    }

    await sleep(pollMs)
  }
}
