import type { TelemetryQualitySnapshot } from './types.ts'

/**
 * Tracks telemetry pipeline health: cumulative counters for attempts/failures,
 * a sliding-window consecutive-failure counter for the circuit breaker, and a
 * token-bucket log throttle so a dead endpoint cannot flood stderr.
 */
export class TelemetryQuality {
  private exportAttempts = 0
  private exportFailures = 0
  private consecutiveFailures = 0
  private circuitOpen = false
  private circuitOpenedAt = 0

  // Log throttle: token bucket, max `maxTokens` logs per `windowMs`.
  private logTokens: number
  private logLastRefill = 0
  private logsSuppressed = 0

  constructor(
    private readonly maxTokens: number = 5,
    private readonly windowMs: number = 60_000,
  ) {
    this.logTokens = maxTokens
    this.logLastRefill = now()
  }

  recordExportAttempt(): void { this.exportAttempts += 1 }

  recordExportFailure(): void {
    this.exportFailures += 1
    this.consecutiveFailures += 1
  }

  /** Called by the exporter after a successful batch. */
  recordExportSuccess(): void {
    this.consecutiveFailures = 0
    if (this.circuitOpen) {
      this.circuitOpen = false
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
    this.circuitOpenedAt = now()
    return true
  }

  /**
   * Returns true when the circuit breaker cooldown has elapsed and a single
   * probe export should be allowed through. Caller must reset state on the
   * probe result via recordExportSuccess / recordExportFailure.
   */
  shouldProbe(cooldownMs: number): boolean {
    if (!this.circuitOpen) return false
    return now() - this.circuitOpenedAt >= cooldownMs
  }

  /**
   * Returns true if a failure log line should be emitted right now. When the
   * bucket is empty, the call is suppressed and `logsSuppressed` increments.
   */
  consumeLogToken(): boolean {
    const t = now()
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
    return {
      exportAttempts: this.exportAttempts,
      exportFailures: this.exportFailures,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpen,
      logsSuppressed: this.logsSuppressed,
    }
  }
}

function now(): number {
  return Date.now()
}
