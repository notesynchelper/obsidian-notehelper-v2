/** Whitespace in pasted keys is never meaningful, including invisible separators. */
export const normalizeApiKey = (value: string): string =>
  value.replace(/[\s\u{200b}-\u{200d}\u{feff}]/gu, '')
export type ApiKeyFormatHint = '' | 'charset' | 'length' | 'prefix'
export function checkApiKeyFormat(value: string): ApiKeyFormatHint {
  if (!value) return ''
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return 'charset'
  if (value.length !== 28) return 'length'
  if (!value.startsWith('o')) return 'prefix'
  return ''
}
