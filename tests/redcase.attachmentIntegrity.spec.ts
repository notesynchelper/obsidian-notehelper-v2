import { requestUrl } from 'obsidian'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
jest.mock('obsidian', () => ({ requestUrl: jest.fn() }))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))
const request = requestUrl as jest.Mock
function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return { status: 200, text: '', arrayBuffer: bytes.buffer, headers }
}
const bytes = (s: string) => new TextEncoder().encode(s)
beforeEach(() => request.mockReset())

test.each([
  ['empty', new Uint8Array(), {}, undefined, 'file.bin'],
  ['content length mismatch', new Uint8Array(1024), { 'Content-Length': '17000' }, undefined, 'file.bin'],
  ['truncated chunked', new Uint8Array(1024), {}, 17 * 1024 * 1024, 'file.bin'],
  ['PDF missing EOF', bytes('%PDF-1.4\nincomplete'), {}, undefined, 'file.pdf'],
  ['ZIP missing EOCD', new Uint8Array([0x50, 0x4b, 3, 4, 0]), {}, undefined, 'file.docx'],
] as const)('R4 rejects %s', async (_name, data, headers, expectedBytes, name) => {
  request.mockResolvedValue(response(data, headers))
  expect(await downloadAttachment(`https://example.com/${name}`, 0, 0, { expectedBytes }))
    .toMatchObject({ success: false })
})

test.each([
  ['PDF complete', bytes('%PDF-1.4\ncomplete\n%%EOF\n'), {}, undefined, 'file.pdf'],
  ['unknown binary', new Uint8Array(1024), {}, undefined, 'file.bin'],
  ['rounded size', new Uint8Array(100000), {}, 100100, 'file.bin'],
  ['gzip decoded body', bytes('%PDF-1.4\ncomplete\n%%EOF\n'), { 'Content-Encoding': 'gzip', 'Content-Length': '100' }, undefined, 'file.pdf'],
] as const)('R4 accepts %s', async (_name, data, headers, expectedBytes, name) => {
  request.mockResolvedValue(response(data, headers))
  const result = await downloadAttachment(`https://example.com/${name}`, 0, 0, { expectedBytes })
  expect(result.success).toBe(true)
  expect(new Uint8Array(result.data!)).toEqual(data)
})

test('R4 checks format signatures on extensionless media URLs too', async () => {
  request.mockResolvedValue(response(bytes('%PDF-1.4\nincomplete')))
  expect(await downloadAttachment('https://example.com/wecom4/object', 0, 0))
    .toMatchObject({ success: false })
})
