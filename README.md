# dsh-runtime-observability

DSH 的运行时性能指标插件。它补足 CPU、内存、event loop、活跃资源和观测导出质量；不替换 `@loongsuite/dsh-plugin` 的业务 Trace。

已部署到 web profile（endpoint `http://localhost:4318`，profiling 已开启指向 `http://localhost:4040`）；部署与验证记录见工作区 `dsh-runtime-observability-progress-todo.md`。

## 提供的信号

- `dsh.runtime.event_loop.delay{quantile}`（秒）与 `dsh.runtime.event_loop.utilization`
- `dsh.runtime.memory{area}`：RSS、heap、external、array buffers
- `dsh.runtime.active_resources{type}`：最多 32 种资源类型
- `dsh.telemetry.export{outcome}`：OTLP 导出质量计数器（`attempt`/`failure`/`consecutive_failure`/`log_suppressed`）；导出失败只写本地 warning，不阻塞 Agent Run

未设置 `endpoint` 时，插件仍可加载，但不会创建网络 exporter 或发送遥测。部署阶段以同名 Cordis patch 覆盖 endpoint；可填写 Collector 基础地址（例如 `http://localhost:4318`），插件会补全 `/v1/metrics`。

## 连续 Profiling（默认关闭）

配置 `profiling.enabled: true` + `profiling.serverAddress`（Pyroscope 服务端，如 `http://localhost:4040`）后，插件经 `@pyroscope/nodejs` 上报 wall/heap profile：

- **关闭时不加载原生代码**（动态 import），生产路径零原生依赖
- 启动延迟 `profiling.bootDelayMs`（默认 30s），不阻塞 DSH boot；旧字段 `sampleRateMs` 保留兼容但已废弃，采样频率由 Pyroscope SDK 控制
- **fail-open**：SDK 加载失败/上传失败只写本地 warning；**event loop 利用率 ≥ `profiling.eluStopThreshold`（默认 0.9）自动停止采集**并记录原因
- `appName` 缺省取 `serviceName`；`flushIntervalMs` 默认 60s

查询：Grafana Explore → Pyroscope（数据源 `your-pyroscope:4040`），或 Pyroscope API `/querier.v1.QuerierService/*`。

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
