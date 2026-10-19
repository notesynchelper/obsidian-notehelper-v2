/** Response header casing differs between desktop and native requestUrl. */
export function headerValue(headers: Record<string, string> | undefined, name: string): string {
  const key = Object.keys(headers ?? {}).find(key => key.toLowerCase() === name.toLowerCase())
  return key ? headers![key].trim() : ''
}

export function hasCompleteLength(data: ArrayBuffer | undefined, headers?: Record<string, string>): boolean {
  if (!data?.byteLength) return false
  const encoding = headerValue(headers, 'content-encoding').toLowerCase()
  const length = headerValue(headers, 'content-length')
  // Android's native HTTP stack strips Content-Encoding/Length when it
  // transparently decodes gzip. A remaining encoding on its marked response
  // therefore describes bytes it did not decode (e.g. unsolicited Brotli).
  // Reject before unknown image/attachment formats can accept compressed bytes.
  // Electron instead retains encoding headers on decoded bodies: keep its
  // wire-length exemption, and the format checks below, intact.
  if (encoding && encoding !== 'identity' && headerValue(headers, 'x-android-response-source')) return false
  return (encoding !== '' && encoding !== 'identity') || !/^\d+$/.test(length) || Number(length) === data.byteLength
}

export function isCompleteAttachment(
  data: ArrayBuffer | undefined,
  headers: Record<string, string> | undefined,
  url: string,
  expectedBytes?: number,
): boolean {
  if (!data) return false
  const bytes = new Uint8Array(data)
  return isCompleteAttachmentSamples(bytes.length, bytes.subarray(0, 65557), bytes.subarray(Math.max(0, bytes.length - 65557)), headers, url, expectedBytes)
}

/** Same integrity rules for buffered and streamed attachments. */
export function isCompleteAttachmentSamples(
  length: number, headBytes: Uint8Array, tail: Uint8Array,
  headers: Record<string, string> | undefined, url: string, expectedBytes?: number,
): boolean {
  if (!length) return false
  const encoding = headerValue(headers, 'content-encoding').toLowerCase()
  const declared = headerValue(headers, 'content-length')
  if (encoding && encoding !== 'identity' && headerValue(headers, 'x-android-response-source')) return false
  if ((!encoding || encoding === 'identity') && /^\d+$/.test(declared) && Number(declared) !== length) return false
  if (expectedBytes && Number.isFinite(expectedBytes) && expectedBytes > 0 &&
      Math.abs(length - expectedBytes) > Math.max(expectedBytes * 0.01, 16 * 1024)) return false
  let pathname = ''
  try { pathname = new URL(url).pathname } catch { /* use magic and MIME */ }
  const mime = headerValue(headers, 'content-type').toLowerCase().split(';')[0]
  const head = new TextDecoder().decode(headBytes.subarray(0, 5))
  if (head === '%PDF-' || mime === 'application/pdf' || /\.pdf$/i.test(pathname)) {
    return new TextDecoder().decode(tail.subarray(Math.max(0, tail.length - 1024))).includes('%%EOF')
  }
  if ((headBytes[0] === 0x50 && headBytes[1] === 0x4b) || /\.(zip|docx|xlsx|pptx)$/i.test(pathname) ||
      mime === 'application/zip' || mime.startsWith('application/vnd.openxmlformats-officedocument.')) {
    for (let i = 0; i <= tail.length - 22; i++) {
      if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 0x05 || tail[i + 3] !== 0x06) continue
      const commentLength = tail[i + 20] | (tail[i + 21] << 8)
      if (i + 22 + commentLength <= tail.length) return true
    }
    return false
  }
  return true
}
