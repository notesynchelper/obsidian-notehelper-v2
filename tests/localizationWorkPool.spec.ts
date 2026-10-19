import { LocalizationRound, LocalizationRoundExpired, LocalizationWorkPool } from '../src/common/localizationWorkPool'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test('R8: all objects share the original round deadline; queued work never starts after expiry', async () => {
  const pool = new LocalizationWorkPool(1, 1)
  const round = new LocalizationRound(100)
  const a = {}, b = {}
  let release!: () => void
  const first = jest.fn(() => new Promise<string>(resolve => { release = () => resolve('saved-a') }))
  const second = jest.fn(async () => 'saved-b')
  const waiting = pool.run(a, first, 0, { key: 'a', round }).catch(e => e)
  await jest.advanceTimersByTimeAsync(50)
  const queued = pool.run(b, second, 0, { key: 'b', round }).catch(e => e)
  await jest.advanceTimersByTimeAsync(50)
  expect(await waiting).toBeInstanceOf(LocalizationRoundExpired)
  expect(await queued).toBeInstanceOf(LocalizationRoundExpired)
  expect(second).not.toHaveBeenCalled()
  round.dispose()
  release(); await flush()
  const next = new LocalizationRound(100)
  expect(await pool.run(a, first, 0, { key: 'a', round: next })).toBe('saved-a')
  expect(await pool.run(b, second, 0, { key: 'b', round: next })).toBe('saved-b')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  next.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('R8: a new round joins the active writer and does not release its large-file reservation', async () => {
  const pool = new LocalizationWorkPool(2, 1)
  const note = {}, another = {}
  let release!: () => void
  const original = jest.fn(() => new Promise<string>(resolve => { release = () => resolve('saved') }))
  const other = jest.fn(async () => 'another')
  const round = new LocalizationRound(100)
  const first = pool.run(note, original, 30 * 1024 * 1024, { key: 'large', round }).catch(e => e)
  await jest.advanceTimersByTimeAsync(100)
  expect(await first).toBeInstanceOf(LocalizationRoundExpired)
  round.dispose()
  const next = new LocalizationRound(100)
  const joined = pool.run(note, original, 30 * 1024 * 1024, { key: 'large', round: next })
  const queued = pool.run(another, other, 30 * 1024 * 1024, { key: 'large', round: next })
  await flush()
  expect(original).toHaveBeenCalledTimes(1)
  expect(other).not.toHaveBeenCalled()
  release()
  expect(await joined).toBe('saved')
  expect(await queued).toBe('another')
  next.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('R8: OS wall-clock jump cannot start a queued job before a delayed budget timer fires', async () => {
  const pool = new LocalizationWorkPool(1, 1)
  const round = new LocalizationRound(100)
  const run = jest.fn(async () => 'saved')
  const waiting = pool.run({}, run, 0, { round }).catch(e => e)
  jest.setSystemTime(Date.now() + 60000)
  await flush()
  expect(await waiting).toBeInstanceOf(LocalizationRoundExpired)
  expect(run).not.toHaveBeenCalled()
  round.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('R8: a late saved result invalidated before adoption is recomputed', async () => {
  const pool = new LocalizationWorkPool(1, 1), note = {}
  const round = new LocalizationRound(100)
  let release!: () => void
  const work = jest.fn().mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('deleted-path') }))
    .mockResolvedValue('replacement-path')
  const first = pool.run(note, work, 0, { key: 'object', round }).catch(e => e)
  await jest.advanceTimersByTimeAsync(100)
  expect(await first).toBeInstanceOf(LocalizationRoundExpired)
  round.dispose(); release(); await flush()
  const result = await pool.run(note, work, 0, { key: 'object', canReuse: () => false })
  expect(result).toBe('replacement-path')
  expect(work).toHaveBeenCalledTimes(2)
})
