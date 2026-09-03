import { describe, expect, it } from 'vitest'
import { countActiveResources, nanosecondsToSeconds, RuntimeSnapshotCollector } from '../src/runtime-snapshot.ts'

describe('runtime snapshot collection', () => {
  it('converts event-loop nanoseconds to seconds', () => {
    expect(nanosecondsToSeconds(250_000_000)).toBe(0.25)
  })

  it('bounds active-resource cardinality', () => {
    expect([...countActiveResources(['TCPWRAP', 'TCPWRAP', 'Timeout', 'TTYWrap'], 2)]).toEqual([
      ['TCPWRAP', 2],
      ['Timeout', 1],
    ])
  })

  it('resets the delay histogram after each snapshot', () => {
    let resets = 0
    const delay = {
      percentile: (value: number) => value * 1_000_000,
      reset: () => { resets += 1 },
    }
    const snapshots = [
      { idle: 10, active: 10, utilization: 0.5 },
      { idle: 30, active: 20, utilization: 0.4 },
    ]
    const deltaInputs: Array<[number, number]> = []
    const collector = new RuntimeSnapshotCollector(
      delay,
      () => snapshots.shift()!,
      (current, previous) => {
        deltaInputs.push([current.idle, previous?.idle ?? -1])
        return previous === undefined ? current : { idle: 20, active: 10, utilization: 1 / 3 }
      },
      () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5 }),
      () => ['Timeout'],
      () => ({ user: 2_500_000, system: 750_000 }),
      () => 123.5,
    )

    expect(collector.collect()).toMatchObject({
      eventLoopDelayP99Seconds: 0.099,
      eventLoopUtilization: 0.5,
      externalBytes: 4,
      arrayBuffersBytes: 5,
      processCpuUserSeconds: 2.5,
      processCpuSystemSeconds: 0.75,
      processUptimeSeconds: 123.5,
    })
    expect(collector.collect().eventLoopUtilization).toBeCloseTo(1 / 3)
    expect(deltaInputs).toEqual([[10, -1], [30, 10]])
    expect(resets).toBe(2)
  })
})
