# 事件循环延迟

> 指标来源：**本插件** 暴露 `dsh.runtime.event_loop.delay{quantile}`；姊妹指标 `dsh_nodejs_eventloop_delay_*` 来自社区包 `@opentelemetry/instrumentation-runtime-node`（依赖引入）
> 关联文档：[ELU 指南](./elu-event-loop-utilization.md)（ELU 饱和度，延迟视角的补充）· [README](../README.md)（插件配置）

---

## 1. 一句话定义

**事件循环延迟 = 一次定时器回调没有在预定时刻被准点执行、实际被推迟了多久**。

Node.js 实现：`setTimeout(fn, 1)` 后测 `fn` 真正执行时刻与预定时刻的差。事件循环空闲时差值 ≈ 1ms + 抖动；线程被前一轮任务占住时，差值 = 被占住的时长——所以它直接度量**主线程单次阻塞了多久**。

## 2. 两个实现、两层视角（必须成对看）

| 视角 | 插件指标 | Prometheus 名 | 特点 |
|---|---|---|---|
| 单次阻塞时长 | `dsh.runtime.event_loop.delay{quantile}` | `dsh_dsh_runtime_event_loop_delay_seconds` | quantile=0.5/0.9/0.99 **三条序列**；p99 直接回答"最坏一轮卡了多久" |
| 滚动窗口分位 | `dsh_nodejs_eventloop_delay_p50/p90/p99_*` | 同名 | 社区包 1min 滚动统计；另有 mean/min/max/stddev |

两个 p99 数值接近（同算法不同实现）互为交叉验证；本插件版适合"看尖峰的即时值"，社区包版适合"看 1min 窗口内形态"。

与 ELU 的分工：**ELU 说"忙不忙"（比例），延迟说"卡多久"（绝对时长）**。web2 的形态 = ELU 0.90（忙）+ p50 20ms（平时不卡）+ p99 2.9s（偶发大阻塞）。

## 3. 分位数值判读

| 指标 | 健康 | 关注 | 行动线 | 说明 |
|---|---|---|---|---|
| p50 | < 10ms | < 50ms | > 100ms | 稳态；持续 >100ms 说明常态性超载，不是偶发 |
| p90 | < 50ms | < 100ms | > 200ms | 常规负载的上界 |
| **p99** | < 100ms | < 500ms | **> 1s** | **核心告警位**：单次阻塞 >1s 时，UI/流式交互可感知卡顿；与插件 ELU 降级线（0.90/0.95）联动评估 |

阈值已内置到 Runtime Diagnostics 看板（p99 + ELU 同图叠加）。

## 4. 与 GC / memory 的联动判读

p99 长阻塞三大嫌疑的鉴别顺序：

1. **GC major**（对照 [memory-gc.md](./memory-gc.md) `dsh_v8js_gc_duration_seconds_bucket` p95）：GC p95 与 EL delay p99 同量级 ⇒ 阻塞大半是 GC
2. **大同步计算/序列化**（Pyroscope Wall profile 定位函数）
3. **同步 I/O**（检查代码里的 `*Sync` 调用）

## 5. 判读示例

| 实例 | p50 / p90 / p99 | 社区包 mean / 1h 峰值 | 判读 |
|---|---|---|---|
| dsh-agent | 20ms / 21ms / 42ms | 10.6ms / 33ms | ✅ 健康 |
| dsh-agent-web2 | 20ms / 25ms / **2.95s** | 94ms / **3.34s** | 🔴 周期性长阻塞（持续恶化：p99 由 2.87s → 2.95s） |

web2：p50/p90 正常 + p99 ≈3s ⇒ 大量请求体验良好，少数撞上阻塞窗口的请求体验极差；阻塞源鉴别按 §4 顺序（GC p95 仅 9.4ms，**排除 GC** ⇒ 指向大同步计算，用 Pyroscope 定位）。

## 6. 处置 Playbook

1. p99 持续 >1s：Pyroscope Wall profile 对 `service_name=<实例>` 找最宽的栈
2. 常见元凶：大 JSON `parse/stringify`、大循环无分片、同步 crypto/FS、`child_process.execSync`
3. 分片处理（每片 N ms 后 `setImmediate` 让出线程）或挪 worker threads
4. 修后验收：同窗口 p99 回落 + ELU 回落 + telemetry export failure 不再新增（阻塞解除后 export 不再被 ELU 线压制）

## 7. 常用查询

Prometheus 指标名可能因 Collector 转换而异——请以实际部署为准。

```promql
# 三分位同看（叠加 ELU 更佳）
dsh_dsh_runtime_event_loop_delay_seconds
dsh_dsh_runtime_event_loop_utilization_ratio

# 1h 内 p99 峰值（是否出现过秒级阻塞）
max_over_time(dsh_nodejs_eventloop_delay_p99_seconds[1h])

# p99 超过 1s 的持续时间（采样 10s，满值 360）
count_over_time((dsh_dsh_runtime_event_loop_delay_seconds{quantile="0.99"} > 1)[1h:])

# 坏邻居检测：同一宿主机所有实例的 p99 排行
topk(5, max_over_time(dsh_nodejs_eventloop_delay_p99_seconds[10m]))
```
