import { brotliCompressSync } from 'zlib'
import { hasCompleteLength, isCompleteAttachment } from '../src/common/transferIntegrity'
import { isCompleteImageResponse } from '../src/imageLocalizer/imageDownloader'

const plain = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80"/></svg>')
const compressed = new Uint8Array(brotliCompressSync(plain)).buffer
const nativeHeaders = {
  'Content-Encoding': 'br',
  'Content-Length': String(compressed.byteLength),
  'X-Android-Response-Source': 'NETWORK 200',
}

test('U2 Android: still-encoded native bytes cannot pass the common length gate', () => {
  expect(hasCompleteLength(compressed, nativeHeaders)).toBe(false)
})
test('U2 Android: raw Brotli cannot be saved as an SVG through unknown-format compatibility', () => {
  expect(isCompleteImageResponse(compressed, { ...nativeHeaders, 'Content-Type': 'image/svg+xml' })).toBe(false)
})
test('U2 Android: unknown-format attachments also reject still-encoded native bodies', () => {
  expect(isCompleteAttachment(compressed, nativeHeaders, 'https://example.com/file.txt')).toBe(false)
})
test('U2 Android: native transparent gzip decoding strips encoding and length headers', () => {
  expect(isCompleteImageResponse(plain.buffer, { 'X-Android-Response-Source': 'NETWORK 200', 'Content-Type': 'image/svg+xml' })).toBe(true)
})
test('U2 Android: identity is not a compressed response', () => {
  expect(isCompleteImageResponse(plain.buffer, { ...nativeHeaders, 'Content-Encoding': 'identity', 'Content-Length': String(plain.length) })).toBe(true)
})
test('U2 desktop: decoded Brotli still accepts a wire Content-Length', () => {
  expect(isCompleteImageResponse(plain.buffer, { 'Content-Encoding': 'br', 'Content-Length': String(compressed.byteLength) })).toBe(true)
})
