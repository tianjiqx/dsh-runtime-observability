export const SUBAGENT_ACTIVATION_STATES = ['running', 'waiting', 'settled_pending'] as const
export const SUBAGENT_LIFECYCLE_EVENTS = ['started', 'disposed', 'orphaned'] as const

export type SubagentActivationState = typeof SUBAGENT_ACTIVATION_STATES[number]
export type SubagentLifecycleEvent = typeof SUBAGENT_LIFECYCLE_EVENTS[number]
export type AgentStatus = 'idle' | 'running'

interface ActivationRecord {
  readonly id: string
  readonly parentId: string
  readonly accepted: Set<string>
  status: AgentStatus
  state: SubagentActivationState
  stateSinceMs: number
  orphanedAtMs: number | undefined
  references: number
}

export interface SubagentLifecycleSnapshot {
  readonly activations: Record<SubagentActivationState, number>
  readonly oldestAgeSeconds: Record<SubagentActivationState, number>
  readonly orphans: number
  readonly orphanOldestAgeSeconds: number
  readonly events: Record<SubagentLifecycleEvent, number>
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>
}

/**
 * Process-local projection of continuable-subagent residency. It deliberately
 * stores identities only in memory and exports fixed-label aggregates.
 */
export class SubagentLifecycleMetrics {
  private readonly activations = new Map<string, ActivationRecord>()
  private readonly disposedParents = new Map<string, number>()
  private readonly events = zeroRecord(SUBAGENT_LIFECYCLE_EVENTS)
  private static readonly PARENT_TOMBSTONE_RETENTION_MS = 5 * 60_000

  constructor(private readonly clock: () => number = Date.now) {}

  activate(id: string, parentId: string, status: AgentStatus): void {
    const now = this.clock()
    this.pruneParentTombstones(now)
    const existing = this.activations.get(id)
    if (existing !== undefined) {
      // One Session has at most one live Activation. A duplicate setup is an
      // overlapping HMR observer of that same id and therefore the same parent;
      // do not reset its accepted inbox projection while work may be pending.
      existing.references += 1
      existing.status = status
      this.reconcile(now)
      return
    }
    const orphaned = this.disposedParents.has(parentId)
    this.activations.set(id, {
      id,
      parentId,
      accepted: new Set(),
      status,
      state: status === 'running' ? 'running' : 'settled_pending',
      stateSinceMs: now,
      orphanedAtMs: orphaned ? now : undefined,
      references: 1,
    })
    this.events.started += 1
    if (orphaned) this.events.orphaned += 1
    this.reconcile(now)
  }

  deactivate(id: string): void {
    const activation = this.activations.get(id)
    if (!activation) return
    activation.references -= 1
    if (activation.references > 0) return
    this.activations.delete(id)
    this.events.disposed += 1
    this.reconcile(this.clock())
  }

  setStatus(id: string, status: AgentStatus): void {
    const activation = this.activations.get(id)
    if (!activation || activation.status === status) return
    activation.status = status
    this.reconcile(this.clock())
  }

  acceptMessage(id: string, messageId: string): void {
    const activation = this.activations.get(id)
    if (!activation || activation.accepted.has(messageId)) return
    activation.accepted.add(messageId)
    this.reconcile(this.clock())
  }

  releaseMessage(id: string, messageId: string): void {
    const activation = this.activations.get(id)
    if (!activation?.accepted.delete(messageId)) return
    this.reconcile(this.clock())
  }

  markParentDisposed(parentId: string): void {
    const now = this.clock()
    this.pruneParentTombstones(now)
    if (this.disposedParents.has(parentId)) return
    this.disposedParents.set(parentId, now)
    for (const activation of this.activations.values()) {
      if (activation.parentId === parentId && activation.orphanedAtMs === undefined) {
        activation.orphanedAtMs = now
        this.events.orphaned += 1
      }
    }
  }

  snapshot(): SubagentLifecycleSnapshot {
    const now = this.clock()
    const activations = zeroRecord(SUBAGENT_ACTIVATION_STATES)
    const oldestAgeSeconds = zeroRecord(SUBAGENT_ACTIVATION_STATES)
    let orphans = 0
    let orphanOldestAgeSeconds = 0
    for (const activation of this.activations.values()) {
      activations[activation.state] += 1
      oldestAgeSeconds[activation.state] = Math.max(
        oldestAgeSeconds[activation.state],
        (now - activation.stateSinceMs) / 1000,
      )
      if (activation.orphanedAtMs !== undefined) {
        orphans += 1
        orphanOldestAgeSeconds = Math.max(orphanOldestAgeSeconds, (now - activation.orphanedAtMs) / 1000)
      }
    }
    return {
      activations,
      oldestAgeSeconds,
      orphans,
      orphanOldestAgeSeconds,
      events: { ...this.events },
    }
  }

  dispose(): void {
    this.activations.clear()
    this.disposedParents.clear()
  }

  private reconcile(now: number): void {
    const parentsWithChildren = new Set<string>()
    for (const activation of this.activations.values()) parentsWithChildren.add(activation.parentId)
    for (const activation of this.activations.values()) {
      let next: SubagentActivationState
      if (activation.status === 'running' || activation.accepted.size > 0) {
        next = 'running'
      } else if (parentsWithChildren.has(activation.id)) {
        next = 'waiting'
      } else {
        next = 'settled_pending'
      }
      if (activation.state !== next) {
        activation.state = next
        activation.stateSinceMs = now
      }
    }
  }

  private pruneParentTombstones(now: number): void {
    const cutoff = now - SubagentLifecycleMetrics.PARENT_TOMBSTONE_RETENTION_MS
    for (const [parentId, disposedAt] of this.disposedParents) {
      if (disposedAt < cutoff) this.disposedParents.delete(parentId)
    }
  }
}

interface AgentLike {
  readonly id: string
  readonly status: AgentStatus
  readonly session: { readonly header: { readonly parentSession?: string } }
}

interface EventContext {
  readonly agent?: AgentLike
  on<T>(name: string, listener: (payload: T) => void, options?: { global?: boolean }): unknown
}

interface SubagentRuntimeLike {
  registerContinuableSetup(contribution: (childCtx: EventContext) => (() => void) | void): unknown
}

interface RuntimeContext extends EventContext {
  readonly subagents?: SubagentRuntimeLike
  inject(dependencies: readonly string[], callback: (ctx: RuntimeContext) => void): unknown
}

/** Attach to public DSH lifecycle seams without taking a package dependency on DSH internals. */
export function installSubagentLifecycleMetrics(ctx: unknown, metrics: SubagentLifecycleMetrics): void {
  const root = ctx as RuntimeContext
  root.on('agent/disposed', (payload: { agent?: AgentLike }) => {
    if (payload.agent) metrics.markParentDisposed(String(payload.agent.id))
  }, { global: true })
  root.inject(['subagents'], (injected) => {
    injected.subagents?.registerContinuableSetup((childCtx) => {
      const agent = childCtx.agent
      const parentId = agent?.session.header.parentSession
      if (!agent || parentId === undefined) return
      const id = String(agent.id)
      metrics.activate(id, String(parentId), agent.status)
      childCtx.on('agent/status', ({ status }: { status: AgentStatus }) => metrics.setStatus(id, status))
      childCtx.on('agent/inbox/inserted', ({ message }: { message: { id: string } }) => {
        metrics.acceptMessage(id, String(message.id))
      })
      childCtx.on('agent/inbox/claimed', ({ message }: { message: { id: string } }) => {
        metrics.releaseMessage(id, String(message.id))
      })
      childCtx.on('agent/inbox/discarded', ({ message }: { message: { id: string } }) => {
        metrics.releaseMessage(id, String(message.id))
      })
      return () => metrics.deactivate(id)
    })
  })
}
