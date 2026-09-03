import type { TelemetryDegradationReason, TelemetryQualitySnapshot } from './types.ts'

const DEGRADATION_REASONS: readonly TelemetryDegradationReason[] = ['elu_pause', 'circuit_open']

function zeroByReason(): Record<TelemetryDegradationReason, number> {
  return { elu_pause: 0, circuit_open: 0 }
}

/**
 * Tracks telemetry pipeline health: cumulative counters for attempts/failures,
 * a sliding-window consecutive-failure counter for the circuit breaker, and a
 * token-bucket log throttle so a dead endpoint cannot flood stderr.
 */
export class TelemetryQuality {
  private exportAttempts = 0
  private exportFailures = 0
  private readonly exportSkipped = zeroByReason()
  private consecutiveFailures = 0
  private circuitOpen = false
  private circuitOpenedAt = 0

  // Log throttle: token bucket, max `maxTokens` logs per `windowMs`.
  private logTokens: number
  private logLastRefill = 0
  private logsSuppressed = 0
  private readonly degradationEvents = zeroByReason()
  private readonly degradationDurationMs = zeroByReason()
  private readonly degradationStartedAt: Partial<Record<TelemetryDegradationReason, number>> = {}

  constructor(
    private readonly maxTokens: number = 5,
    private readonly windowMs: number = 60_000,
    private readonly nowMs: () => number = now,
  ) {
    this.logTokens = maxTokens
    this.logLastRefill = this.nowMs()
  }

  recordExportAttempt(): void { this.exportAttempts += 1 }

  recordExportFailure(): void {
    this.exportFailures += 1
    this.consecutiveFailures += 1
  }

  recordExportSkipped(reason: TelemetryDegradationReason): void {
    this.exportSkipped[reason] += 1
  }

  startDegradation(reason: TelemetryDegradationReason): void {
    if (this.degradationStartedAt[reason] !== undefined) return
    this.degradationStartedAt[reason] = this.nowMs()
    this.degradationEvents[reason] += 1
  }

  endDegradation(reason: TelemetryDegradationReason): void {
    const startedAt = this.degradationStartedAt[reason]
    if (startedAt === undefined) return
    this.degradationDurationMs[reason] += Math.max(0, this.nowMs() - startedAt)
    delete this.degradationStartedAt[reason]
  }

  /** Called by the exporter after a successful batch. */
  recordExportSuccess(): void {
    this.consecutiveFailures = 0
    if (this.circuitOpen) {
      this.circuitOpen = false
      this.endDegradation('circuit_open')
    }
  }

  /**
   * Returns true when the circuit breaker should OPEN (consecutive failures
   * reached the threshold). Caller is responsible for the actual pause.
   */
  tripCircuitBreaker(threshold: number): boolean {
    if (threshold <= 0) return false
    if (this.consecutiveFailures < threshold) return false
    if (this.circuitOpen) return false
    this.circuitOpen = true
    this.circuitOpenedAt = this.nowMs()
    this.startDegradation('circuit_open')
    return true
  }

  /**
   * Returns true when the circuit breaker cooldown has elapsed and a single
   * probe export should be allowed through. Caller must reset state on the
   * probe result via recordExportSuccess / recordExportFailure.
   */
  shouldProbe(cooldownMs: number): boolean {
    if (!this.circuitOpen) return false
    return this.nowMs() - this.circuitOpenedAt >= cooldownMs
  }

  /**
   * Returns true if a failure log line should be emitted right now. When the
   * bucket is empty, the call is suppressed and `logsSuppressed` increments.
   */
  consumeLogToken(): boolean {
    const t = this.nowMs()
    const elapsed = t - this.logLastRefill
    if (elapsed > 0) {
      // Refill tokens proportional to elapsed time.
      const refill = (elapsed / this.windowMs) * this.maxTokens
      if (refill > 0) {
        this.logTokens = Math.min(this.maxTokens, this.logTokens + refill)
        this.logLastRefill = t
      }
    }
    if (this.logTokens >= 1) {
      this.logTokens -= 1
      return true
    }
    this.logsSuppressed += 1
    return false
  }

  snapshot(): TelemetryQualitySnapshot {
    const capturedAt = this.nowMs()
    const degradationDurationSeconds = zeroByReason()
    const degradationActive = { elu_pause: false, circuit_open: false }
    for (const reason of DEGRADATION_REASONS) {
      const startedAt = this.degradationStartedAt[reason]
      const activeMs = startedAt === undefined ? 0 : Math.max(0, capturedAt - startedAt)
      degradationDurationSeconds[reason] = (this.degradationDurationMs[reason] + activeMs) / 1000
      degradationActive[reason] = startedAt !== undefined
    }
    return {
      exportAttempts: this.exportAttempts,
      exportFailures: this.exportFailures,
      exportSkipped: { ...this.exportSkipped },
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpen,
      logsSuppressed: this.logsSuppressed,
      degradationEvents: { ...this.degradationEvents },
      degradationDurationSeconds,
      degradationActive,
    }
  }
}

function now(): number {
  return Date.now()
}
