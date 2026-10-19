import { log } from '../../logger'
interface State { observations: number; failureRate: number; timeouts: number; openUntil: number; probe: boolean }
const COOLDOWN_MS = 60000

/** Host history is bounded and uses wall time; no housekeeping timers. */
export class HostHealth {
  private hosts = new Map<string, State>()

  observe(host: string, failed: boolean, timeout = false): void {
    const state = this.hosts.get(host) ?? { observations: 0, failureRate: 0, timeouts: 0, openUntil: 0, probe: false }
    state.observations++
    state.failureRate = state.observations === 1 ? Number(failed) : state.failureRate * 0.7 + Number(failed) * 0.3
    state.timeouts = timeout ? state.timeouts + 1 : 0
    if (!failed) {
      if (state.openUntil) log(`下载主机恢复: ${host}`)
      state.openUntil = 0
      if (state.probe) { state.failureRate = 0; state.observations = 1 }
      state.probe = false
    } else if (state.probe || state.timeouts >= 3 || (state.observations >= 4 && state.failureRate >= 0.7)) {
      // Already-open requests settling late must not perpetually extend a ban.
      if (state.probe || !state.openUntil || state.openUntil <= Date.now()) {
        state.openUntil = Date.now() + COOLDOWN_MS
        log(`下载主机暂缓至 ${state.openUntil}: ${host}`)
      }
      state.probe = false
    }
    this.hosts.delete(host)
    this.hosts.set(host, state)
    if (this.hosts.size > 256) {
      const oldest = this.hosts.keys().next()
      if (!oldest.done) this.hosts.delete(oldest.value)
    }
  }

  canStart(host: string): boolean {
    const state = this.hosts.get(host)
    if (!state?.openUntil) return true
    if (state.openUntil > Date.now() || state.probe) return false
    state.probe = true
    return true
  }

  isProbing(host: string): boolean { return this.hosts.get(host)?.probe === true }

  retryAt(host: string): number | undefined {
    const state = this.hosts.get(host)
    if (!state?.openUntil) return undefined
    return state.probe ? Math.max(state.openUntil, Date.now() + COOLDOWN_MS) : state.openUntil > Date.now() ? state.openUntil : undefined
  }

  order(routes: string[]): string[] {
    const score = (url: string) => {
      const s = this.hosts.get(new URL(url).origin)
      return s ? (s.openUntil ? 10 : 0) + s.failureRate : 0
    }
    return routes.slice().sort((a, b) => score(a) - score(b))
  }

  clear(): void { this.hosts.clear() }
}
