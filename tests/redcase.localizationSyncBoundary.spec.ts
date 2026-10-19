jest.mock('obsidian', () => ({ ...jest.requireActual('../src/__mocks__/obsidian'), Plugin: class {}, addIcon: jest.fn() }))
jest.mock('../src/settingsTab', () => ({ OmnivoreSettingTab: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn(), Logger: { setDevMode: jest.fn() } }))
jest.mock('../src/api', () => ({ ...jest.requireActual('../src/api'), getItems: jest.fn(async () => [[], false]), deleteArticleById: jest.fn() }))
import OmnivorePlugin from '../src/main'
import { DEFAULT_SETTINGS, ImageMode } from '../src/settings'
import { getItems, deleteArticleById } from '../src/api'
import { TFile, TFolder } from 'obsidian'
import { logError } from '../src/logger'
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
