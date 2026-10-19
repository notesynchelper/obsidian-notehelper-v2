import { logError } from '../logger'

export interface LocalizationProgressSnapshot { processed: number; total: number }
export type LocalizationProgressListener = (progress: LocalizationProgressSnapshot) => void

/** Counts actual scanned objects, including notes joining an active drain. */
export class LocalizationProgress {
  private processed = 0
  private total = 0
  private listeners = new Set<LocalizationProgressListener>()

  subscribe(listener: LocalizationProgressListener): () => void {
    this.listeners.add(listener)
    this.notify(listener)
    return () => { this.listeners.delete(listener) }
  }

  reset(): void { this.processed = 0; this.total = 0; this.publish() }
  add(count: number): void { this.total += count; this.publish() }
  complete(): void { this.processed++; this.publish() }

  private notify(listener: LocalizationProgressListener): void {
    try { listener({ processed: this.processed, total: this.total }) }
    catch (error) { logError('本地化进度显示失败', error) }
  }
  private publish(): void { for (const listener of this.listeners) this.notify(listener) }
}
