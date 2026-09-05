# 活跃资源

> 指标来源：**本插件** 暴露 `dsh.runtime.active_resources{type}`
> 关联文档：[ELU 指南](./elu-event-loop-utilization.md) · [事件循环延迟](./event-loop-delay.md) · [README](../README.md)

---

## 1. 一句话定义

**活跃资源 = 此刻还挂在事件循环上的句柄/请求计数**，按 libuv 类型分列。事件循环"歇不下来"的直接原因就是还有活跃资源没释放——它是**连接/句柄泄漏的直接探测器**，也是进程"关不掉、退不出"的原因排查入口。

采集自 `process.getActiveResourcesInfo()`（Node ≥ 17.3），插件最多列 32 种类型防基数爆炸。

## 2. 常见 type 速查

| type | 对应资源 | 何时该关注 |
|---|---|---|
| `FSEventWrap` | 文件监听（fs.watch） | 数量随业务线性涨 ⇒ watcher 泄漏 |
| `Timeout` | 未触发的定时器 | **持续 > 几百** ⇒ 定时器泄漏（clearInterval 缺失、轮询累积） |
| `TCPSocketWrap` | 活跃 TCP 连接 | 稳态基线 ≈ 并发连接数；只涨不落 ⇒ 连接池/keep-alive 泄漏 |
| `FSReqPromise` | 进行中的文件读写 | 短时尖峰正常（并发 I/O）；**常态高位** ⇒ 磁盘慢或 I/O 打爆 |
| `TTYWrap` | 终端句柄（stdout/stderr） | 常规固定几个 |
| `HTTPParser`/`Server` | HTTP 连接/监听服务 | 与请求并发对账 |
| `Immediate` | setImmediate 队列 | 常态应有界；暴涨 ⇒ 分片逻辑失控 |

## 3. 判读原则

1. **看趋势不看绝对值**：各服务基线不同（文件服务 FSEventWrap 天然多），关键是**阶跃后不回落**——正常资源随请求起伏，泄漏的资源只增不减
2. **与请求量对账**：并发涨 ⇒ 资源涨是健康；并发平 ⇒ 资源涨是泄漏
3. **与 GC 对照**：句柄泄漏同时会推高 external/array_buffers（见 [memory-gc.md](./memory-gc.md) §2）
4. **类型集中在 1-2 种** ⇒ 针对性查那类 API 的释放路径；全面开花 ⇒ 上游请求堆积（回头看 ELU/延迟）

## 4. 判读示例

| 实例 | top 资源 | 类型数 | 判读 |
|---|---|---|---|
| dsh-agent | FSEventWrap 73 / Timeout 11 / FSReqPromise 8 / TCPSocketWrap 6 / TTYWrap 3 | 7 | ✅ 与基线一致，稳态 |
| dsh-agent-web2 | FSEventWrap 73 / Timeout 10 / TCPSocketWrap 8 | 11 | ✅ 基线平稳，无泄漏形态 |

两实例 FSEventWrap=73 高度一致属**预期**（同为 DSH 进程、监听同一套工作区文件树），不是异常。当前无资源泄漏迹象。

## 5. 处置 Playbook

1. 确认泄漏类型（§2 表）→ 定位对应 API 的创建/释放配对（watcher 有无 close、定时器有无 clear、连接有无 destroy）
2. 快速二分：重启后资源回到基线、随后**线性回升** ⇒ 代码泄漏；回升后走平 ⇒ 基线本身变了（配置/会话量）
3. 长期防线：给定时器/监听器/连接池加统一管理（退出路径统一清理），并用 `count_over_time` 趋势查询接告警

## 6. 常用查询

Prometheus 指标名可能因 Collector 转换而异——请以实际部署为准。

```promql
# 当前活跃资源 top8
topk(8, dsh_dsh_runtime_active_resources)

# 某类型 24h 趋势（泄漏 = 阶跃后不回落）
dsh_dsh_runtime_active_resources{type="Timeout"}

# 6h 线性斜率（>0 且持续 = 泄漏嫌疑）
deriv(dsh_dsh_runtime_active_resources{type="Timeout"}[6h])

# 资源类型基数变化（新增类型 = 新依赖引入的信号）
count by (exported_job) (dsh_dsh_runtime_active_resources)
```
