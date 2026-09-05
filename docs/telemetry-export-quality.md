# Telemetry Export Quality

> Metrics source: **this plugin** exposes `dsh.telemetry.export.*` and `dsh.telemetry.degradation.*`. Legacy `dsh.telemetry.export{outcome}` is retained for dashboard compatibility.
> Related: [ELU Guide](./elu-event-loop-utilization.md) (ELU is one condition for export pause) · [README](../README.md) Resilience section (throttle/circuit breaker configuration)

---

## 1. Definition

**Telemetry export quality = the plugin's success/failure ledger for pushing OTLP metrics to the Collector**. It monitors the observation pipeline's first hop — answering "is this process's metrics still shipping reliably?"

New metrics appear in Prometheus with `dsh_dsh_telemetry_*` prefix after Collector namespace transformation. Counters carry `_total` suffix.

## 2. Cumulative Ledger & Current State

| OTel Metric | Type | Meaning | Healthy State |
|---|---|---|---|
| `dsh.telemetry.export.attempts` | Counter | Batches actually sent to delegate | Continuously increasing |
| `dsh.telemetry.export.failures` | Counter | Batches where delegate returned failure | Increment = 0 |
| `dsh.telemetry.export.skipped{reason}` | Counter | Intentionally skipped batches | Increment = 0 |
| `dsh.telemetry.export.consecutive_failures` | Gauge | Current consecutive failure count | 0 |
| `dsh.telemetry.logs.suppressed` | Counter | Log messages suppressed by throttling | Increment = 0 |
| `dsh.telemetry.circuit.open` | Gauge | Whether circuit breaker is open | 0 |
| `dsh.telemetry.degradation.events{reason}` | Counter | Degradation state transitions | Usually not increasing |
| `dsh.telemetry.degradation.duration{reason}` | Counter | Cumulative degradation seconds | Usually not increasing |
| `dsh.telemetry.degraded{reason}` | Gauge | Whether currently in degradation state | 0 |

`reason` has only two fixed values: `elu_pause` and `circuit_open`.

**Failures do not block business**: Export failures only write local warnings (and are throttled); Agent Run is unaffected — this is the plugin's fail-open design baseline.

## 3. Diagnosis Flow

```
skipped increased?
├─ reason=elu_pause     → ELU self-protection pause; duration backfills the gap on recovery
├─ reason=circuit_open  → Circuit breaker skip after consecutive export failures
└─ not increased
   ├─ failure increased → Real delegate/network/Collector first-hop failure
   └─ attempt growing   → Healthy shipping
```

**Active pause does not increase failure.** During pause, the same OTLP metrics channel cannot send its own status in real-time; the plugin accumulates skipped/event/duration in memory and backfills on recovery. Real-time detection still requires independent logs or process probes.

Key distinction: **This metric covers "process → Collector" first hop; what happens after the Collector (→ Prometheus/ClickHouse) is monitored by `collector_exporter_failures` / `otel_logs_freshness`**. Don't conflate the two.

## 4. Diagnosis Example

| Instance | attempt | failure | Assessment |
|---|---|---|---|
| dsh-agent | 398 | 0 | ✅ All successful |
| dsh-agent-web2 | 605 | 18 (cumulative) | ✅ Currently healthy: 24h +128 failures concentrated in 6~12h ago (restart window), last 1h increment 0, no `consecutive_failure` sequence |

Cross-validation with self-protection: failures without `log_suppressed`/`circuit_open` (threshold not triggered) indicates intermittent failures rather than sustained chain breakage.

## 5. Remediation Playbook

1. **Currently failing consecutively**: Check `export.consecutive_failures` and `circuit.open`, then inspect Collector port 13133 and network.
2. **ELU active pause**: After recovery, check `skipped{reason="elu_pause"}` and corresponding duration increment; don't count it as failure.
3. **Circuit breaker open**: Wait for cooldown half-open probe; quantify the gap with `reason="circuit_open"` skipped.
4. **Verify recovery**: attempt resumes growing, no new failures, degraded returns to 0, duration stops increasing.

## 6. Post-Deployment Queries

Prometheus metric names may vary based on Collector transformation — verify with actual deployment.

```promql
# Per-instance success/failure totals
dsh_dsh_telemetry_export_attempts_total
dsh_dsh_telemetry_export_failures_total

# Real failure increment over 24h
sum by (exported_job) (increase(dsh_dsh_telemetry_export_failures_total[24h]))

# Intentionally skipped batches
sum by (exported_job, reason) (increase(dsh_dsh_telemetry_export_skipped_total[24h]))

# Current degradation state and cumulative duration
dsh_dsh_telemetry_degraded_ratio
dsh_dsh_telemetry_degradation_duration_seconds_total

# Export success rate
1 - (sum(increase(dsh_dsh_telemetry_export_failures_total[1h]))
   / clamp_min(sum(increase(dsh_dsh_telemetry_export_attempts_total[1h])), 1e-9))
```
