jest.mock('obsidian', () => ({ ...jest.requireActual('../src/__mocks__/obsidian'), Plugin: class {}, addIcon: jest.fn() }))
jest.mock('../src/settingsTab', () => ({ OmnivoreSettingTab: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn(), Logger: { setDevMode: jest.fn() } }))
jest.mock('../src/api', () => ({ ...jest.requireActual('../src/api'), getItems: jest.fn(async () => [[], false]), deleteArticleById: jest.fn() }))
import OmnivorePlugin from '../src/main'
import { DEFAULT_SETTINGS, ImageMode } from '../src/settings'
import { getItems, deleteArticleById } from '../src/api'
import { TFile, TFolder } from 'obsidian'
import { logError } from '../src/logger'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
function harness() {
  const plugin = Object.create(OmnivorePlugin.prototype) as any
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  Object.assign(plugin, {
    settings: { ...DEFAULT_SETTINGS, apiKey: 'fixture', imageMode: ImageMode.LOCAL, initialSyncCompleted: true, firstSyncAutoOpened: true, autoUpdateEnabled: false },
    syncing: false,
    app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null }, plugins: { plugins: {} } },
    getDeviceId: () => 'test', refreshFileExplorer: jest.fn(), saveSettings: jest.fn(),
    imageLocalizer: { enqueuePendingRecords: jest.fn(), countQueuedRemoteImages: async () => 1, processQueue: jest.fn(() => slow), getQueueStats: () => ({ queueSize: 1, isProcessing: true }) },
    attachmentLocalizer: { getQueueStats: () => ({ pending: 0 }), processQueue: jest.fn(async () => ({})) },
  })
  return { plugin, release }
}
beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); (global as any).window = global })
afterEach(() => { jest.useRealTimers() })
test.each([true, false])('debug=%s: background localization preserves diagnostic no-delete protection', async debugMode => {
  const { plugin, release } = harness()
  plugin.settings.debugMode = debugMode
  plugin.settings.burnAfterReading = true
  const record = { id: 'history', updatedAt: 'v1', filePath: 'saved.md', originalImageUrls: [], originalAttachmentUrls: [], reason: 'pending', lastTriedAt: '' }
  plugin.settings.pendingBurnDeletes = [record]
  plugin.app.vault.getAbstractFileByPath = () => Object.assign(new TFile(), { path: 'saved.md' })
  plugin.app.vault.read = async () => 'localized content'
  plugin.imageLocalizer.subscribeProgress = () => () => {}
  plugin.attachmentLocalizer.subscribeProgress = () => () => {}
  ;(deleteArticleById as jest.Mock).mockResolvedValue(true)
  await plugin.fetchOmnivore(true)
  release()
  await flush()
  await plugin.backgroundLocalizationPromise
  expect(deleteArticleById).toHaveBeenCalledTimes(debugMode ? 0 : 1)
  expect(plugin.settings.pendingBurnDeletes).toEqual(debugMode ? [record] : [])
})

async function initializedLocalizerHarness(lane: 'image' | 'attachment', tasks: unknown[] = []) {
  const { plugin, release } = harness()
  const renameCallbacks: Array<(file: TFile | TFolder, oldPath: string) => void> = []
  const retries: Array<() => Promise<void>> = []
  const snapshots = new Map<string, unknown>([['pending-attachment-queue.json', { tasks }]])
  plugin.manifest = {}
  plugin.createSidecarJsonPersister = (name: string) => ({
    load: async () => snapshots.get(name) ?? {},
    save: async (snapshot: unknown) => { snapshots.set(name, snapshot) },
  })
  plugin.watchLocalizationRetry = (_store: unknown, run: () => Promise<void>) => { retries.push(run) }
  plugin.registerEvent = jest.fn()
  plugin.app.workspace = { onLayoutReady: jest.fn() }
  plugin.app.vault.on = (_event: string, callback: (file: TFile | TFolder, oldPath: string) => void) => { renameCallbacks.push(callback); return {} }
  if (lane === 'image') {
    plugin.imageLocalizer = null
    await plugin.initializeImageLocalizer()
  } else {
    plugin.attachmentLocalizer = null
    await plugin.initializeAttachmentLocalizer()
  }
  expect(retries).toHaveLength(1)
  return { plugin, release, retries, renameCallbacks, snapshots }
}

test.each(['image', 'attachment'] as const)('%s retry cannot authorize cloud deletion in diagnostic mode, ordinary background fetch still can', async lane => {
  const { plugin, release, retries } = await initializedLocalizerHarness(lane)
  plugin.settings.debugMode = true
  plugin.settings.burnAfterReading = true
  const record = { id: 'history', updatedAt: 'v1', filePath: 'saved.md', originalImageUrls: [], originalAttachmentUrls: [], reason: 'pending', lastTriedAt: '' }
  plugin.settings.pendingBurnDeletes = [record]
  plugin.app.vault.getAbstractFileByPath = () => Object.assign(new TFile(), { path: 'saved.md' })
  plugin.app.vault.read = async () => 'localized content'
  ;(deleteArticleById as jest.Mock).mockResolvedValue(true)
  release()
  await plugin.fetchOmnivore(true)
  await plugin.backgroundLocalizationPromise
  await retries[0]()
  await plugin.backgroundLocalizationPromise
  expect(deleteArticleById).not.toHaveBeenCalled()
  expect(plugin.settings.pendingBurnDeletes).toEqual([record])
  await plugin.fetchOmnivore(false)
  await plugin.backgroundLocalizationPromise
  expect(deleteArticleById).toHaveBeenCalledTimes(1)
  expect(plugin.settings.pendingBurnDeletes).toEqual([])
})

test('parent folder rename preserves nested attachment pending records across restart without touching sibling prefixes', async () => {
  const tasks = ['old/a.md', 'old/nested/b.md', 'old-other/c.md'].map(filePath => ({
    filePath, retryCount: 3, createdAt: 1, nextAttemptAt: 42,
    missingAttachments: { 'https://files.example/a': { firstNotFoundAt: 7, notFoundRounds: 2 } },
  }))
  const { plugin, renameCallbacks, snapshots } = await initializedLocalizerHarness('attachment', tasks)
  const store = plugin.attachmentLocalizer.getPendingStore() as PendingLocalizeStore
  const folder = Object.assign(new TFolder(), { path: 'new' })
  for (const callback of renameCallbacks) callback(folder, 'old')
  expect(store.get('old/a.md')).toBeUndefined()
  expect(store.get('old/nested/b.md')).toBeUndefined()
  expect(store.get('new/a.md')).toMatchObject({ retryCount: 3, nextAttemptAt: 42, missingAttachments: tasks[0].missingAttachments })
  expect(store.get('new/nested/b.md')).toBeDefined()
  expect(store.get('old-other/c.md')).toBeDefined()
  await store.flush()
  const restartedStore = new PendingLocalizeStore({ load: async () => snapshots.get('pending-attachment-queue.json'), save: async () => {} })
  await restartedStore.load()
  const files = new Map(restartedStore.list().map(record => [record.filePath, Object.assign(new TFile(), { path: record.filePath })]))
  const restarted = new AttachmentLocalizer(plugin.app, { attachmentFolder: 'attachments', folderDateFormat: 'yyyy-MM-dd', maxRetries: 0, retryDelay: 0 }, restartedStore)
  expect(restarted.resumePending(path => files.get(path) ?? null)).toBe(3)
  expect(restartedStore.get('new/a.md')).toBeDefined()
  expect(restarted.getQueueStats().pending).toBe(3)
})

test('unload flushes pending attachment state after disposing the worker', () => {
  const { plugin } = harness()
  const flushAttachments = jest.fn(async () => {})
  const disposeAttachments = jest.fn()
  plugin.pendingLocalizationFiles = new Set()
  plugin.imageLocalizer = null
  plugin.attachmentLocalizer = { dispose: disposeAttachments, getPendingStore: () => ({ flush: flushAttachments }) }
  plugin.onunload()
  expect(disposeAttachments).toHaveBeenCalledTimes(1)
  expect(flushAttachments).toHaveBeenCalledTimes(1)
  expect(disposeAttachments.mock.invocationCallOrder[0]).toBeLessThan(flushAttachments.mock.invocationCallOrder[0])
})

test('R8: sync finishes and accepts a second fetch while localization is still in flight', async () => {
  const { plugin, release } = harness()
  let finished = false
  const first = plugin.fetchOmnivore(false).then(() => { finished = true })
  await flush()
  expect(logError).not.toHaveBeenCalled()
  const unlocked = !plugin.syncing && finished
  await plugin.fetchOmnivore(false)
  const fetchCount = (getItems as jest.Mock).mock.calls.length
  release(); await first; await flush()
  expect(unlocked).toBe(true)
  expect(fetchCount).toBe(2)
})
test('U11: watchdog never grants a second writer while the first fetch remains unsettled', async () => {
  const { plugin, release } = harness()
  let finishFetch!: (v: any) => void
  ;(getItems as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishFetch = resolve }))
  const first = plugin.fetchOmnivore(false)
  await flush()
  await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
  const second = plugin.fetchOmnivore(false)
  await flush()
  const countWhileBlocked = (getItems as jest.Mock).mock.calls.length
  finishFetch([[], false]); release(); await first; await second
  expect(countWhileBlocked).toBe(1)
})


test.each(['new-id', 'same-id-new-version'])('U11: background delete preserves %s queued by a later sync while deletion awaits the server', async mode => {
  const { plugin } = harness()
  const firstRecord = { id: 'a', updatedAt: '2026-10-07T00:00:00Z', filePath: 'a.md', originalImageUrls: [], originalAttachmentUrls: [], reason: 'pending', lastTriedAt: '' }
  const nextRecord = { ...firstRecord, id: mode === 'new-id' ? 'b' : 'a', updatedAt: '2026-10-07T00:01:00Z' }
  plugin.settings.burnAfterReading = true
  plugin.settings.pendingBurnDeletes = [firstRecord]
  plugin.app.vault.getAbstractFileByPath = () => Object.assign(new TFile(), { path: 'a.md' })
  plugin.app.vault.read = async () => 'complete note'
  let finishDelete!: (ok: boolean) => void
  ;(deleteArticleById as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishDelete = resolve }))
  const deletion = plugin.runBurnDeletePhase([])
  await flush()
  plugin.settings.pendingBurnDeletes = mode === 'new-id' ? [firstRecord, nextRecord] : [nextRecord]
  finishDelete(true)
  await deletion
  expect(plugin.settings.pendingBurnDeletes).toContainEqual(nextRecord)
})

async function renameHandler(plugin: any) {
  let handler: ((file: TFile | TFolder, oldPath: string) => Promise<void>) | undefined
  plugin.loadEssentialSettings = jest.fn()
  plugin.registerCoreComponents = jest.fn()
  plugin.registerEvent = jest.fn()
  plugin.app.workspace = { onLayoutReady: jest.fn() }
  plugin.app.vault.on = jest.fn((event, callback) => { if (event === 'rename') handler = callback; return {} })
  await plugin.onload()
  expect(handler).toBeDefined()
  return handler!
}

test.each([false, true])('U11: pending burn follows a real file/folder rename and persists (folder=%s)', async folder => {
  const { plugin } = harness()
  const record = { id: 'a', updatedAt: 'v1', filePath: 'old/a.md', originalImageUrls: [], originalAttachmentUrls: [], reason: 'pending', lastTriedAt: '' }
  const unrelated = { ...record, id: 'b', filePath: 'old-other/b.md' }
  plugin.settings.pendingBurnDeletes = [record, unrelated]
  const rename = await renameHandler(plugin)
  const file = Object.assign(folder ? new TFolder() : new TFile(), { path: folder ? 'new' : 'new/a.md' })
  await rename(file, folder ? 'old' : 'old/a.md')
  expect(record.filePath).toBe('new/a.md')
  expect(unrelated.filePath).toBe('old-other/b.md')
  expect(plugin.saveSettings).toHaveBeenCalledWith(true)
})

test('U11: renaming during cloud deletion does not resurrect or delete the same version twice', async () => {
  const { plugin } = harness()
  const record = { id: 'a', updatedAt: 'v1', filePath: 'old.md', originalImageUrls: [], originalAttachmentUrls: [], reason: 'pending', lastTriedAt: '' }
  plugin.settings.burnAfterReading = true
  plugin.settings.pendingBurnDeletes = [record]
  const file = Object.assign(new TFile(), { path: 'old.md' })
  plugin.app.vault.getAbstractFileByPath = () => file
  plugin.app.vault.read = async () => 'localized'
  const rename = await renameHandler(plugin)
  let release!: (ok: boolean) => void
  ;(deleteArticleById as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const first = plugin.runBurnDeletePhase([])
  await flush()
  file.path = 'new.md'
  await rename(file, 'old.md')
  release(true); await first
  await plugin.runBurnDeletePhase([])
  expect(plugin.settings.pendingBurnDeletes).toEqual([])
  expect(deleteArticleById).toHaveBeenCalledTimes(1)
})
