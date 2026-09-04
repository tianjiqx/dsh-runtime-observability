import { describe, expect, it } from 'vitest'
import { installWorkloadMetrics } from '../src/workload-integration.ts'
import { WorkloadMetrics } from '../src/workload.ts'

type Listener = (payload: unknown) => void

function context() {
  const listeners = new Map<string, Listener[]>()
  const cleanups: (() => void)[] = []
  return {
    on(name: string, listener: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    effect(factory: () => (() => void) | void) {
      const cleanup = factory()
      if (cleanup) cleanups.push(cleanup)
    },
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    cleanup() {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

describe('workload lifecycle integration', () => {
  it('tracks subagent runs and closes them on matching end', () => {
    const ctx = context()
    const metrics = new WorkloadMetrics()
    installWorkloadMetrics(ctx, metrics)

    ctx.emit('subagent/start', { runId: 'r1' })
    ctx.emit('subagent/start', { runId: 'r1' })
    expect(metrics.snapshot().active.agent_run).toBe(1)

    ctx.emit('subagent/end', { runId: 'r1' })
    ctx.emit('subagent/end', { runId: 'r1' })
    expect(metrics.snapshot().active.agent_run).toBe(0)
  })

  it('cleans unfinished runs when the plugin scope ends', () => {
    const ctx = context()
    const metrics = new WorkloadMetrics()
    installWorkloadMetrics(ctx, metrics)
    ctx.emit('subagent/start', { id: 'r2' })
    expect(metrics.snapshot().active.agent_run).toBe(1)
    ctx.cleanup()
    expect(metrics.snapshot().active.agent_run).toBe(0)
  })
})
