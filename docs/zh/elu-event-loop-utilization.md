# 事件循环利用率（ELU）

> 适用范围：DSH 全部 Node.js 进程（dsh-agent、dsh-agent-web2 等）
> 指标来源：**本插件（dsh-runtime-observability）** 暴露 `dsh.runtime.event_loop.utilization` 等 `dsh.runtime.*` 信号；姊妹指标 `dsh_nodejs_*`/`dsh_v8js_*` 来自社区包 `@opentelemetry/instrumentation-runtime-node`（依赖引入）
> 关联文档：[README](../README.md)（插件配置：ELU 自保阈值 / 导出韧性）

---

## 1. 一句话定义

**ELU（Event Loop Utilization）= 在一个观测窗口内，Node.js 事件循环处于"有活干"状态的时间占比**，取值 0~1。

- `0.9` = 过去这个窗口里，90% 的时间这个线程都在干活，只有 10% 在歇着
- `0` = 事件循环完全空闲
- `1` = 窗口内全程无休，新事件只能排队

## 2. 背景：为什么需要这个指标

Node.js 用**单线程**跑 JS：所有请求处理、回调、定时器排成队列，事件循环一轮一轮取出来执行。

- **干活时**（执行 JS 代码，含同步 I/O、序列化、计算）= 阻塞状态，其他所有请求排队等
- **歇着时**（队列空了）= 等 I/O 完成、等下一个定时器

所以"事件循环有多忙"直接决定进程还能不能接新活——这正是 ELU 量测的东西。Node ≥ 14.10 提供 `performance.eventLoopUtilization()` 原生 API，插件基于它周期性计算并导出。

## 3. ELU vs CPU 使用率（最容易混淆的点）

| | CPU % | ELU |
|---|---|---|
| 视角 | 整台机器（所有核） | 单个进程的 JS 线程 |
| 度量的是 | 消费（用了多少算力） | **饱和度（唯一线程被占住的比例）** |
| 16 核机器单线程跑满 | ≈ 6% | = 1.0 |

**"ELU 0.9 但 CPU 只有百分之十几"完全可能**：JS 线程在同步计算上打转，其他 15 个核全部闲着。CPU% 看不出单线程瓶颈，ELU 才能看出。

## 4. DSH 里的指标链路

```
dsh-runtime-observability 插件（dsh.runtime.event_loop.utilization，10s 采集）
  → OTLP/HTTP → OTel Collector（namespace=dsh）
  → Prometheus 指标名：dsh_dsh_runtime_event_loop_utilization_ratio
```

配套的姊妹指标（同源插件）：

| Prometheus 指标名 | 含义 |
|---|---|
| `dsh_dsh_runtime_event_loop_utilization_ratio` | ELU（本文主角） |
| `dsh_dsh_runtime_event_loop_delay_seconds{quantile=...}` | 插件自测延迟分位 p50/p90/p99（秒） |
| `dsh_nodejs_eventloop_utilization_ratio` | 社区包 @opentelemetry/instrumentation-runtime-node 的 ELU（交叉验证） |
| `dsh_nodejs_eventloop_delay_p50/p90/p99_seconds` | 社区包延迟分位（交叉验证） |

插件 ELU 与社区包 ELU 数值接近属正常（算法同源、窗口略异）；两套同时看可以排除单实现偏差。

## 5. 数值判读

### 5.1 经验分级

（OpenTelemetry runtime 语义 / Google SRE saturation 思路）

| ELU | 分级 | 判读 |
|---|---|---|
| < 0.5 | 健康 | 正常余量 |
| 0.5 ~ 0.7 | 偏高 | 开始关注趋势 |
| 0.7 ~ 0.9 | 拥堵 | 延迟开始抬升 |
| > 0.9 | 饱和 | 新请求排队，延迟有雪崩风险 |

### 5.2 与延迟分位数联读（关键）

ELU 是 10s 窗口的**平均值**，延迟分位数显示**尖峰**，两者必须组合判读：

| 组合 | 含义 |
|---|---|
| ELU 低 + p99 低 | 健康，无需动作 |
| ELU 高 + p50 高 + p99 高 | 持续饱和，容量不足 |
| ELU 高 + p50 正常 + p99 尖刺 | **周期性长阻塞**：平均很忙，间歇性有大活占住线程（大同步计算/GC/同步 I/O） |
| ELU 低 + p99 尖刺 | 偶发阻塞（磁盘抖动/单次大对象操作），量少先观察 |

## 6. 插件的 ELU 联动自保机制

`dsh-runtime-observability` 把 ELU 当作降级触发器（避免观测本身加剧饱和）：

| 配置项 | 默认值 | 触发后行为 |
|---|---|---|
| `profiling.eluStopThreshold` | 0.9 | 自动停止 Pyroscope profile 采集并记录原因 |
| `resilience.eluPauseThreshold` | 0.95 | profiling **和** metric export 同时降级 |

原理：ELU 饱和时再做网络 I/O（导出、上传 profile）等于火上浇油；所有阈值可在 Cordis patch 配置中覆盖，设 0 禁用。

**运维含义**：看到 profiling 样本断流时，先查当时 ELU——可能是插件主动自保，不是 Pyroscope 故障。

## 7. 判读示例

| 实例 | ELU | EL delay p50/p99 | RSS/heap_used | 判读 |
|---|---|---|---|---|
| dsh-agent | 0.44 ~ 0.52 | 20ms / 41ms | 1.73GB / 569MB | 健康区间 |
| dsh-agent-web2 | **0.90 ~ 0.91** | 20ms / **2.87s** | 1.71GB / 985MB | **真实饱和**（见下） |

web2 的判读链：

1. ELU 0.90 已达 profiling 自停线，距 export 降级线（0.95）一步之遥
2. p50 20ms 正常 + p99 2.87s 尖刺 + ELU 高 ⇒ 属"周期性长阻塞"形态（§5.2 第 3 行）：不是持续卡，是有大活间歇性占住线程
3. heap_used 985MB 偏高，GC 停顿本身就是候选嫌疑之一
4. web2 是协作 GUI 宿主，负载形态与多会话并发相关

## 8. ELU 高的处置 Playbook

按顺序执行：

1. **找同步阻塞点**（最常见成因）
   - 大对象 `JSON.parse/stringify`
   - 同步 crypto（`pbkdf2Sync` 等）
   - 同步 FS（`existsSync`/`readFileSync`/`writeFileSync`）
   - 大循环计算（无分片的批量处理）
2. **卸载 CPU 密集活**：worker threads / 子进程，把主线程让出来
3. **查 GC 压力**：对照 `dsh_v8js_gc_duration_seconds_*` 与 heap 趋势；heap 持续走高 + GC 变慢 ⇒ 排查内存泄漏或调堆
4. **Pyroscope 火焰图定位函数**：Grafana → Explore → Pyroscope 数据源 → `service_name=<目标实例>` → Wall profile；哪个函数吃掉事件循环一目了然
5. **容量兜底**：确属业务量增长则拆分进程/实例（注意 GUI 宿主重启会杀在跑会话，需人工确认窗口）

## 9. 常用查询

Prometheus 指标名可能因 Collector 转换而异——请以实际部署为准。

```promql
# 各实例当前 ELU
dsh_dsh_runtime_event_loop_utilization_ratio

# 近 1 小时 ELU 均值（趋势）
avg_over_time(dsh_dsh_runtime_event_loop_utilization_ratio[1h])

# ELU 饱和采样数（1h 内处于 >0.9 的样本个数；采样间隔 10s，满值 360）
count_over_time((dsh_dsh_runtime_event_loop_utilization_ratio > 0.9)[1h:])

# 配套延迟分位（与 ELU 同图叠加）
dsh_dsh_runtime_event_loop_delay_seconds{quantile="0.99"}
dsh_nodejs_eventloop_delay_p99_seconds

# GC 时长速率（排查 GC 嫌疑）
rate(dsh_v8js_gc_duration_seconds_sum[5m])
```

Grafana 查看：Runtime Diagnostics 看板 Event Loop 行。

## 10. 参考

- Node.js 官方：`perf_hooks.performance.eventLoopUtilization()`（≥ 14.10）
- OpenTelemetry `@opentelemetry/instrumentation-runtime-node`（`dsh_nodejs_*` 指标来源）
- Google SRE《Site Reliability Engineering》§3 — Utilization / Saturation 分层（USE 方法）
- 本插件源码与 [README](../README.md)（ELU 自保阈值、导出韧性配置）
