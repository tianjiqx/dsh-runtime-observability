import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeSnapshotCollector } from './runtime-snapshot.ts'
import { TelemetryQuality } from './quality.ts'
import { CountingMetricExporter } from './counting-exporter.ts'
import { ProfilingController } from './profiling.ts'
import {
  ACTIVE_WORKLOAD_KINDS,
  QUEUE_WORKLOAD_KINDS,
  RECOVERY_WORKLOAD_KINDS,
  WorkloadMetrics,
} from './workload.ts'
import type { Config, TelemetryQualitySnapshot } from './types.ts'

export { WorkloadMetrics } from './workload.ts'
export type { ActiveWorkloadKind, QueueWorkloadKind, RecoveryWorkloadKind, WorkloadSnapshot } from './workload.ts'

const STATE = Symbol.for('dsh.runtime.observability.state')
const SCOPE = 'dsh-runtime-observability'

type RuntimeState = {
  references: number
  service: RuntimeObservability
  configKey: string
}

// One state per process prevents HMR from registering duplicate callbacks.
const processState = globalThis as typeof globalThis & { [key: symbol]: RuntimeState | undefined }

export class RuntimeObservability {
  readonly workload = new WorkloadMetrics()
  private readonly quality = new TelemetryQuality()
  private readonly snapshot = new RuntimeSnapshotCollector()
  private readonly provider: MeterProvider | undefined
  private readonly reader: PeriodicExportingMetricReader | undefined
  private readonly countingExporter: CountingMetricExporter | undefined
  private readonly runtimeInstrumentation: RuntimeNodeInstrumentation | undefined
  private readonly profiling: ProfilingController | undefined
  private profilingStartTimer: ReturnType<typeof setTimeout> | undefined
  private eluPaused = false
  private disposed = false

  constructor(rawConfig: Config = {}) {
    const config = normalizeConfig(rawConfig)
    if (config.enabled && config.endpoint) {
      const otlpExporter = new OTLPMetricExporter({ url: normalizeMetricsEndpoint(config.endpoint) })
      this.countingExporter = new CountingMetricExporter(otlpExporter, this.quality, console.warn, {
        logThrottlePerMinute: config.resilience.logThrottlePerMinute,
        circuitBreakerThreshold: config.resilience.circuitBreakerThreshold,
        circuitBreakerCooldownMs: config.resilience.circuitBreakerCooldownMs,
      })
      this.reader = new PeriodicExportingMetricReader({
        exporter: this.countingExporter,
        exportIntervalMillis: config.exportIntervalMillis,
      })
      this.provider = new MeterProvider({
        resource: resourceFromAttributes({
          'service.name': config.serviceName,
          'service.version': config.serviceVersion,
          'service.instance.id': config.serviceInstanceId,
          'process.pid': process.pid,
          'process.creation.time': new Date(Date.now() - process.uptime() * 1000).toISOString(),
        }),
        readers: [this.reader],
      })
      if (config.runtimeMetrics) {
        this.runtimeInstrumentation = new RuntimeNodeInstrumentation()
        this.runtimeInstrumentation.setMeterProvider(this.provider)
        this.runtimeInstrumentation.enable()
      }
      this.registerMetrics(config.resilience.eluPauseThreshold)
    }
    // Profiling (§3.1.8): off by default, gated by the master switch,
    // independent of the metrics endpoint, started on a throttled delay so
    // boot is never blocked by native loads.
    if (config.enabled && config.profiling.enabled && config.profiling.serverAddress) {
      const profiling = new ProfilingController({
        serverAddress: config.profiling.serverAddress,
        appName: config.profiling.appName,
        flushIntervalMs: config.profiling.flushIntervalMs,
        sampleRateMs: config.profiling.sampleRateMs,
        eluStopThreshold: config.profiling.eluStopThreshold,
      })
      this.profiling = profiling
      this.profilingStartTimer = setTimeout(() => { void profiling.start() }, config.profiling.bootDelayMs)
      this.profilingStartTimer.unref?.()
    }
  }

  telemetryQuality(): TelemetryQualitySnapshot {
    return this.quality.snapshot()
  }

  isDisposed(): boolean { return this.disposed }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.profilingStartTimer) clearTimeout(this.profilingStartTimer)
    this.snapshot.dispose()
    this.runtimeInstrumentation?.disable()
    await this.profiling?.stop()
    await this.provider?.shutdown()
  }

  private registerMetrics(eluPauseThreshold: number): void {
    const meter = this.provider?.getMeter(SCOPE)
    if (!meter) return
    const runtime = meter.createObservableGauge('dsh.runtime.event_loop.delay', {
      description: 'Node.js event loop delay in seconds.', unit: 's',
    })
    const utilization = meter.createObservableGauge('dsh.runtime.event_loop.utilization', {
      description: 'Node.js event loop utilization ratio.', unit: '1',
    })
    const memory = meter.createObservableGauge('dsh.runtime.memory', {
      description: 'Node.js process memory by area.', unit: 'By',
    })
    const activeResources = meter.createObservableGauge('dsh.runtime.active_resources', {
      description: 'Active Node.js resources by resource type.', unit: '{resource}',
    })
    const processCpuTime = meter.createObservableCounter('process.cpu.time', {
      description: 'Total CPU seconds consumed by the process.', unit: 's',
    })
    const processUptime = meter.createObservableGauge('process.uptime', {
      description: 'Seconds since the process started.', unit: 's',
    })
    // Keep the original combined gauge for dashboard compatibility while
    // exposing correctly typed counters and state gauges for new consumers.
    const exports = meter.createObservableGauge('dsh.telemetry.export', {
      description: 'Observability exporter quality counters.', unit: '{record}',
    })
    const exportAttempts = meter.createObservableCounter('dsh.telemetry.export.attempts', {
      description: 'Metric export batches attempted.', unit: '{attempt}',
    })
    const exportFailures = meter.createObservableCounter('dsh.telemetry.export.failures', {
      description: 'Metric export batches that failed.', unit: '{failure}',
    })
    const exportSkipped = meter.createObservableCounter('dsh.telemetry.export.skipped', {
      description: 'Metric export batches intentionally skipped by degradation reason.', unit: '{batch}',
    })
    const logsSuppressed = meter.createObservableCounter('dsh.telemetry.logs.suppressed', {
      description: 'Exporter failure log messages suppressed by throttling.', unit: '{log}',
    })
    const consecutiveFailures = meter.createObservableGauge('dsh.telemetry.export.consecutive_failures', {
      description: 'Current consecutive metric export failure count.', unit: '{failure}',
    })
    const circuitOpen = meter.createObservableGauge('dsh.telemetry.circuit.open', {
      description: 'Whether the metric export circuit breaker is open.', unit: '1',
    })
    const degradationEvents = meter.createObservableCounter('dsh.telemetry.degradation.events', {
      description: 'Telemetry degradation state transitions.', unit: '{event}',
    })
    const degradationDuration = meter.createObservableCounter('dsh.telemetry.degradation.duration', {
      description: 'Cumulative time spent in telemetry degradation.', unit: 's',
    })
    const degraded = meter.createObservableGauge('dsh.telemetry.degraded', {
      description: 'Whether telemetry is currently degraded.', unit: '1',
    })
    const workloadActive = meter.createObservableGauge('dsh.workload.active', {
      description: 'Currently active workload operations by fixed kind.', unit: '{operation}',
    })
    const workloadQueueDepth = meter.createObservableGauge('dsh.workload.queue.depth', {
      description: 'Queued workload operations by fixed kind.', unit: '{operation}',
    })
    const workloadQueueOldestAge = meter.createObservableGauge('dsh.workload.queue.oldest_age', {
      description: 'Age of the oldest queued workload operation.', unit: 's',
    })
    const workloadRecoveryBacklog = meter.createObservableGauge('dsh.workload.recovery.backlog', {
      description: 'Pending recovery work by fixed kind.', unit: '{item}',
    })
    meter.addBatchObservableCallback((result) => {
      const values = this.snapshot.collect()
      result.observe(runtime, values.eventLoopDelayP50Seconds, { quantile: '0.5' })
      result.observe(runtime, values.eventLoopDelayP90Seconds, { quantile: '0.9' })
      result.observe(runtime, values.eventLoopDelayP99Seconds, { quantile: '0.99' })
      result.observe(utilization, values.eventLoopUtilization)
      result.observe(memory, values.rssBytes, { area: 'rss' })
      result.observe(memory, values.heapUsedBytes, { area: 'heap_used' })
      result.observe(memory, values.heapTotalBytes, { area: 'heap_total' })
      result.observe(memory, values.externalBytes, { area: 'external' })
      result.observe(memory, values.arrayBuffersBytes, { area: 'array_buffers' })
      for (const [type, count] of values.activeResources) result.observe(activeResources, count, { type })
      result.observe(processCpuTime, values.processCpuUserSeconds, { 'cpu.mode': 'user' })
      result.observe(processCpuTime, values.processCpuSystemSeconds, { 'cpu.mode': 'system' })
      result.observe(processUptime, values.processUptimeSeconds)
      // Evaluate transitions before taking the quality snapshot so the first
      // post-recovery batch contains the complete pause ledger.
      void this.profiling?.autoStopOnPressure(values.eventLoopUtilization)
      this.handleEluDegradation(values.eventLoopUtilization, eluPauseThreshold)
      const quality = this.quality.snapshot()
      result.observe(exports, quality.exportAttempts, { outcome: 'attempt' })
      result.observe(exports, quality.exportFailures, { outcome: 'failure' })
      result.observe(exports, quality.consecutiveFailures, { outcome: 'consecutive_failure' })
      result.observe(exports, quality.logsSuppressed, { outcome: 'log_suppressed' })
      result.observe(exportAttempts, quality.exportAttempts)
      result.observe(exportFailures, quality.exportFailures)
      result.observe(logsSuppressed, quality.logsSuppressed)
      result.observe(consecutiveFailures, quality.consecutiveFailures)
      result.observe(circuitOpen, quality.circuitOpen ? 1 : 0)
      for (const reason of ['elu_pause', 'circuit_open'] as const) {
        result.observe(exportSkipped, quality.exportSkipped[reason], { reason })
        result.observe(degradationEvents, quality.degradationEvents[reason], { reason })
        result.observe(degradationDuration, quality.degradationDurationSeconds[reason], { reason })
        result.observe(degraded, quality.degradationActive[reason] ? 1 : 0, { reason })
      }
      const workload = this.workload.snapshot()
      for (const kind of ACTIVE_WORKLOAD_KINDS) result.observe(workloadActive, workload.active[kind], { kind })
      for (const kind of QUEUE_WORKLOAD_KINDS) {
        result.observe(workloadQueueDepth, workload.queueDepth[kind], { kind })
        result.observe(workloadQueueOldestAge, workload.queueOldestAgeSeconds[kind], { kind })
      }
      for (const kind of RECOVERY_WORKLOAD_KINDS) {
        result.observe(workloadRecoveryBacklog, workload.recoveryBacklog[kind], { kind })
      }
    }, [
      runtime, utilization, memory, activeResources, processCpuTime, processUptime,
      exports, exportAttempts, exportFailures, exportSkipped, logsSuppressed,
      consecutiveFailures, circuitOpen, degradationEvents, degradationDuration, degraded,
      workloadActive, workloadQueueDepth, workloadQueueOldestAge, workloadRecoveryBacklog,
    ])
  }

  /**
   * When ELU exceeds the pause threshold, gate metric exporter network I/O.
   * Resume when ELU drops below (threshold - hysteresis). The reader remains
   * alive so provider lifecycle stays stable while the delegate is paused.
   */
  private handleEluDegradation(elu: number, threshold: number): void {
    if (threshold <= 0) return
    if (!this.reader) return
    const hysteresis = 0.05
    if (!this.eluPaused && elu >= threshold) {
      this.eluPaused = true
      this.countingExporter?.setPaused(true)
      console.warn(`[dsh-runtime-observability] metric export paused: event loop utilization ${elu.toFixed(3)} ≥ ${threshold}`)
      // CountingMetricExporter gates the delegate and acknowledges the batch,
      // so the periodic reader performs no network I/O while paused.
    } else if (this.eluPaused && elu < threshold - hysteresis) {
      this.eluPaused = false
      this.countingExporter?.setPaused(false)
      console.warn(`[dsh-runtime-observability] metric export resumed: event loop utilization ${elu.toFixed(3)} < ${threshold - hysteresis}`)
    }
  }
}

type NormalizedProfiling = Required<NonNullable<Config['profiling']>>
type NormalizedResilience = Required<NonNullable<Config['resilience']>>
type NormalizedConfig = Required<Omit<Config, 'profiling' | 'resilience'>> & {
  profiling: NormalizedProfiling
  resilience: NormalizedResilience
}

function normalizeConfig(config: Config): NormalizedConfig {
  return {
    enabled: config.enabled ?? true,
    endpoint: config.endpoint ?? '',
    serviceName: config.serviceName ?? 'dsh-agent',
    serviceVersion: config.serviceVersion ?? 'unknown',
    serviceInstanceId: config.serviceInstanceId ?? process.pid.toString(),
    exportIntervalMillis: config.exportIntervalMillis ?? 10_000,
    runtimeMetrics: config.runtimeMetrics ?? true,
    profiling: normalizeProfiling(config),
    resilience: normalizeResilience(config),
  }
}

function normalizeProfiling(config: Config): NormalizedProfiling {
  const raw = config.profiling ?? {}
  return {
    enabled: raw.enabled ?? false,
    serverAddress: raw.serverAddress ?? '',
    appName: raw.appName ?? config.serviceName ?? 'dsh-agent',
    flushIntervalMs: raw.flushIntervalMs ?? 60_000,
    bootDelayMs: raw.bootDelayMs ?? 30_000,
    sampleRateMs: raw.sampleRateMs ?? 60_000,
    eluStopThreshold: raw.eluStopThreshold ?? 0.9,
  }
}

function normalizeResilience(config: Config): NormalizedResilience {
  const raw = config.resilience ?? {}
  return {
    logThrottlePerMinute: raw.logThrottlePerMinute ?? 5,
    circuitBreakerThreshold: raw.circuitBreakerThreshold ?? 10,
    circuitBreakerCooldownMs: raw.circuitBreakerCooldownMs ?? 5 * 60_000,
    eluPauseThreshold: raw.eluPauseThreshold ?? 0.95,
  }
}

export function apply(ctx: Context, config: Config = {}): RuntimeObservability {
  const configKey = stableStringify(normalizeConfig(config))
  let state = processState[STATE]
  if (!state || state.service.isDisposed() || state.configKey !== configKey) {
    void state?.service.dispose()
    state = { references: 0, service: new RuntimeObservability(config), configKey }
    processState[STATE] = state
  }
  state.references += 1
  const unprovide = ctx.provide('dshRuntimeObservability', state.service)
  ctx.effect(() => () => {
    unprovide()
    release(state)
  }, 'dsh-runtime-observability: cleanup')
  return state.service
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function release(state: RuntimeState | undefined): void {
  if (!state) return
  state.references -= 1
  if (state.references <= 0) {
    void state.service.dispose()
    if (processState[STATE] === state) processState[STATE] = undefined
  }
}

export function normalizeMetricsEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '')
  return normalized.endsWith('/v1/metrics') ? normalized : `${normalized}/v1/metrics`
}
