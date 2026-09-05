# Event Loop Utilization (ELU)

> Scope: All DSH Node.js processes (dsh-agent, dsh-agent-web2, etc.)
> Metrics source: **this plugin** exposes `dsh.runtime.event_loop.utilization` and other `dsh.runtime.*` signals; companion metrics `dsh_nodejs_*`/`dsh_v8js_*` come from the community package `@opentelemetry/instrumentation-runtime-node` (dependency).
> Related: [README](../README.md) (plugin configuration: ELU self-protection thresholds / export resilience)

---

## 1. Definition

**ELU (Event Loop Utilization) = the proportion of time the Node.js event loop is "busy" within an observation window**, ranging 0~1.

- `0.9` = 90% of the time in this window, the thread was processing; only 10% idle
- `0` = Event loop completely idle
- `1` = No rest during the entire window; new events can only queue

## 2. Background: Why This Metric Matters

Node.js uses a **single thread** to run JS: all request handlers, callbacks, and timers queue up, and the event loop processes them one round at a time.

- **Busy** (executing JS code, including synchronous I/O, serialization, computation) = blocked state, all other requests wait
- **Idle** (queue empty) = waiting for I/O completion, waiting for next timer

Therefore, "how busy is the event loop" directly determines whether the process can accept new work — this is exactly what ELU measures. Node ≥ 14.10 provides the native `performance.eventLoopUtilization()` API; the plugin computes and exports it periodically.

## 3. ELU vs CPU Usage (Most Commonly Confused)

| | CPU % | ELU |
|---|---|---|
| Perspective | Entire machine (all cores) | Single process's JS thread |
| Measures | Consumption (how much compute used) | **Saturation (proportion the single thread is occupied)** |
| Single thread maxed on 16-core machine | ≈ 6% | = 1.0 |

**"ELU 0.9 but CPU only ~10%" is completely possible**: JS thread is stuck in synchronous computation while the other 15 cores sit idle. CPU% can't reveal single-thread bottlenecks; only ELU can.

## 4. Metric Pipeline in DSH

```
dsh-runtime-observability plugin (dsh.runtime.event_loop.utilization, 10s collection)
  → OTLP/HTTP → OTel Collector (namespace=dsh)
  → Prometheus metric: dsh_dsh_runtime_event_loop_utilization_ratio
```

Companion metrics (same source plugin):

| Prometheus Metric | Meaning |
|---|---|
| `dsh_dsh_runtime_event_loop_utilization_ratio` | ELU (main metric) |
| `dsh_dsh_runtime_event_loop_delay_seconds{quantile=...}` | Plugin's own delay percentiles p50/p90/p99 (seconds) |
| `dsh_nodejs_eventloop_utilization_ratio` | Community package ELU (cross-validation) |
| `dsh_nodejs_eventloop_delay_p50/p90/p99_seconds` | Community package delay percentiles (cross-validation) |

Plugin ELU and community package ELU values are expected to be close (same algorithm, slightly different windows); viewing both can rule out single-implementation bias.

## 5. Value Interpretation

### 5.1 Experience-Based Grading

(OpenTelemetry runtime semantics / Google SRE saturation methodology)

| ELU | Grade | Assessment |
|---|---|---|
| < 0.5 | Healthy | Normal headroom |
| 0.5 ~ 0.7 | Elevated | Start monitoring trend |
| 0.7 ~ 0.9 | Congested | Latency begins rising |
| > 0.9 | Saturated | New requests queue, latency avalanche risk |

### 5.2 Combined with Delay Percentiles (Critical)

ELU is a **window average** (10s); delay percentiles show **spikes** — both must be read together:

| Combination | Meaning |
|---|---|
| ELU low + p99 low | Healthy, no action needed |
| ELU high + p50 high + p99 high | Sustained saturation, capacity insufficient |
| ELU high + p50 normal + p99 spike | **Periodic long blocking**: busy on average, intermittent large tasks occupy the thread (large sync computation/GC/sync I/O) |
| ELU low + p99 spike | Occasional blocking (disk jitter/single large object operation), low frequency — observe first |

## 6. Plugin ELU Self-Protection Mechanism

`dsh-runtime-observability` uses ELU as a degradation trigger (preventing observation itself from加剧 saturation):

| Config | Default | Behavior When Triggered |
|---|---|---|
| `profiling.eluStopThreshold` | 0.9 | Automatically stops Pyroscope profile collection and logs reason |
| `resilience.eluPauseThreshold` | 0.95 | Both profiling **and** metric export degrade simultaneously |

Rationale: When ELU is saturated, doing network I/O (exporting, uploading profiles) only makes things worse; all thresholds can be overridden in Cordis patch config, set to 0 to disable.

**Operations insight**: When profiling samples stop, first check ELU at that time — it may be the plugin's active self-protection, not a Pyroscope failure.

## 7. Diagnosis Example

| Instance | ELU | EL delay p50/p99 | RSS/heap_used | Assessment |
|---|---|---|---|---|
| dsh-agent | 0.44 ~ 0.52 | 20ms / 41ms | 1.73GB / 569MB | Healthy range |
| dsh-agent-web2 | **0.90 ~ 0.91** | 20ms / **2.87s** | 1.71GB / 985MB | **True saturation** (see below) |

web2 diagnosis chain:

1. ELU 0.90 has reached the profiling auto-stop line, one step from the export degradation line (0.95)
2. p50 20ms normal + p99 2.87s spike + ELU high = "periodic long blocking" pattern (§5.2 row 3): not continuous freeze, but intermittent large tasks occupying the thread
3. heap_used 985MB elevated; GC pause itself is a candidate suspect
4. web2 is a collaborative GUI host, load pattern correlates with multi-session concurrency

## 8. High ELU Remediation Playbook

Execute in order:

1. **Find synchronous blocking points** (most common cause)
   - Large object `JSON.parse/stringify`
   - Synchronous crypto (`pbkdf2Sync`, etc.)
   - Synchronous FS (`existsSync`/`readFileSync`/`writeFileSync`)
   - Large loop computation (un-chunked batch processing)
2. **Offload CPU-intensive work**: worker threads / child processes, free the main thread
3. **Check GC pressure**: cross-reference `dsh_v8js_gc_duration_seconds_*` with heap trend; heap continuously rising + GC slowing = investigate memory leak or adjust heap config
4. **Pyroscope flame graph to locate functions**: Grafana → Explore → Pyroscope datasource → `service_name=<target instance>` → Wall profile; immediately see which function consumes the event loop
5. **Capacity fallback**: If business volume genuinely grew, split processes/instances (note: restarting GUI host kills active sessions, requires maintenance window)

## 9. Common Queries

Prometheus metric names may vary based on Collector transformation — verify with actual deployment.

```promql
# Current ELU per instance
dsh_dsh_runtime_event_loop_utilization_ratio

# Recent 1h ELU average (trend)
avg_over_time(dsh_dsh_runtime_event_loop_utilization_ratio[1h])

# ELU saturation sample count (samples > 0.9 in 1h; at 10s interval, max is 360)
count_over_time((dsh_dsh_runtime_event_loop_utilization_ratio > 0.9)[1h:])

# Companion delay percentiles (overlay with ELU on same chart)
dsh_dsh_runtime_event_loop_delay_seconds{quantile="0.99"}
dsh_nodejs_eventloop_delay_p99_seconds

# GC duration rate (investigate GC suspicion)
rate(dsh_v8js_gc_duration_seconds_sum[5m])
```

View in Grafana: Runtime Diagnostics dashboard, Event Loop row.

## 10. References

- Node.js official: `perf_hooks.performance.eventLoopUtilization()` (≥ 14.10)
- OpenTelemetry `@opentelemetry/instrumentation-runtime-node` (source of `dsh_nodejs_*` metrics)
- Google SRE "Site Reliability Engineering" §3 — Utilization / Saturation layered (USE method)
- Plugin source and [README](../README.md) (ELU self-protection thresholds, export resilience configuration)
