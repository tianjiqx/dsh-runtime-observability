# DSH 遥测导出质量指标说明与Guide

> 指标来源：**本插件**直接暴露 `dsh.telemetry.export{outcome}`（`src/index.ts:112`，计数器语义在 `src/counting-exporter.ts`）。
> （Prometheus 实测）。
> Related：[elu-event-loop-utilization.md](./elu-event-loop-utilization.md)（ELU 线是导出暂停的条件之一）· [README](../README.md) 韧性章节（节流/断路器配置）

---

## 1. Definition

**遥测导出质量 = 插件自身向 Collector 推送 OTLP 指标的成败账本**。它监控的对象不是业务，而是**观测管道的第一跳**——回答"这个进程的指标还在 reliably 出货吗"。

Prometheus 名：`dsh_dsh_telemetry_export`（OTel 点号名 `dsh.telemetry.export` 经 Collector namespace 转换；**不是** `dsh_dsh_runtime_telemetry_export`，别查错名）。

## 2. outcome 五态账本

| outcome | 含义 | 健康态 |
|---|---|---|
| `attempt` | 导出尝试总数（分母） | 持续增长（10s 一跳） |
| `failure` | 失败次数 | **增长应为 0** |
| `consecutive_failure` | 当前连续失败次数 | 0；>0 = **正在故障中** |
| `log_suppressed` | 被日志节流吞掉的告警条数 | 0；>0 = 失败多到日志都被限流（对应 `resilience.logThrottlePerMinute`） |
| `circuit_open` | 断路器打开次数 | 0；>0 = 连续失败达 `circuitBreakerThreshold`(10) 触发熔断，冷却 5 分钟后半开探测 |

**失败不阻塞业务**：导出失败只写本地 warning（且被节流），Agent Run 不受影响——这是插件的 fail-open 设计底线。

## 3. Diagnosis Flow

```
failure 增长了？
├─ 否（attempt 涨、failure 平）           → ✅ 健康出货
├─ 是，但 consecutive_failure=0 且近 5min 无增量 → 历史故障已恢复，查故障时段与 Collector 当时状态
├─ 是，且 consecutive_failure>0          → 🔴 正在断：链路第一跳断（Collector 挂/网络/ELU 线压制导出）
│    └─ 查 circuit_open / log_suppressed 是否也开始涨（进入节流+熔断深水区）
└─ 只在 ELU >0.95 时段出现 failure        → 不是网络问题，是插件 ELU 降级线主动暂停导出
```

关键区分（与 dsh-inspect-agent R2-AUTH 同源思想）：**本指标讲的是"进程 → Collector"第一跳；Collector 之后断没断（→ Prometheus/ClickHouse）由巡检的 `collector_exporter_failures` / `otel_logs_freshness` 负责**。两段别混。

## 4. Diagnosis Example（example snapshot）

| 实例 | attempt | failure | 判读 |
|---|---|---|---|
| dsh-agent | 398 | 0 | ✅ 全成功 |
| dsh-agent-web2 | 605 | 18（累计） | ✅ 当前健康：24h +128 次失败全部集中在 6~12h 前（web2 重启激活窗口），近 1h 增量 0、`consecutive_failure` 无序列 |

数据面还交叉验证了自保机制：失败未伴随 `log_suppressed`/`circuit_open`（阈值未触发），说明当时是间歇失败而非持续断链。

## 5. Remediation Playbook

1. **正在连续失败**（consecutive_failure>0）：
   - `curl http://localhost:4318` 通不通 → 查 Collector（13133 health）→ 查当时 ELU 是否 >0.95（自保暂停不算故障）
2. **熔断已打开**（circuit_open>0）：等待 5 分钟冷却后半开探测自动恢复；期间指标缺口是预期行为，勿重复重启
3. **历史失败归因**：`increase(...[window])` 分窗口二分故障起止，与该时段的 Collector 重启/网络变更/web2 重启对时间线
4. **验收恢复**：attempt 恢复增长 + failure 增量归零 + Grafana Runtime Diagnostics 看板数据恢复新鲜

## 6. Common Queries（Prometheus，已实测）

```promql
# 各实例成败总账
dsh_dsh_telemetry_export

# 近 24h 失败增量
sum by (exported_job) (increase(dsh_dsh_telemetry_export{outcome="failure"}[24h]))

# 正在连续失败的实例（结果应为空）
dsh_dsh_telemetry_export{outcome="consecutive_failure"} > 0

# 分窗口二分故障时段（1h/6h/12h/24h 逐级收窄）
sum(increase(dsh_dsh_telemetry_export{outcome="failure"}[1h]))

# 导出成功率
1 - (sum(increase(dsh_dsh_telemetry_export{outcome="failure"}[1h]))
   / clamp_min(sum(increase(dsh_dsh_telemetry_export{outcome="attempt"}[1h])), 1e-9))
```

---

*dsh-runtime-observability 插件文档 · *
