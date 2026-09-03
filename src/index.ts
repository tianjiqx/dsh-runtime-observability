import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeSnapshotCollector } from './runtime-snapshot.ts'
import { TelemetryQuality } from './quality.ts'
import { CountingMetricExporter } from './counting-exporter.ts'
import { ProfilingController } from './profiling.ts'
import type { Config, TelemetryQualitySnapshot } from './types.ts'

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
    const exports = meter.createObservableGauge('dsh.telemetry.export', {
      description: 'Observability exporter quality counters.', unit: '{record}',
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
      const quality = this.quality.snapshot()
      result.observe(exports, quality.exportAttempts, { outcome: 'attempt' })
      result.observe(exports, quality.exportFailures, { outcome: 'failure' })
      result.observe(exports, quality.consecutiveFailures, { outcome: 'consecutive_failure' })
      result.observe(exports, quality.logsSuppressed, { outcome: 'log_suppressed' })
      // §3.1.8 降级：event loop 饱和时自动停止 profiling（fire-and-forget）。
      void this.profiling?.autoStopOnPressure(values.eventLoopUtilization)
      // ELU 降级联动：metric export 也暂停，避免恶性循环。
      this.handleEluDegradation(values.eventLoopUtilization, eluPauseThreshold)
    }, [runtime, utilization, memory, activeResources, exports])
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
