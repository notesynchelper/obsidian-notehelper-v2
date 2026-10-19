import { requestUrl } from 'obsidian'
import { TransferPool, TransferSession, TransferCapacityError, TransferTimeoutError } from '../src/common/transfer/transferPool'
jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))
const request = requestUrl as jest.Mock
const ok = () => ({ status: 200, text: '', headers: {}, arrayBuffer: new Uint8Array([1, 2, 3]).buffer })
beforeEach(() => { request.mockReset(); jest.useFakeTimers() })
afterEach(() => jest.useRealTimers())

test('real host slots remain occupied after callers time out, and a fifth request is refused', async () => {
  const pool = new TransferPool()
  request.mockImplementation(() => new Promise(() => {}))
  const waits = []
  for (let i = 0; i < 4; i++) {
    const session = new TransferSession(f => f.response?.status || 0, code => code === 200, pool)
    waits.push(session.request(`https://host.example/${i}`, 'image', 50).catch(e => e).finally(() => session.dispose()))
  }
  await jest.advanceTimersByTimeAsync(100)
  for (const result of await Promise.all(waits)) expect(result).toBeInstanceOf(TransferTimeoutError)
  expect(() => pool.acquire('https://host.example/fifth', 'image')).toThrow(TransferCapacityError)
  expect(request).toHaveBeenCalledTimes(4)
})

test.each([['image', 2], ['attachment', 1]] as const)('%s caps parallel routes for the same object at %i', async (kind, cap) => {
  const pool = new TransferPool()
  request.mockImplementation(() => new Promise(() => {}))
  pool.acquire('https://pic.clipfx.app/object.png', kind)
  if (cap === 2) pool.acquire('https://relay-1.bijitongbu.site/p/object.png', kind)
  expect(() => pool.acquire('https://relay-2.bijitongbu.site/p/object.png', kind)).toThrow(TransferCapacityError)
  await jest.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(cap)
})

test('a late response between rounds is consumed by the next round without downloading again', async () => {
  const pool = new TransferPool()
  request.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(ok()), 200)))
  const session = () => new TransferSession(f => f.response?.status || 0, code => code === 200, pool)
  const first = session()
  const wait = first.request('https://host.example/late', 'image', 50).catch(e => e)
  await jest.advanceTimersByTimeAsync(50)
  expect(await wait).toBeInstanceOf(TransferTimeoutError)
  first.dispose()
  await jest.advanceTimersByTimeAsync(200)
  const next = session()
  expect(await next.request('https://host.example/late', 'image', 50)).toBe(200)
  next.dispose()
  expect(request).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test('expired orphan responses are not served forever', async () => {
  const pool = new TransferPool()
  request.mockResolvedValue(ok())
  pool.acquire('https://host.example/old', 'image')
  await jest.advanceTimersByTimeAsync(120001)
  pool.acquire('https://host.example/old', 'image')
  await jest.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
})

test('half-open recovery lets other objects wait for the probe without adopting its body or losing a retry round', async () => {
  const pool = new TransferPool()
  const session = () => new TransferSession(f => f.response?.status || 0, code => code === 200, pool)
  request.mockResolvedValue({ ...ok(), status: 503 })
  for (let i = 0; i < 4; i++) { const s = session(); await s.request(`https://host.example/bad-${i}`, 'image', 100); s.dispose() }
  jest.setSystemTime(Date.now() + 60000)
  request.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(ok()), 50))).mockResolvedValue(ok())
  const first = session(), second = session()
  const a = first.request('https://host.example/a', 'image', 100).catch(e => e)
  const b = second.request('https://host.example/b', 'image', 100).catch(e => e)
  await jest.advanceTimersByTimeAsync(100)
  expect(await a).toBe(200)
  expect(await b).toBe(200)
  expect(request).toHaveBeenCalledTimes(6)
  expect(request.mock.calls[5][0].url).toBe('https://host.example/b')
  first.dispose(); second.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('a brief full host does not fail healthy work while another object is about to release a slot', async () => {
  const pool = new TransferPool()
  request.mockImplementation(({ url }) => url.endsWith('/fast')
    ? new Promise(resolve => setTimeout(() => resolve(ok()), 20))
    : url.endsWith('/next') ? Promise.resolve(ok()) : new Promise(() => {}))
  for (const name of ['slow1', 'slow2', 'slow3', 'fast']) pool.acquire(`https://host.example/${name}`, 'image')
  const session = new TransferSession(f => f.response?.status || 0, code => code === 200, pool)
  const next = session.request('https://host.example/next', 'attachment', 100).catch(e => e)
  await jest.advanceTimersByTimeAsync(19)
  expect(request).toHaveBeenCalledTimes(4)
  await jest.advanceTimersByTimeAsync(81)
  expect(await next).toBe(200)
  expect(request).toHaveBeenCalledTimes(5)
  session.dispose()
  expect(jest.getTimerCount()).toBe(0)
})

test('waiting for capacity is bounded and detaches observers without releasing real occupied slots', async () => {
  const pool = new TransferPool()
  request.mockImplementation(() => new Promise(() => {}))
  const flights = [0, 1, 2, 3].map(i => pool.acquire(`https://host.example/${i}`, 'image'))
  const session = new TransferSession(f => f.response?.status || 0, code => code === 200, pool)
  const next = session.request('https://host.example/next', 'attachment', 5000).catch(e => e)
  await jest.advanceTimersByTimeAsync(1000)
  expect(await next).toBeInstanceOf(TransferCapacityError)
  expect(request).toHaveBeenCalledTimes(4)
  expect(flights.every(f => f.listeners.size === 0)).toBe(true)
  session.dispose()
  expect(jest.getTimerCount()).toBe(0)
})
