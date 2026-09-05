# dsh-runtime-observability

DSH 的运行时性能指标插件。它补足 CPU、内存、event loop、活跃资源和观测导出质量；不替换 `@loongsuite/dsh-plugin` 的业务 Trace。

## 提供的信号

- `dsh.runtime.event_loop.delay{quantile}`（秒）与 `dsh.runtime.event_loop.utilization`
- `dsh.runtime.memory{area}`：RSS、heap、external、array buffers
- `dsh.runtime.active_resources{type}`：最多 32 种资源类型
- `process.cpu.time{cpu.mode}`、`process.uptime`：进程累计 CPU 时间与启动时长
- `dsh.telemetry.export.*`：attempt/failure/skipped 累计量与 consecutive failure 当前值
- `dsh.telemetry.degradation.*{reason}`：ELU 暂停/断路器的事件、累计时长和当前状态；恢复后补账
- `dsh.workload.active{kind}`：Agent Run、LLM、Tool、MCP 的显式在途数量
- `dsh.workload.queue.{depth,oldest_age}{kind}`：固定工作类型的排队深度与最老等待时长
- `dsh.workload.recovery.backlog{kind}`：session、task、ledger 三类恢复积压
- `dsh.subagent.activations{state}` 与 `dsh.subagent.activation.oldest_age{state}`：continuable Activation 的 running、waiting、settled_pending 数量与状态滞留时长
- `dsh.subagent.orphans` 与 `dsh.subagent.orphan.oldest_age`：父 Agent 已 dispose 但仍驻留的 continuable Activation
- `dsh.subagent.lifecycle.events{event}`：Activation started/disposed/orphaned 的低基数累计账本
- `dsh.telemetry.export{outcome}`：保留的兼容指标；新查询优先使用上述类型明确的 counter/gauge

> ELU（`event_loop.utilization`）的定义、与 CPU% 的区别、判读分级、与延迟分位联读、现场Remediation Playbook 见 [docs/elu-event-loop-utilization.md](docs/elu-event-loop-utilization.md)。

## 指标判读文档

| 文档 | 覆盖信号 | 核心内容 |
|---|---|---|
| [docs/elu-event-loop-utilization.md](docs/elu-event-loop-utilization.md) | `event_loop.utilization` | ELU 定义、与 CPU% 区别、饱和分级、插件自保联动、Remediation Playbook |
| [docs/event-loop-delay.md](docs/event-loop-delay.md) | `event_loop.delay{quantile}` + `dsh_nodejs_eventloop_delay_*` | 延迟分位两实现视角、p99 判读线、与 GC/ELU 联动鉴别阻塞源 |
| [docs/memory-gc.md](docs/memory-gc.md) | `memory{area}` + `dsh_v8js_memory_*`/`gc_*` | RSS/堆/space 分层、泄漏判型（堆内 vs 堆外）、GC 停顿与延迟代价 |
| [docs/active-resources.md](docs/active-resources.md) | `active_resources{type}` | 句柄类型速查、泄漏判读（趋势+对账）、与 GC/内存交叉验证 |
| [docs/workload-integration.md](docs/workload-integration.md) | `workload.*{kind}` | 显式生命周期接入 API、固定标签集合及当前宿主集成边界 |
| [docs/subagent-lifecycle.md](docs/subagent-lifecycle.md) | `subagent.*` + ELU/active resources/heap/GC | continuable Activation 状态、orphan 判定与任务结束后衰减实验 |
| [docs/telemetry-export-quality.md](docs/telemetry-export-quality.md) | `telemetry.export{outcome}` | 五态账本、故障Diagnosis Flow、断路器/节流语义、与巡检职责边界 |

未设置 `endpoint` 时，插件仍可加载，但不会创建网络 exporter 或发送遥测。部署阶段以同名 Cordis patch 覆盖 endpoint；填写 Collector 基础地址后插件会自动补全 `/v1/metrics`。

## 连续 Profiling（默认关闭）

配置 `profiling.enabled: true` + `profiling.serverAddress`（Pyroscope 服务端地址）后，插件经 `@pyroscope/nodejs` 上报 wall/heap profile：

- **关闭时不加载原生代码**（动态 import），生产路径零原生依赖
- 启动延迟 `profiling.bootDelayMs`（默认 30s），不阻塞 DSH boot；旧字段 `sampleRateMs` 保留兼容但已废弃，采样频率由 Pyroscope SDK 控制
- **fail-open**：SDK 加载失败/上传失败只写本地 warning；**event loop 利用率 ≥ `profiling.eluStopThreshold`（默认 0.9）自动停止采集**并记录原因
- `appName` 缺省取 `serviceName`；`flushIntervalMs` 默认 60s

查询：Grafana Explore → Pyroscope 数据源，或 Pyroscope API `/querier.v1.QuerierService/*`。

## 导出韧性（Resilience）

当 OTLP endpoint 不可达或 event loop 饱和时，插件通过以下机制避免日志洪水和资源恶性循环：

- **日志节流**：`resilience.logThrottlePerMinute`（默认 5）— 每分钟最多打印 N 条 export 失败日志，超出部分静默计数（可通过 `dsh.telemetry.export{outcome="log_suppressed"}` 观测）
- **断路器**：`resilience.circuitBreakerThreshold`（默认 10）— 连续 N 次 export 失败后暂停导出，`resilience.circuitBreakerCooldownMs`（默认 5 分钟）后发送单次探测请求，成功则恢复
- **ELU 降级联动**：`resilience.eluPauseThreshold`（默认 0.95）— event loop 利用率超过此阈值时，停止 metric exporter 的网络发送并停止 profiling；低于阈值减滞后后恢复 exporter

所有阈值均可通过配置覆盖；设为 0 禁用对应机制。

## 开发验证

```bash
pnpm install
pnpm run check
```

工作区还有本地 e2e 冒烟（mock OTLP/HTTP endpoint，验证真实网络导出与 fail-open）：

```bash
# 在工作区根目录执行
node scripts/runtime-observability-smoke.mjs
```

完整的任务分解见 [implementation plan](docs/plans/2026-09-03-runtime-observability-implementation.md)。
