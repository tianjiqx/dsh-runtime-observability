export const ACTIVE_WORKLOAD_KINDS = ['agent_run', 'llm', 'tool', 'mcp'] as const
export const QUEUE_WORKLOAD_KINDS = ['agent_run', 'llm', 'tool', 'mcp'] as const
export const RECOVERY_WORKLOAD_KINDS = ['session', 'task', 'ledger'] as const

export type ActiveWorkloadKind = typeof ACTIVE_WORKLOAD_KINDS[number]
export type QueueWorkloadKind = typeof QUEUE_WORKLOAD_KINDS[number]
export type RecoveryWorkloadKind = typeof RECOVERY_WORKLOAD_KINDS[number]

export interface WorkloadSnapshot {
  active: Readonly<Record<ActiveWorkloadKind, number>>
  queueDepth: Readonly<Record<QueueWorkloadKind, number>>
  queueOldestAgeSeconds: Readonly<Record<QueueWorkloadKind, number>>
  recoveryBacklog: Readonly<Record<RecoveryWorkloadKind, number>>
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>
}

function assertKind<K extends string>(kind: string, keys: readonly K[], field: string): asserts kind is K {
  if (!keys.includes(kind as K)) throw new RangeError(`unsupported ${field}: ${kind}`)
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be a finite non-negative number`)
}

/**
 * Process-local, low-cardinality workload state. Integrations call this facade
 * only at real lifecycle boundaries; it never infers work from Promise or
 * active-handle counts.
 */
export class WorkloadMetrics {
  private readonly active = zeroRecord(ACTIVE_WORKLOAD_KINDS)
  private readonly queueDepth = zeroRecord(QUEUE_WORKLOAD_KINDS)
  private readonly queueOldestAgeSeconds = zeroRecord(QUEUE_WORKLOAD_KINDS)
  private readonly recoveryBacklog = zeroRecord(RECOVERY_WORKLOAD_KINDS)

  begin(kind: ActiveWorkloadKind): () => void {
    assertKind(kind, ACTIVE_WORKLOAD_KINDS, 'active workload kind')
    this.active[kind] += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.active[kind] = Math.max(0, this.active[kind] - 1)
    }
  }

  setQueue(kind: QueueWorkloadKind, depth: number, oldestAgeSeconds = 0): void {
    assertKind(kind, QUEUE_WORKLOAD_KINDS, 'queue workload kind')
    assertNonNegative(depth, 'queue depth')
    assertNonNegative(oldestAgeSeconds, 'queue oldest age')
    this.queueDepth[kind] = depth
    this.queueOldestAgeSeconds[kind] = depth === 0 ? 0 : oldestAgeSeconds
  }

  setRecoveryBacklog(kind: RecoveryWorkloadKind, count: number): void {
    assertKind(kind, RECOVERY_WORKLOAD_KINDS, 'recovery workload kind')
    assertNonNegative(count, 'recovery backlog')
    this.recoveryBacklog[kind] = count
  }

  snapshot(): WorkloadSnapshot {
    return {
      active: { ...this.active },
      queueDepth: { ...this.queueDepth },
      queueOldestAgeSeconds: { ...this.queueOldestAgeSeconds },
      recoveryBacklog: { ...this.recoveryBacklog },
    }
  }
}
