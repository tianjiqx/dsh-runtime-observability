# Memory & GC

> Metrics source: `dsh.runtime.memory{area}` is exposed by **this plugin**; `dsh_v8js_memory_*` / `dsh_v8js_gc_*` come from the community package `@opentelemetry/instrumentation-runtime-node` (dependency).
> Related: [Event Loop Delay](./event-loop-delay.md) (GC is the top suspect for p99 long pauses) · [README](../README.md)

---

## 1. Two-Layer Perspective

| Layer | Metric | Prometheus Name | Question Answered |
|---|---|---|---|
| Process | `dsh.runtime.memory{area}` | `dsh_dsh_runtime_memory_bytes` | OS perspective: how much this process uses (RSS/heap/external) |
| V8 | `dsh_v8js_memory_heap_space_size_bytes{v8js_heap_space_name}` | Same name | Engine perspective: per-space heap usage, **key for leak localization** |
| Pressure | `dsh_v8js_memory_heap_space_available_size_bytes` | Same name | Available allocation per space, **OOM precursor signal** |
| Cost | `dsh_v8js_gc_duration_seconds_*` | Histogram | GC frequency and pause, **converts memory issues to latency cost** |

### area / space Field Reference

Plugin `{area}`: `rss` (resident memory, includes external), `heap_used` / `heap_total` (V8 heap), `external` (Buffer and other non-heap), `array_buffers`.

V8 spaces to focus on: `old_space` (old generation, **main battleground for leaks** — surviving objects accumulate here), `new_space` (young generation, frequent Scavenge collection), `large_object_space` (large objects >256KB Buffer/arrays go directly here).

## 2. Diagnosis Matrix

| Signal | Threshold Reference | Meaning |
|---|---|---|
| RSS stable | Smooth fluctuation | Healthy |
| RSS step-increase without drop | Monotonic increase over days | **Leak or unbounded cache**: cross-check heap_used — synchronized growth = heap leak; heap flat but RSS growing = external/ArrayBuffer leak (Buffer not released) |
| heap_used / heap_total | Sustained > 90% | Heap pressure, increased GC stress |
| `old_space` available | Approaching 0 | OOM precursor (this community metric is the preferred heap pressure alert) |
| GC major frequency | Noticeably increasing / longer duration | Frequent old-gen collection = leak or heap config too small |
| GC p95 pause | > 50ms | Starting to consume latency budget; > 200ms directly creates event loop p99 spikes |

## 3. Diagnosis Example

| Instance | RSS | heap_used/total | old_space Usage | GC (1h major count / p95 pause) | Assessment |
|---|---|---|---|---|---|
| dsh-agent | 1.73GB | 608MB / 722MB | 544MB | ~720 / 19.3ms | Heap stable, GC frequent but pauses small, healthy |
| dsh-agent-web2 | 2.22GB | **1.51GB / 1.55GB (98%)** | 461MB, but `large_object_space` at **1.03GB** | 19 / 9.4ms | 🔴 Two risk points (see below) |

web2 two concerns:

1. **heap_used/total = 98%**: Heap nearly full. GC pauses currently small (p95 9.4ms), but old-gen at 98% utilization means each major GC runs at the limit; further heap_total growth triggers "allocate-then-GC" death spiral
2. **large_object_space 1.03GB**: Nearly 2/3 of heap is large objects (large Buffers/JSON strings/arrays going directly to large-object space). The correlation with event loop p99 ≈3s is a key clue — large object creation/serialization/copying occupies both heap and main thread, **high probability that a single root cause explains both symptoms** (Pyroscope heap profile can confirm)

## 4. Remediation Playbook

1. **Classify**: RSS ↑ + heap_used ↑ = heap issue; RSS ↑ + heap flat = check external/array_buffers (Buffer not released / native modules)
2. **Locate**: Grafana → Pyroscope → `service_name=<instance>` → **Heap profile** (production-ready, non-invasive) sorted by retained size to find holders
3. **Short-term mitigation**: Restart target process to release heap (**if GUI host, restarting kills active sessions — requires maintenance window**)
4. **Root fix**: Large object chunked streaming, explicit caches with LRU limits, check global arrays for grow-only pattern
5. **Verify**: `old_space` usage drops + GC major frequency drops + event loop p99 drops (all three must move in same direction to confirm fix)

## 5. Common Queries

Prometheus metric names may vary based on Collector transformation — verify with actual deployment.

```promql
# Process memory overview (MB)
dsh_dsh_runtime_memory_bytes / 1024 / 1024

# Heap utilization ratio (approaching 1 = nearly full)
dsh_v8js_memory_heap_used_bytes / dsh_v8js_memory_heap_total_bytes

# old_space leak trend (6h linear extrapolation; slope > 0 sustained = leak signal)
deriv(dsh_v8js_memory_heap_space_size_bytes{v8js_heap_space_name="old_space"}[6h])

# GC pause p95 and frequency
histogram_quantile(0.95, sum by (le, exported_job) (rate(dsh_v8js_gc_duration_seconds_bucket[1h])))
sum by (exported_job, v8js_gc_type) (increase(dsh_v8js_gc_duration_seconds_count[1h]))

# External suspicious growth (check when RSS grows but heap doesn't)
dsh_dsh_runtime_memory_bytes{area=~"external|array_buffers"} / 1024 / 1024
```
