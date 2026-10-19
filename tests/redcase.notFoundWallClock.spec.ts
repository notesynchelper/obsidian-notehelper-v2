import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
jest.mock('../src/settings/template', () => ({ render: () => 'images' }))
const HOUR = 3600_000
const START = Date.parse('2026-10-07T00:00:00Z')
let now = START
beforeEach(() => { now = START; jest.spyOn(Date, 'now').mockImplementation(() => now) })
afterEach(() => jest.restoreAllMocks())

function harness(store = new PendingLocalizeStore(), savedAt?: string) {
  const file = Object.assign(new TFile(), { path: 'note.md', basename: 'note' })
  const vault = { read: async () => '![a](https://example.com/a.png)' }
  const localizer = new ImageLocalizer({ vault } as any, {
    enablePngToJpeg: false, jpegQuality: 85, attachmentFolder: 'images', folderDateFormat: 'yyyy', maxRetries: 0, retryDelay: 0,
  }, undefined, store)
  const attempt = jest.spyOn(localizer, 'localizeFile').mockImplementation(async (_task, _progress, outcome) => {
    outcome!.hasNotFound = true
    outcome!.notFoundUrls = ['https://example.com/a.png']
    return false
  })
  async function round() {
    await localizer.enqueueFile(file, savedAt ? { savedAt } : undefined)
    return localizer.processQueue()
  }
  return { localizer, store, round, attempt, file }
}

test('R6: six rapid rounds cannot retire a not-ready image', async () => {
  const h = harness()
  for (let i = 0; i < 6; i++) await h.round()
  expect(h.store.get('note.md')).toMatchObject({ notFoundRounds: 6, firstNotFoundAt: START })
})

test('R6: persisted first 404 survives restart; only rounds plus wall clock permit retirement', async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) await h.round()
  const restored = new PendingLocalizeStore({ load: async () => h.store.snapshot(), save: async () => {} })
  await restored.load()
  const next = harness(restored)
  await next.round()
  expect(restored.get('note.md')).toMatchObject({ firstNotFoundAt: START })
  now += 2 * HOUR
  await next.round()
  expect(restored.get('note.md')).toBeUndefined()
  await restored.flush()
})

test('R6: a young item keeps its 24 hour grace even after it turns six hours old', async () => {
  const h = harness(undefined, new Date(START - 60_000).toISOString())
  for (let i = 0; i < 6; i++) await h.round()
  now += 7 * HOUR
  await h.round()
  expect(h.store.get('note.md')).toBeDefined()
  now = START + 24 * HOUR
  await h.round()
  expect(h.store.get('note.md')).toBeUndefined()
})

test('R6: transient failures reset both rounds and wall clock', async () => {
  const h = harness()
  await h.round()
  h.attempt.mockImplementationOnce(async (_task, _progress, outcome) => {
    outcome!.hasTransient = true
    return false
  })
  await h.round()
  expect(h.store.get('note.md')).toMatchObject({ notFoundRounds: 0 })
  expect((h.store.get('note.md') as any).firstNotFoundAt).toBeUndefined()
  now += HOUR
  await h.round()
  expect(h.store.get('note.md')).toMatchObject({ firstNotFoundAt: now, notFoundRounds: 1 })
})

test('R6: legacy records get a new wall clock floor instead of immediate retirement', async () => {
  const h = harness()
  h.store.upsert({ filePath: 'note.md', retryCount: 50, notFoundRounds: 50, createdAt: START - 72 * HOUR })
  await h.round()
  expect(h.store.get('note.md')).toMatchObject({ firstNotFoundAt: START })
})
