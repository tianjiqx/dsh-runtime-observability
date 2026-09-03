import { monitorEventLoopDelay } from 'node:perf_hooks'

export const NANOS_PER_SECOND = 1_000_000_000
export const MICROS_PER_SECOND = 1_000_000

export type RuntimeSnapshot = {
  eventLoopDelayP50Seconds: number
  eventLoopDelayP90Seconds: number
  eventLoopDelayP99Seconds: number
  eventLoopUtilization: number
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  activeResources: ReadonlyMap<string, number>
  processCpuUserSeconds: number
  processCpuSystemSeconds: number
  processUptimeSeconds: number
}

type EventLoopHistogram = {
  percentile(percentile: number): number
  reset(): void
}

type EventLoopUtilization = { utilization: number }
type EventLoopUtilizationSnapshot = EventLoopUtilization & { idle: number, active: number }

export function nanosecondsToSeconds(value: number): number {
  return value / NANOS_PER_SECOND
}

export function countActiveResources(resources: readonly string[], limit = 32): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const resource of resources) {
    if (counts.size === limit && !counts.has(resource)) continue
    counts.set(resource, (counts.get(resource) ?? 0) + 1)
  }
  return counts
}

export class RuntimeSnapshotCollector {
  private previousElu: EventLoopUtilizationSnapshot | undefined

  constructor(
    private readonly delay: EventLoopHistogram = monitorEventLoopDelay({ resolution: 20 }),
    private readonly readEluSnapshot: () => EventLoopUtilizationSnapshot =
      () => performance.eventLoopUtilization(),
    private readonly calculateElu: (
      current: EventLoopUtilizationSnapshot,
      previous?: EventLoopUtilizationSnapshot,
    ) => EventLoopUtilization = (current, previous) =>
      previous === undefined ? current : performance.eventLoopUtilization(current as never, previous as never),
    private readonly memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
    private readonly activeResources: () => string[] = () => process.getActiveResourcesInfo(),
    private readonly cpuUsage: () => NodeJS.CpuUsage = () => process.cpuUsage(),
    private readonly uptime: () => number = () => process.uptime(),
  ) {
    ;(this.delay as ReturnType<typeof monitorEventLoopDelay>).enable?.()
  }

  collect(): RuntimeSnapshot {
    const currentElu = this.readEluSnapshot()
    const elu = this.calculateElu(currentElu, this.previousElu)
    this.previousElu = currentElu
    const memory = this.memoryUsage()
    const cpu = this.cpuUsage()
    const snapshot: RuntimeSnapshot = {
      eventLoopDelayP50Seconds: nanosecondsToSeconds(this.delay.percentile(50)),
      eventLoopDelayP90Seconds: nanosecondsToSeconds(this.delay.percentile(90)),
      eventLoopDelayP99Seconds: nanosecondsToSeconds(this.delay.percentile(99)),
      eventLoopUtilization: elu.utilization,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      activeResources: countActiveResources(this.activeResources()),
      processCpuUserSeconds: cpu.user / MICROS_PER_SECOND,
      processCpuSystemSeconds: cpu.system / MICROS_PER_SECOND,
      processUptimeSeconds: this.uptime(),
    }
    this.delay.reset()
    return snapshot
  }

  dispose(): void {
    ;(this.delay as ReturnType<typeof monitorEventLoopDelay>).disable?.()
  }
}
