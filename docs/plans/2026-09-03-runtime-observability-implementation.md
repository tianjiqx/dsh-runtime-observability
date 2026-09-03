# DSH Runtime Observability Implementation Plan

**Goal:** Deliver a DSH plugin that adds runtime metrics, exporter-quality signals, and a safe Agent Run correlation API without changing deployment configuration.

**Architecture:** The plugin owns an independent OTLP metrics provider only when an endpoint is explicitly configured. It never replaces LoongSuite tracing. A Cordis service exposes the correlation API to future, verified lifecycle adapters.

**Tech stack:** TypeScript, Cordis, OpenTelemetry JS metrics, Vitest, tsdown.

---

1. Create the bundle manifest, typed configuration, and a Cordis service boundary.
2. Implement pure runtime snapshot collection and unit tests for units and cardinality controls.
3. Add a local MeterProvider, runtime-node instrumentation, custom observable metrics, and fail-open exporter accounting.
4. Do not create Agent Run spans until LoongSuite exposes a supported tracer facade; the plugin must not emit non-recording or duplicate spans.
5. Verify typecheck, unit tests, and package build. No profile install, Collector, Prometheus, or deployment configuration is part of this task.
