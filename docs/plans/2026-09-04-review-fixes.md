# Runtime Observability Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修正 review 发现的文档契约、ELU 降级、Profiling 启动延迟和 HMR 配置比较问题。

**Architecture:** 保留现有 fail-open 与断路器设计；通过 exporter gate 实现 ELU 真暂停，使用独立 boot delay，并对归一化配置递归排序生成稳定 key。

**Tech Stack:** TypeScript, OpenTelemetry SDK Metrics, Vitest, tsdown。

---

### Task 1: 修正文档契约

- Modify `README.md`：移除不存在的 `circuit_open` outcome，并准确描述 ELU 行为。

### Task 2: Profiling 启动延迟解耦

- Modify `src/types.ts`、`src/index.ts`、`README.md`。
- Add `profiling.bootDelayMs`，默认 30 秒；保留废弃的 `sampleRateMs` 以兼容旧配置。
- Add normalization and test coverage.

### Task 3: ELU 真正暂停与恢复 metric reader

- Modify `src/index.ts`。
- Gate the counting exporter during pressure and acknowledge skipped batches; ensure dispose is idempotent.
- Add tests for pause/resume state transitions.

### Task 4: Stable HMR key

- Modify `src/index.ts`。
- Generate a recursively key-sorted JSON key from normalized config.
- Add equivalent-key HMR test.

### Task 5: Verification

- Run `pnpm run check` and inspect generated bundle.
