# Event Loop Delay

> Metrics source: **this plugin** exposes `dsh.runtime.event_loop.delay{quantile}`; companion metrics `dsh_nodejs_eventloop_delay_*` come from the community package `@opentelemetry/instrumentation-runtime-node` (dependency).
> Related: [ELU Guide](./elu-event-loop-utilization.md) (ELU saturation, the delay perspective complement) · [README](../README.md) (plugin configuration)

---

## 1. Definition

**Event Loop Delay = how long a timer callback was actually postponed from its scheduled execution time**.

Node.js implementation: After `setTimeout(fn, 1)`, measure the difference between when `fn` actually executes and when it was scheduled. When the event loop is idle, the difference ≈ 1ms + jitter; when the thread is occupied by previous tasks, the difference equals the occupation duration — so it directly measures **how long the main thread was blocked in a single instance**.

## 2. Two Implementations, Two Perspectives (Must Read Together)

| Perspective | Plugin Metric | Prometheus Name | Characteristics |
|---|---|---|---|
| Single block duration | `dsh.runtime.event_loop.delay{quantile}` | `dsh_dsh_runtime_event_loop_delay_seconds` | quantile=0.5/0.9/0.99 **three series**; p99 directly answers "how long the worst round was blocked" |
| Rolling window percentile | `dsh_nodejs_eventloop_delay_p50/p90/p99_*` | Same name | Community package 1min rolling statistics; also mean/min/max/stddev |

The two p99 values are expected to be close (same algorithm, different implementations) for cross-validation; the plugin version is better for "seeing real-time spike values", the community package version for "seeing the 1min window shape".

Division of labor with ELU: **ELU says "busy or not" (proportion), delay says "how long blocked" (absolute duration)**. The web2 pattern = ELU 0.90 (busy) + p50 20ms (normally not blocked) + p99 2.9s (occasional large block).

## 3. Percentile Value Interpretation

| Metric | Healthy | Watch | Action Line | Notes |
|---|---|---|---|---|
| p50 | < 10ms | < 50ms | > 100ms | Steady state; sustained >100ms means chronic overload, not occasional |
| p90 | < 50ms | < 100ms | > 200ms | Upper bound for normal load |
| **p99** | < 100ms | < 500ms | **> 1s** | **Core alert position**: single block >1s causes perceptible UI/streaming lag; evaluate in conjunction with plugin ELU degradation lines (0.90/0.95) |

Thresholds are built into the Runtime Diagnostics dashboard (p99 + ELU overlaid on same chart).

## 4. Combined Diagnosis with GC / Memory

Priority order for identifying the three main suspects of p99 long blocks:

1. **GC major** (cross-reference [memory-gc.md](./memory-gc.md) `dsh_v8js_gc_duration_seconds_bucket` p95): GC p95 and EL delay p99 same order of magnitude = block mostly caused by GC
2. **Large synchronous computation/serialization** (locate with Pyroscope Wall profile)
3. **Synchronous I/O** (check for `*Sync` calls in code)

## 5. Diagnosis Example

| Instance | p50 / p90 / p99 | Community Package mean / 1h peak | Assessment |
|---|---|---|---|
| dsh-agent | 20ms / 21ms / 42ms | 10.6ms / 33ms | ✅ Healthy |
| dsh-agent-web2 | 20ms / 25ms / **2.95s** | 94ms / **3.34s** | 🔴 Periodic long blocks (sustained worsening: p99 from 2.87s → 2.95s) |

web2: p50/p90 normal + p99 ≈3s = most requests experience good service, but a few hitting the block window experience extremely poor service; block source identification follows §4 priority (GC p95 only 9.4ms, **rules out GC** → points to large synchronous computation, locate with Pyroscope).

## 6. Remediation Playbook

1. p99 sustained >1s: Pyroscope Wall profile for `service_name=<instance>` to find the widest stack
2. Common culprits: large JSON `parse/stringify`, un-chunked large loops, synchronous crypto/FS, `child_process.execSync`
3. Chunked processing (yield thread with `setImmediate` every N ms) or move to worker threads
4. Post-fix verification: p99 drops in same window + ELU drops + telemetry export failures stop increasing (once blocks are cleared, export is no longer suppressed by ELU gating)

## 7. Common Queries

Prometheus metric names may vary based on Collector transformation — verify with actual deployment.

```promql
# All three percentiles together (overlay ELU for best insight)
dsh_dsh_runtime_event_loop_delay_seconds
dsh_dsh_runtime_event_loop_utilization_ratio

# 1h p99 peak (has second-level blocking occurred?)
max_over_time(dsh_nodejs_eventloop_delay_p99_seconds[1h])

# Duration p99 exceeded 1s (at 10s sampling, max is 360)
count_over_time((dsh_dsh_runtime_event_loop_delay_seconds{quantile="0.99"} > 1)[1h:])

# Bad neighbor detection: p99 ranking across all instances on same host
topk(5, max_over_time(dsh_nodejs_eventloop_delay_p99_seconds[10m]))
```
