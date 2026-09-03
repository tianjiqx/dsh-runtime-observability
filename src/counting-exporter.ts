import { AggregationTemporality, type InstrumentType, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics'
import type { TelemetryQuality } from './quality.ts'

/**
 * Resilience options for the counting exporter.
 */
export interface CountingExporterOptions {
  /**
   * Max failure log lines per minute. Defaults to 5. Set 0 to silence all
   * failure logs (counters still increment).
   */
  logThrottlePerMinute?: number
  /**
   * Consecutive failures before the circuit opens and exports are skipped.
   * Defaults to 10. Set 0 to disable the circuit breaker.
   */
  circuitBreakerThreshold?: number
  /**
   * How long the breaker stays open before a single probe export is allowed
   * through. Defaults to 5 minutes.
   */
  circuitBreakerCooldownMs?: number
}

/**
 * Wraps an OTLP metric exporter with:
 * - cumulative attempt/failure counters (observable via `dsh.telemetry.export`)
 * - a token-bucket log throttle so a dead endpoint cannot flood stderr
 * - a circuit breaker that pauses exports after N consecutive failures and
 *   resumes after a cooldown with a single probe request
 *
 * A failed batch is reported locally and left to the SDK's configured retry
 * behavior; it is never rethrown into an Agent Run.
 */
export class CountingMetricExporter implements PushMetricExporter {
  private readonly logThrottlePerMinute: number
  private readonly circuitBreakerThreshold: number
  private readonly circuitBreakerCooldownMs: number
  private probing = false
  private paused = false

  constructor(
    private readonly delegate: PushMetricExporter,
    private readonly quality: TelemetryQuality,
    private readonly warn: (message: string) => void = console.warn,
    options: CountingExporterOptions = {},
  ) {
    this.logThrottlePerMinute = options.logThrottlePerMinute ?? 5
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 10
    this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 5 * 60_000
  }

  isCircuitOpen(): boolean {
    return this.quality.snapshot().circuitOpen && !this.probing
  }

  isPaused(): boolean { return this.paused }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    if (paused) this.quality.startDegradation('elu_pause')
    else this.quality.endDegradation('elu_pause')
  }

  export(metrics: ResourceMetrics, resultCallback: Parameters<PushMetricExporter['export']>[1]): void {
    if (this.paused) {
      this.quality.recordExportSkipped('elu_pause')
      resultCallback({ code: 0 })
      return
    }
    const snap = this.quality.snapshot()

    // Circuit breaker: when open, skip the export entirely unless it's time
    // for a single probe request.
    if (snap.circuitOpen) {
      if (this.quality.shouldProbe(this.circuitBreakerCooldownMs)) {
        this.probing = true
        // fall through to let one export through
      } else {
        this.quality.recordExportSkipped('circuit_open')
        // Pretend success so the SDK reader doesn't stall; the quality
        // counters still reflect the skipped attempt.
        resultCallback({ code: 0 })
        return
      }
    }

    this.quality.recordExportAttempt()
    this.delegate.export(metrics, (result) => {
      const wasProbe = this.probing
      this.probing = false

      if (result.code !== 0) {
        this.quality.recordExportFailure()
        if (this.quality.consumeLogToken()) {
          this.warn(`[dsh-runtime-observability] metric export failed: ${result.error?.message ?? 'unknown error'}`)
        }
        if (this.quality.tripCircuitBreaker(this.circuitBreakerThreshold)) {
          this.warn(`[dsh-runtime-observability] circuit breaker open: ${this.circuitBreakerThreshold} consecutive failures, pausing exports for ${this.circuitBreakerCooldownMs / 1000}s`)
        }
      } else {
        this.quality.recordExportSuccess()
        if (wasProbe) {
          this.warn('[dsh-runtime-observability] circuit breaker closed: probe export succeeded')
        }
      }
      resultCallback(result)
    })
  }

  forceFlush(): Promise<void> { return this.delegate.forceFlush() }
  shutdown(): Promise<void> { return this.delegate.shutdown() }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this.delegate.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE
  }
}
