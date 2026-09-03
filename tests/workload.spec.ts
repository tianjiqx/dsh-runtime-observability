import { describe, expect, it } from 'vitest'
import { WorkloadMetrics } from '../src/workload.ts'

describe('WorkloadMetrics', () => {
  it('tracks nested active work and makes end idempotent', () => {
    const metrics = new WorkloadMetrics()
    const endFirst = metrics.begin('agent_run')
    const endSecond = metrics.begin('agent_run')

    expect(metrics.snapshot().active.agent_run).toBe(2)
    endFirst()
    endFirst()
    expect(metrics.snapshot().active.agent_run).toBe(1)
    endSecond()
    expect(metrics.snapshot().active.agent_run).toBe(0)
  })

  it('tracks queue age and clears age with an empty queue', () => {
    const metrics = new WorkloadMetrics()
    metrics.setQueue('tool', 3, 12.5)
    expect(metrics.snapshot().queueDepth.tool).toBe(3)
    expect(metrics.snapshot().queueOldestAgeSeconds.tool).toBe(12.5)

    metrics.setQueue('tool', 0, 99)
    expect(metrics.snapshot().queueOldestAgeSeconds.tool).toBe(0)
  })

  it('tracks fixed recovery kinds and rejects unbounded labels at runtime', () => {
    const metrics = new WorkloadMetrics()
    metrics.setRecoveryBacklog('ledger', 4)
    expect(metrics.snapshot().recoveryBacklog.ledger).toBe(4)
    expect(() => metrics.begin('run-123' as never)).toThrow(/unsupported active workload kind/)
  })

  it('rejects invalid gauge values', () => {
    const metrics = new WorkloadMetrics()
    expect(() => metrics.setQueue('mcp', -1)).toThrow(/queue depth/)
    expect(() => metrics.setRecoveryBacklog('task', Number.NaN)).toThrow(/recovery backlog/)
  })
})
