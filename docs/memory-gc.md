# DSH 内存与 GC 指标说明与Guide

> 指标来源：`dsh.runtime.memory{area}` 由**本插件**直接暴露；`dsh_v8js_memory_*` / `dsh_v8js_gc_*` 来自插件依赖的社区包 `@opentelemetry/instrumentation-runtime-node`。
> （Prometheus 实测）。
> Related：[event-loop-delay.md](./event-loop-delay.md)（GC 是 p99 长阻塞的头号嫌疑）· [README](../README.md)

---

## 1. 两层视角

| 层 | 指标 | Prometheus 名 | 回答的问题 |
|---|---|---|---|
| 进程层 | `dsh.runtime.memory{area}` | `dsh_dsh_runtime_memory_bytes` | OS 视角：这个进程占了多少（RSS/堆/堆外） |
| V8 层 | `dsh_v8js_memory_heap_space_size_bytes{v8js_heap_space_name}` | 同名 | 引擎视角：堆内部各 space 用量，**泄漏定位靠它** |
| 压力层 | `dsh_v8js_memory_heap_space_available_size_bytes` | 同名 | 各 space 还剩多少可分配，**OOM 前兆信号** |
| 代价层 | `dsh_v8js_gc_duration_seconds_*` | Histogram | GC 频率与停顿，**把内存问题换算成延迟代价** |

### area / space 字段速查

插件 `{area}`：`rss`（常驻内存，含堆外）、`heap_used` / `heap_total`（V8 堆）、`external`（Buffer 等堆外）、`array_buffers`。

V8 space 重点关注三个：`old_space`（老生代，**泄漏的主战场**，存活对象越积越多在这里）、`new_space`（新生代，Scavenge 高频回收）、`large_object_space`（大对象直入，>256KB 的 Buffer/大数组）。

## 2. Diagnosis Matrix

| 信号 | 阈值参考 | 含义 |
|---|---|---|
| RSS 稳定 | 平稳波动 | 健康 |
| RSS 阶梯式爬升不回落 | 连续数日单调升 | **泄漏或缓存无界**：对照 heap_used，同步涨 ⇒ 堆内泄漏；heap 平而 RSS 涨 ⇒ external/ArrayBuffers 泄漏（Buffer 未释放） |
| heap_used 占 heap_total | 常态 > 90% | 堆吃紧，GC 压力升高 |
| `old_space` available | 逼近 0 | OOM 前兆（社区包此指标是堆压力告警首选） |
| GC major 频率 | 明显升高/时长变长 | 老生代回收频繁 ⇒ 泄漏或堆配置过小 |
| GC p95 停顿 | > 50ms | 开始吃延迟预算；> 200ms 直接制造 event loop p99 尖刺 |

## 3. Diagnosis Example（example snapshot）

| 实例 | RSS | heap_used/total | old_space 用量 | GC（1h major 次数 / p95 停顿） | 判读 |
|---|---|---|---|---|---|
| dsh-agent | 1.73GB | 608MB / 722MB | 544MB | ~720 / 19.3ms | heap 稳态、GC 高频但停顿小，健康 |
| dsh-agent-web2 | 2.22GB | **1.51GB / 1.55GB（98%）** | 461MB，但 `large_object_space` 高达 **1.03GB** | 19 / 9.4ms | 🔴 两个风险点（见下） |

web2 两个关注点：

1. **heap_used/total = 98%**：堆几乎吃满。GC 目前停顿尚小（p95 9.4ms），但老生代在 98% 占用下每次 major 都是贴着限额跑，heap_total 再被顶高就进入"分配即 GC"的死亡螺旋
2. **large_object_space 1.03GB**：堆内近 2/3 是大对象（大 Buffer/大 JSON 字符串/大数组直入）。与 event loop p99 ≈3s 的时间相关性是关键线索——大对象的创建/序列化/拷贝既占堆又占主线程，**单一根因同时解释两个症状的概率高**（Pyroscope heap profile 可确认）

对照记忆：昨日快照 web2 heap_used 985MB → 今日 1.51GB，**约 +50% 的单日涨幅**，需确认是会话量增长还是未释放的大对象累积。

## 4. Remediation Playbook

1. **判型**：RSS 升 + heap_used 升 ⇒ 堆内问题；RSS 升 + heap 平 ⇒ 查 external/array_buffers（Buffer 未释放/原生模块）
2. **定位**：Grafana → Pyroscope → `service_name=<实例>` → **Heap profile**（生产已开，无侵入）按 retained size 排序找持有者
3. **短期缓解**：重启目标 profile 进程释放堆（**web2 是 GUI 宿主，重启会杀在跑会话，须人工确认窗口**）
4. **根修**：大对象分片流式处理、明确的大缓存加 LRU 上限、检查全局数组只增不清
5. **验证**：`old_space` 用量回落 + GC major 频率下降 + event loop p99 回落（三指标同向才确认修好）

## 5. Common Queries（Prometheus，已实测）

```promql
# 进程内存全景（MB）
dsh_dsh_runtime_memory_bytes / 1024 / 1024

# 堆占用率（接近 1 即吃满，web2 当前 ~0.98）
dsh_v8js_memory_heap_used_bytes / dsh_v8js_memory_heap_total_bytes

# old_space 泄漏趋势（6h 线性外推；斜率>0 且持续为泄漏信号）
deriv(dsh_v8js_memory_heap_space_size_bytes{v8js_heap_space_name="old_space"}[6h])

# GC 停顿 p95 与频率
histogram_quantile(0.95, sum by (le, exported_job) (rate(dsh_v8js_gc_duration_seconds_bucket[1h])))
sum by (exported_job, v8js_gc_type) (increase(dsh_v8js_gc_duration_seconds_count[1h]))

# 堆外可疑增长（RSS 涨而堆不涨时的排查位）
dsh_dsh_runtime_memory_bytes{area=~"external|array_buffers"} / 1024 / 1024
```

---

*dsh-runtime-observability 插件文档 · *
