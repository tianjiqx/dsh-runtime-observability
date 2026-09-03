# DSH 遥测导出质量指标说明与Guide

> 指标来源：**本插件**直接暴露 `dsh.telemetry.export.*` 与 `dsh.telemetry.degradation.*`；旧 `dsh.telemetry.export{outcome}` 仅为看板兼容保留。
> （Prometheus 实测）。
> Related：[elu-event-loop-utilization.md](./elu-event-loop-utilization.md)（ELU 线是导出暂停的条件之一）· [README](../README.md) 韧性章节（节流/断路器配置）

---

## 1. Definition

**遥测导出质量 = 插件自身向 Collector 推送 OTLP 指标的成败账本**。它监控的对象不是业务，而是**观测管道的第一跳**——回答"这个进程的指标还在 reliably 出货吗"。

新指标经 Collector namespace 转换后以 `dsh_dsh_telemetry_*` 开头；Counter 在 Prometheus 端带 `_total` 后缀。

## 2. 累计账本与当前状态

| OTel 指标 | 类型 | 含义 | 健康态 |
|---|---|---|---|
| `dsh.telemetry.export.attempts` | Counter | 实际调用 delegate 的批次数 | 持续增长 |
| `dsh.telemetry.export.failures` | Counter | delegate 返回失败的批次数 | 增量为 0 |
| `dsh.telemetry.export.skipped{reason}` | Counter | 主动跳过的批次 | 增量为 0 |
| `dsh.telemetry.export.consecutive_failures` | Gauge | 当前连续失败数 | 0 |
| `dsh.telemetry.logs.suppressed` | Counter | 被节流的失败日志数 | 增量为 0 |
| `dsh.telemetry.circuit.open` | Gauge | 断路器当前是否打开 | 0 |
| `dsh.telemetry.degradation.events{reason}` | Counter | 降级状态进入次数 | 通常不增长 |
| `dsh.telemetry.degradation.duration{reason}` | Counter | 累计降级秒数 | 通常不增长 |
| `dsh.telemetry.degraded{reason}` | Gauge | 当前是否处于该降级状态 | 0 |

`reason` 只有 `elu_pause` 和 `circuit_open` 两个固定值。

**失败不阻塞业务**：导出失败只写本地 warning（且被节流），Agent Run 不受影响——这是插件的 fail-open 设计底线。

## 3. Diagnosis Flow

```
skipped 增长了？
├─ reason=elu_pause     → ELU 自保暂停；恢复后由 duration 补齐空窗
├─ reason=circuit_open  → 连续导出失败后的断路器跳过
└─ 没增长
   ├─ failure 增长      → 真实 delegate/网络/Collector 第一跳失败
   └─ attempt 持续增长  → 健康出货
```

**主动暂停不会增加 failure。**暂停期间同一个 OTLP metrics 通道无法实时送出自身状态；插件在内存中累计 skipped/event/duration，并在恢复后的首个批次补账。实时发现仍需独立日志或进程探针。

关键区分（与 dsh-inspect-agent R2-AUTH 同源思想）：**本指标讲的是"进程 → Collector"第一跳；Collector 之后断没断（→ Prometheus/ClickHouse）由巡检的 `collector_exporter_failures` / `otel_logs_freshness` 负责**。两段别混。

## 4. Diagnosis Example（example snapshot）

| 实例 | attempt | failure | 判读 |
|---|---|---|---|
| dsh-agent | 398 | 0 | ✅ 全成功 |
| dsh-agent-web2 | 605 | 18（累计） | ✅ 当前健康：24h +128 次失败全部集中在 6~12h 前（web2 重启激活窗口），近 1h 增量 0、`consecutive_failure` 无序列 |

数据面还交叉验证了自保机制：失败未伴随 `log_suppressed`/`circuit_open`（阈值未触发），说明当时是间歇失败而非持续断链。

## 5. Remediation Playbook

1. **正在连续失败**：查 `export.consecutive_failures` 和 `circuit.open`，再检查 Collector 13133 与网络。
2. **ELU 主动暂停**：恢复后检查 `skipped{reason="elu_pause"}` 与对应 duration 增量，不把它归入 failure。
3. **熔断已打开**：等待冷却后的半开探测；用 `reason="circuit_open"` 的 skipped 量化空窗。
4. **验收恢复**：attempt 恢复增长、failure 不再新增、degraded 回到 0、duration 固化不再增长。

## 6. 部署后查询（Prometheus 名需以 Collector 实际转换结果复核）

```promql
# 各实例成败总账
dsh_dsh_telemetry_export_attempts_total
dsh_dsh_telemetry_export_failures_total

# 近 24h 真实失败增量
sum by (exported_job) (increase(dsh_dsh_telemetry_export_failures_total[24h]))

# 主动跳过的批次
sum by (exported_job, reason) (increase(dsh_dsh_telemetry_export_skipped_total[24h]))

# 当前降级状态及累计时长
dsh_dsh_telemetry_degraded_ratio
dsh_dsh_telemetry_degradation_duration_seconds_total

# 导出成功率
1 - (sum(increase(dsh_dsh_telemetry_export_failures_total[1h]))
   / clamp_min(sum(increase(dsh_dsh_telemetry_export_attempts_total[1h])), 1e-9))
```

---

*dsh-runtime-observability 插件文档 · *
