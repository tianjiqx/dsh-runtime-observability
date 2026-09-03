# Workload 指标接入

`RuntimeObservability.workload` 是进程内 facade。它只接受固定 `kind`，不允许把 session、run、tool 或 MCP 名称放进标签。

```ts
const runtime = ctx.get('dshRuntimeObservability')

const endRun = runtime.workload.begin('agent_run')
try {
  await runAgent()
} finally {
  endRun() // 幂等，可安全放 finally
}

runtime.workload.setQueue('tool', pending.length, oldestAgeSeconds)
runtime.workload.setRecoveryBacklog('ledger', pendingLedgers)
```

固定集合：

- active/queue：`agent_run | llm | tool | mcp`
- recovery：`session | task | ledger`

`setQueue(kind, 0)` 会强制把 oldest age 清零；负数、NaN、Infinity 和未知 kind 会抛出 `RangeError`，防止静默污染时间序列。facade 在 metrics disabled 时仍可调用，便于宿主代码保持单一路径。

## 宿主集成状态

 的工作区只有发布后的 DSH CLI bundle 和 profile 依赖，没有 `@deepseek-ai/dsh-agent`、`dsh-agent-loop`、`dsh-session-persistence-jsonl`、`dsh-session-projection` 的可提交源码仓库。代码图中的 `dsh-runtime` 项目也只有构建产物，无法验证稳定的 run/queue/recovery 生命周期入口。

因此本阶段提交 facade 和 OTLP 指标注册，但不修改 profile 内依赖、不 monkey-patch 构建产物。取得宿主源码后，应分别在以下真实边界接入，并在宿主仓库独立提交：

1. Agent Run、LLM、Tool、MCP 执行入口 `begin(kind)`，在 `finally` 调用返回的 end。
2. 调度器 enqueue/dequeue/cancel 后调用 `setQueue`，oldest age 来自队首入队时间。
3. session/task/ledger 恢复器扫描或状态变更后调用 `setRecoveryBacklog`。

验收要求：并发用例中 active 精确回零；取消/异常路径不泄漏；空队列 age=0；标签只出现上述固定集合。
