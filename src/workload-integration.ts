import type { WorkloadMetrics } from './workload.ts'

interface WorkloadEventContext {
  on<T>(name: string, listener: (payload: T) => void, options?: { global?: boolean }): unknown
  effect?(factory: () => (() => void) | void, name?: string): unknown
}

interface RunPayload {
  readonly runId?: string
  readonly id?: string
}

/** Bridge DSH's public subagent lifecycle events into the workload facade. */
export function installWorkloadMetrics(ctx: unknown, metrics: WorkloadMetrics): void {
  const root = ctx as WorkloadEventContext
  const activeRuns = new Map<string, () => void>()

  root.on<RunPayload>('subagent/start', (payload) => {
    const id = eventId(payload)
    if (!id || activeRuns.has(id)) return
    activeRuns.set(id, metrics.begin('agent_run'))
  }, { global: true })

  root.on<RunPayload>('subagent/end', (payload) => {
    const id = eventId(payload)
    if (!id) return
    const end = activeRuns.get(id)
    if (!end) return
    activeRuns.delete(id)
    end()
  }, { global: true })

  root.effect?.(() => () => {
    for (const end of activeRuns.values()) end()
    activeRuns.clear()
  }, 'dsh-runtime-observability: workload integration cleanup')
}

function eventId(payload: RunPayload | undefined): string | undefined {
  const value = payload?.runId ?? payload?.id
  return value === undefined ? undefined : String(value)
}
