import { describe, expect, it } from 'vitest'
import { installSubagentLifecycleMetrics, SubagentLifecycleMetrics } from '../src/subagent-lifecycle.ts'

describe('SubagentLifecycleMetrics', () => {
  it('derives running, waiting, and settled-pending from residency', () => {
    let now = 1_000
    const metrics = new SubagentLifecycleMetrics(() => now)
    metrics.activate('parent', 'root', 'idle')
    metrics.activate('child', 'parent', 'running')

    expect(metrics.snapshot().activations).toEqual({ running: 1, waiting: 1, settled_pending: 0 })

    metrics.setStatus('child', 'idle')
    now += 2_000
    expect(metrics.snapshot()).toMatchObject({
      activations: { running: 0, waiting: 1, settled_pending: 1 },
      oldestAgeSeconds: { waiting: 2, settled_pending: 2 },
    })

    metrics.deactivate('child')
    expect(metrics.snapshot().activations).toEqual({ running: 0, waiting: 0, settled_pending: 1 })
  })

  it('keeps accepted waking inbox work in running until claimed', () => {
    const metrics = new SubagentLifecycleMetrics(() => 0)
    metrics.activate('child', 'root', 'idle')
    metrics.acceptMessage('child', 'message-1')
    expect(metrics.snapshot().activations.running).toBe(1)

    metrics.releaseMessage('child', 'message-1')
    expect(metrics.snapshot().activations.settled_pending).toBe(1)
  })

  it('marks live descendants orphaned when their parent is disposed', () => {
    let now = 10_000
    const metrics = new SubagentLifecycleMetrics(() => now)
    metrics.activate('child-a', 'parent', 'running')
    metrics.activate('child-b', 'parent', 'idle')
    metrics.markParentDisposed('parent')
    now += 5_000

    expect(metrics.snapshot()).toMatchObject({
      orphans: 2,
      orphanOldestAgeSeconds: 5,
      events: { started: 2, disposed: 0, orphaned: 2 },
    })

    metrics.deactivate('child-a')
    metrics.deactivate('child-b')
    expect(metrics.snapshot()).toMatchObject({
      orphans: 0,
      orphanOldestAgeSeconds: 0,
      events: { started: 2, disposed: 2, orphaned: 2 },
    })
  })

  it('does not double-count duplicate parent disposal or message release', () => {
    const metrics = new SubagentLifecycleMetrics(() => 0)
    metrics.activate('child', 'parent', 'idle')
    metrics.markParentDisposed('parent')
    metrics.markParentDisposed('parent')
    metrics.releaseMessage('child', 'missing')
    metrics.deactivate('missing')

    expect(metrics.snapshot().events).toEqual({ started: 1, disposed: 0, orphaned: 1 })
  })

  it('reference-counts overlapping HMR setup contributions', () => {
    const metrics = new SubagentLifecycleMetrics(() => 0)
    metrics.activate('child', 'parent', 'running')
    metrics.activate('child', 'parent', 'running')
    metrics.deactivate('child')

    expect(metrics.snapshot()).toMatchObject({
      activations: { running: 1 },
      events: { started: 1, disposed: 0 },
    })

    metrics.deactivate('child')
    expect(metrics.snapshot()).toMatchObject({
      activations: { running: 0 },
      events: { started: 1, disposed: 1 },
    })
  })

  it('bounds disposed-parent tombstones while preserving marked orphans', () => {
    let now = 0
    const metrics = new SubagentLifecycleMetrics(() => now)
    metrics.markParentDisposed('old-parent')
    metrics.activate('old-orphan', 'old-parent', 'idle')
    now = 5 * 60_000 + 1
    metrics.activate('late-child', 'old-parent', 'idle')

    expect(metrics.snapshot().orphans).toBe(1)
  })

  it('clears resident identities on final service disposal', () => {
    const metrics = new SubagentLifecycleMetrics(() => 0)
    metrics.activate('child', 'parent', 'running')
    metrics.markParentDisposed('parent')
    metrics.dispose()

    expect(metrics.snapshot()).toMatchObject({
      activations: { running: 0, waiting: 0, settled_pending: 0 },
      orphans: 0,
    })
  })

  it('projects public DSH setup and agent events into the lifecycle tracker', () => {
    const metrics = new SubagentLifecycleMetrics(() => 0)
    const rootListeners = new Map<string, (payload: any) => void>()
    const childListeners = new Map<string, (payload: any) => void>()
    let contribution: ((ctx: any) => (() => void) | void) | undefined
    const root = {
      on: (name: string, listener: (payload: any) => void) => rootListeners.set(name, listener),
      inject: (_dependencies: readonly string[], callback: (ctx: any) => void) => callback({
        subagents: {
          registerContinuableSetup: (next: typeof contribution) => { contribution = next },
        },
      }),
    }
    installSubagentLifecycleMetrics(root, metrics)
    const dispose = contribution?.({
      agent: {
        id: 'child',
        status: 'idle',
        session: { header: { parentSession: 'parent' } },
      },
      on: (name: string, listener: (payload: any) => void) => childListeners.set(name, listener),
    })

    childListeners.get('agent/inbox/inserted')?.({ message: { id: 'message' } })
    expect(metrics.snapshot().activations.running).toBe(1)
    childListeners.get('agent/inbox/claimed')?.({ message: { id: 'message' } })
    rootListeners.get('agent/disposed')?.({ agent: { id: 'parent' } })
    expect(metrics.snapshot()).toMatchObject({
      activations: { settled_pending: 1 },
      orphans: 1,
    })

    dispose?.()
    expect(metrics.snapshot().events.disposed).toBe(1)
  })
})
