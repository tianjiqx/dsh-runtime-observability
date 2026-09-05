# Active Resources

> Metrics source: **this plugin** exposes `dsh.runtime.active_resources{type}`.
> Related: [ELU Guide](./elu-event-loop-utilization.md) · [Event Loop Delay](./event-loop-delay.md) · [README](../README.md)

---

## 1. Definition

**Active resources = handles/requests currently attached to the event loop**, categorized by libuv type. The direct reason an event loop "can't rest" is that active resources haven't been released — this is a **direct detector for connection/handle leaks** and the entry point for diagnosing why a process "won't shut down."

Collected from `process.getActiveResourcesInfo()` (Node ≥ 17.3); the plugin lists at most 32 types to prevent cardinality explosion.

## 2. Common Types Reference

| Type | Resource | When to Watch |
|---|---|---|
| `FSEventWrap` | File watchers (fs.watch) | Count grows linearly with business → watcher leak |
| `Timeout` | Unfired timers | **Sustained > hundreds** → timer leak (missing clearInterval, polling accumulation) |
| `TCPSocketWrap` | Active TCP connections | Steady baseline ≈ concurrent connections; only grows → connection pool/keep-alive leak |
| `FSReqPromise` | In-progress file I/O | Short spikes normal (concurrent I/O); **sustained high** → slow disk or I/O saturation |
| `TTYWrap` | Terminal handles (stdout/stderr) | Normally fixed at a few |
| `HTTPParser`/`Server` | HTTP connections/listening servers | Cross-check with request concurrency |
| `Immediate` | setImmediate queue | Should be bounded; sudden growth → chunking logic失控 |

## 3. Diagnosis Principles

1. **Watch trends, not absolute values**: Each service has different baselines (file services naturally have more FSEventWrap); the key is **no drop after step increase** — normal resources fluctuate with requests, leaked resources only increase
2. **Cross-check with request volume**: Concurrency ↑ + resources ↑ = healthy; concurrency stable + resources ↑ = leak
3. **Cross-reference with GC**: Handle leaks simultaneously push up external/array_buffers (see [memory-gc.md](./memory-gc.md) §2)
4. **Concentrated in 1-2 types** → investigate that API's release path specifically; widespread → upstream request pileup (check ELU/latency)

## 4. Diagnosis Example

| Instance | Top Resources | Type Count | Assessment |
|---|---|---|---|
| dsh-agent | FSEventWrap 73 / Timeout 11 / FSReqPromise 8 / TCPSocketWrap 6 / TTYWrap 3 | 7 | ✅ Consistent with baseline, stable |
| dsh-agent-web2 | FSEventWrap 73 / Timeout 10 / TCPSocketWrap 8 | 11 | ✅ Baseline stable, no leak pattern |

Both instances having FSEventWrap=73 is **expected** (same DSH process, watching the same workspace file tree), not an anomaly. No resource leak indicators present.

## 5. Remediation Playbook

1. Identify leak type (§2 table) → locate corresponding API create/release pairs (watcher close, timer clear, connection destroy)
2. Quick bisection: resources return to baseline after restart, then **linearly increase** → code leak; increase then plateau → baseline itself changed (configuration/session volume)
3. Long-term defense: add unified management for timers/listeners/connection pools (unified cleanup on exit), and use `count_over_time` trend queries for alerting

## 6. Common Queries

Prometheus metric names may vary based on Collector transformation — verify with actual deployment.

```promql
# Current active resources top 8
topk(8, dsh_dsh_runtime_active_resources)

# 24h trend for a specific type (leak = step increase without drop)
dsh_dsh_runtime_active_resources{type="Timeout"}

# 6h linear slope (>0 and sustained = leak suspect)
deriv(dsh_dsh_runtime_active_resources{type="Timeout"}[6h])

# Resource type cardinality change (new types = new dependency signal)
count by (exported_job) (dsh_dsh_runtime_active_resources)
```
