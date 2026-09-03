# DSH 诊断指标增强设计

## 目标

用最小、低基数的指标补齐 2026-09-03 ELU 饱和事件中依赖人工推断的证据链，使运行时插件能够准确记录进程 CPU、重启和遥测降级，并使 `dsh-inspect-agent` 能按时间窗自动识别运行时饱和与观测自保。

## 范围与阶段

### 阶段一：运行时 P0

`dsh-runtime-observability` 增加：

- 标准 `process.cpu.time{cpu.mode=user|system}` 累计 CPU 秒数。
- 标准 `process.uptime` 当前进程运行秒数。
- 遥测累计账本：attempt、failure、skipped、degradation event、degradation duration。
- 遥测当前状态：consecutive failures、circuit open、degraded。

ELU 暂停和断路器使用固定的 `reason=elu_pause|circuit_open`，不接受用户值，保证标签基数有界。累计量使用 ObservableCounter，当前状态使用 ObservableGauge。暂停期间同通道无法实时导出；计数与持续时间保存在进程内，恢复后的首个成功批次补账。

### 阶段二：诊断 Agent

`dsh-inspect-agent` 增加 Prometheus range query 能力和可选的 `--start`、`--end`、`--instance` 诊断窗口。新增检查：

- `runtime_saturation`：按实例汇总 ELU、event-loop delay、CPU 和 GC。
- `telemetry_degradation`：读取 skipped、degraded、duration 与断路器状态。

新增规则：

- R9：ELU 高且 event-loop delay 高时确认进程饱和，并用 CPU/GC 组合缩小原因。
- R10：遥测 skipped/degraded 增长时，区分主动自保与真实 exporter failure。

现有 `perf-slow` 剧本继续使用 business + observability 组，因此新增检查自动进入同一取证流程。

### 阶段三：应用负载桥接

运行时插件提供低开销、显式调用的 workload meter facade，支持固定 `kind` 集合的 active、queue depth、queue oldest age 和 recovery backlog。DSH Agent、调度器和恢复器在真实生命周期边界调用该 facade；不通过 async hooks、Promise 数量或 active handles 猜测业务并发。

阶段三开始前先通过代码图定位会话、Agent Run、LLM/Tool/MCP 调度和恢复入口。若宿主没有稳定生命周期钩子，则只提交 facade 与集成 TODO，不以脆弱 monkey patch 代替。

## 数据流

```text
Node/process + explicit workload hooks
  -> dsh-runtime-observability MeterProvider
  -> OTLP metrics
  -> Collector :8889
  -> Prometheus
  -> dsh-inspect-agent windowed checks
  -> R9/R10 evidence chain
```

## 失败与降级语义

- ELU 暂停：每个被跳过批次增加 `skipped{reason=elu_pause}`。
- 断路器打开：非探测批次增加 `skipped{reason=circuit_open}`。
- 状态切换只记一次 event；持续时间在状态活跃时动态包含当前区间，结束后固化累计值。
- exporter 恢复后的首个批次携带暂停期间账本；实时降级告警仍需要独立通道，不由本阶段伪装解决。
- HMR 继续复用现有单例和引用计数，不创建第二个全局 MeterProvider。

## 测试与验收

- 单元测试注入 CPU、uptime 和时钟，验证单位与累计语义。
- ELU pause、resume、circuit open、probe success 均验证 event、duration、skipped 只按状态机变化。
- 验证 counter/gauge 注册和现有指标兼容。
- Agent 使用 mock Prometheus 响应验证 query range 参数、实例过滤、R9/R10 触发与不触发。
- 两个项目分别运行完整检查命令并分别提交。

## 非目标

- 不重复社区 instrumentation 已有的 event-loop max/mean/stddev、GC histogram 或 heap-space 指标。
- 不给 Prometheus 指标添加 request、session、trace、model 等高基数标签。
- 不修改 LoongSuite 私有 TraceProvider，不创建重复 Agent Run spans。
