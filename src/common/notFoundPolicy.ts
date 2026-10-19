/** A negative response is evidence of absence now, not of permanent expiry. */
export const NOT_FOUND_ROUND_BUDGET = 6
export const NOT_FOUND_FLOOR_MS = 2 * 60 * 60_000
export const YOUNG_NOT_FOUND_FLOOR_MS = 24 * 60 * 60_000
const YOUNG_ITEM_MS = 6 * 60 * 60_000

export function canRetireNotFound(
  record: { notFoundRounds?: number; firstNotFoundAt?: number },
  now: number,
  savedAt?: string,
): boolean {
  if (record.firstNotFoundAt === undefined || (record.notFoundRounds ?? 0) < NOT_FOUND_ROUND_BUDGET) return false
  const saved = savedAt ? Date.parse(savedAt) : NaN
  // Fix the grace period at first observation: an initially young item must
  // not lose its 24-hour grace merely because its age passes six hours.
  const young = Number.isFinite(saved) && record.firstNotFoundAt - saved < YOUNG_ITEM_MS
  const floor = young ? YOUNG_NOT_FOUND_FLOOR_MS : NOT_FOUND_FLOOR_MS
  return now - record.firstNotFoundAt >= floor
}

export interface MissingObjectRecord {
  firstNotFoundAt: number
  notFoundRounds: number
}
export type MissingObjectRecords = Record<string, MissingObjectRecord>
