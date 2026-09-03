# DSH Diagnostic Metrics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add low-cardinality process and telemetry-degradation metrics, consume them in time-windowed inspect-agent diagnoses, then integrate explicit workload gauges at stable DSH lifecycle boundaries.

**Architecture:** Extend the existing private MeterProvider rather than creating another global provider. Keep cumulative degradation accounting in `TelemetryQuality`, expose counters separately from current-state gauges, and query the resulting Prometheus series from deterministic inspect-agent checks and rules.

**Tech Stack:** TypeScript, OpenTelemetry JS Metrics, Vitest, Python 3.10, requests, pytest, Prometheus HTTP API.

---

### Task 1: Process CPU and uptime snapshots

**Files:**
- Modify: `src/runtime-snapshot.ts`
- Modify: `src/index.ts`
- Test: `tests/runtime-snapshot.spec.ts`

1. Add failing tests for microsecond-to-second CPU conversion and injected uptime.
2. Run `pnpm vitest run tests/runtime-snapshot.spec.ts` and confirm failure.
3. Add injected `process.cpuUsage` and `process.uptime` readers to `RuntimeSnapshotCollector`.
4. Register `process.cpu.time{cpu.mode}` as ObservableCounter and `process.uptime` as ObservableGauge.
5. Run the focused test and typecheck.

### Task 2: Telemetry degradation ledger

**Files:**
- Modify: `src/types.ts`
- Modify: `src/quality.ts`
- Modify: `src/counting-exporter.ts`
- Modify: `src/index.ts`
- Test: `tests/quality.spec.ts`

1. Add failing tests for idempotent start/end transitions, active duration, skipped batches, circuit-open skips and probe recovery.
2. Run the focused tests and confirm failure.
3. Add fixed degradation reasons and cumulative/state fields to `TelemetryQualitySnapshot`.
4. Account for ELU pause transitions in `setPaused` and circuit transitions in the exporter.
5. Split cumulative signals into ObservableCounters and current state into ObservableGauges.
6. Run focused tests, `pnpm run check`, and inspect the generated `lib` diff.
7. Update README and telemetry-quality guide, then commit the runtime phase.

### Task 3: Prometheus time-window client

**Files:**
- Modify: `dsh-inspect-agent/core/http_client.py`
- Modify: `dsh-inspect-agent/inspect_cli.py`
- Test: `dsh-inspect-agent/tests/test_http_client.py`

1. Add failing request-mock tests for `/api/v1/query_range` parameters.
2. Implement `query_range(expr, start, end, step)` with existing error semantics.
3. Add optional probe arguments `--start`, `--end`, and `--instance`, carrying them through context without changing default behavior.
4. Run focused tests.

### Task 4: Runtime saturation and degradation diagnosis

**Files:**
- Modify: `dsh-inspect-agent/checks/observability.py`
- Modify: `dsh-inspect-agent/rules/diagnose.py`
- Modify: `dsh-inspect-agent/config.yaml`
- Modify: `dsh-inspect-agent/docs/CHECKS.md`
- Test: `dsh-inspect-agent/tests/test_diagnose.py`
- Test: `dsh-inspect-agent/tests/test_runtime_checks.py`

1. Add failing tests for healthy, CPU-bound, GC-bound, demand-saturation and ELU-pause evidence.
2. Implement bounded PromQL checks grouped by `exported_job`.
3. Add R9/R10 with explicit evidence chains and UNKNOWN behavior for missing metrics.
4. Run focused tests and full `pytest`.
5. Run a no-save live `perf-slow` probe and confirm runtime checks appear without mutating reports.
6. Commit the inspect-agent phase.

### Task 5: Explicit workload metrics facade and host integration

**Files:**
- Create or modify after graph discovery: `src/workload.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/workload.spec.ts`
- Modify stable DSH Agent/scheduler/recovery lifecycle files identified by the code graph.

1. Index or refresh the owning DSH repository and trace Agent Run, queue and recovery entry/exit paths.
2. Add failing tests for fixed-kind active gauges and queue/recovery observations.
3. Implement a process-local workload facade with fixed kinds and no identifiers in labels.
4. Integrate only at stable lifecycle boundaries; if none exist, record the blocker rather than monkey-patching.
5. Run each owning repository's focused and full checks.
6. Commit facade and host integration separately.

### Task 6: Final verification

1. Run `pnpm run check` in `dsh-runtime-observability`.
2. Run the full pytest suite in `dsh-inspect-agent`.
3. Run `git diff --check` and verify both repositories are clean.
4. Report commits, exact tests, live validation, and any host-integration boundary that remains.
