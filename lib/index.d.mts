import { Context } from "@deepseek-ai/cordis";
//#region src/workload.d.ts
declare const ACTIVE_WORKLOAD_KINDS: readonly ["agent_run", "llm", "tool", "mcp"];
declare const QUEUE_WORKLOAD_KINDS: readonly ["agent_run", "llm", "tool", "mcp"];
declare const RECOVERY_WORKLOAD_KINDS: readonly ["session", "task", "ledger"];
type ActiveWorkloadKind = typeof ACTIVE_WORKLOAD_KINDS[number];
type QueueWorkloadKind = typeof QUEUE_WORKLOAD_KINDS[number];
type RecoveryWorkloadKind = typeof RECOVERY_WORKLOAD_KINDS[number];
interface WorkloadSnapshot {
  active: Readonly<Record<ActiveWorkloadKind, number>>;
  queueDepth: Readonly<Record<QueueWorkloadKind, number>>;
  queueOldestAgeSeconds: Readonly<Record<QueueWorkloadKind, number>>;
  recoveryBacklog: Readonly<Record<RecoveryWorkloadKind, number>>;
}
/**
 * Process-local, low-cardinality workload state. Integrations call this facade
 * only at real lifecycle boundaries; it never infers work from Promise or
 * active-handle counts.
 */
declare class WorkloadMetrics {
  private readonly active;
  private readonly queueDepth;
  private readonly queueOldestAgeSeconds;
  private readonly recoveryBacklog;
  begin(kind: ActiveWorkloadKind): () => void;
  setQueue(kind: QueueWorkloadKind, depth: number, oldestAgeSeconds?: number): void;
  setRecoveryBacklog(kind: RecoveryWorkloadKind, count: number): void;
  snapshot(): WorkloadSnapshot;
}
//#endregion
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
  readonly workload: WorkloadMetrics;
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
export { type ActiveWorkloadKind, type QueueWorkloadKind, type RecoveryWorkloadKind, RuntimeObservability, WorkloadMetrics, type WorkloadSnapshot, apply, normalizeMetricsEndpoint };