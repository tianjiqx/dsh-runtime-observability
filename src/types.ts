export interface Config {
  enabled?: boolean
  /** OTLP/HTTP metrics endpoint. Undefined keeps the plugin local-only. */
  endpoint?: string
  serviceName?: string
  serviceVersion?: string
  serviceInstanceId?: string
  exportIntervalMillis?: number
  runtimeMetrics?: boolean
  /**
   * Continuous profiling (§3.1.8). Disabled by default; `serverAddress` must
   * point at a Pyroscope server. `bootDelayMs` delays the initial native load;
   * `sampleRateMs` is retained for backward compatibility and is deprecated;
   * `eluStopThreshold` auto-stops profiling when the event loop saturates.
   */
  profiling?: {
    enabled?: boolean
    serverAddress?: string
    appName?: string
    bootDelayMs?: number
    flushIntervalMs?: number
    /** @deprecated use bootDelayMs; Pyroscope SDK controls sample cadence. */
    sampleRateMs?: number
    eluStopThreshold?: number
  }
  /**
   * Export resilience controls.
   * - `logThrottlePerMinute`: max failure log lines per minute (default 5).
   * - `circuitBreakerThreshold`: consecutive failures before pausing exports
   *   (default 10; 0 disables the circuit breaker).
   * - `circuitBreakerCooldownMs`: how long the breaker stays open before
   *   allowing a probe export through (default 5 minutes).
   * - `eluPauseThreshold`: event-loop utilization at which metric export is
   *   paused alongside profiling (default 0.95; 0 disables).
   */
  resilience?: {
    logThrottlePerMinute?: number
    circuitBreakerThreshold?: number
    circuitBreakerCooldownMs?: number
    eluPauseThreshold?: number
  }
}

export interface TelemetryQualitySnapshot {
  exportAttempts: number
  exportFailures: number
  consecutiveFailures: number
  circuitOpen: boolean
  logsSuppressed: number
}
