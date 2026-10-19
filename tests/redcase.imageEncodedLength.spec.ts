import { isCompleteImageResponse } from '../src/imageLocalizer/imageDownloader'
const data = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80"/></svg>').buffer

test.each(['gzip', 'br', 'deflate'])('U2: decoded %s image is not compared against encoded wire length', encoding => {
  expect(isCompleteImageResponse(data, { 'Content-Encoding': encoding, 'Content-Length': '40' })).toBe(true)
})
test('U2: identity responses still require exact Content-Length', () => {
  expect(isCompleteImageResponse(data, { 'Content-Encoding': 'identity', 'Content-Length': '40' })).toBe(false)
})
test('U2: encoding does not bypass structural integrity', () => {
  expect(isCompleteImageResponse(new TextEncoder().encode('<svg>truncated').buffer, { 'Content-Encoding': 'gzip' })).toBe(false)
})
