import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
interface Config {
  enabled?: boolean;
  /** OTLP/HTTP metrics endpoint. Undefined keeps the plugin local-only. */
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  serviceInstanceId?: string;
  exportIntervalMillis?: number;
  runtimeMetrics?: boolean;
  /**
   * Continuous profiling (§3.1.8). Disabled by default; `serverAddress` must
   * point at a Pyroscope server. `bootDelayMs` delays the initial native load;
   * `sampleRateMs` is retained for backward compatibility and is deprecated;
   * `eluStopThreshold` auto-stops profiling when the event loop saturates.
   */
  profiling?: {
    enabled?: boolean;
    serverAddress?: string;
    appName?: string;
    bootDelayMs?: number;
    flushIntervalMs?: number;
    /** @deprecated use bootDelayMs; Pyroscope SDK controls sample cadence. */
    sampleRateMs?: number;
    eluStopThreshold?: number;
  };
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
    logThrottlePerMinute?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerCooldownMs?: number;
    eluPauseThreshold?: number;
  };
}
type TelemetryDegradationReason = 'elu_pause' | 'circuit_open';
interface TelemetryQualitySnapshot {
  exportAttempts: number;
  exportFailures: number;
  exportSkipped: Record<TelemetryDegradationReason, number>;
  consecutiveFailures: number;
  circuitOpen: boolean;
  logsSuppressed: number;
  degradationEvents: Record<TelemetryDegradationReason, number>;
  degradationDurationSeconds: Record<TelemetryDegradationReason, number>;
  degradationActive: Record<TelemetryDegradationReason, boolean>;
}
//#endregion
//#region src/index.d.ts
declare class RuntimeObservability {
  private readonly quality;
  private readonly snapshot;
  private readonly provider;
  private readonly reader;
  private readonly countingExporter;
  private readonly runtimeInstrumentation;
  private readonly profiling;
  private profilingStartTimer;
  private eluPaused;
  private disposed;
  constructor(rawConfig?: Config);
  telemetryQuality(): TelemetryQualitySnapshot;
  isDisposed(): boolean;
  dispose(): Promise<void>;
  private registerMetrics;
  /**
   * When ELU exceeds the pause threshold, gate metric exporter network I/O.
   * Resume when ELU drops below (threshold - hysteresis). The reader remains
   * alive so provider lifecycle stays stable while the delegate is paused.
   */
  private handleEluDegradation;
}
declare function apply(ctx: Context, config?: Config): RuntimeObservability;
declare function normalizeMetricsEndpoint(endpoint: string): string;
//#endregion
export { RuntimeObservability, apply, normalizeMetricsEndpoint };