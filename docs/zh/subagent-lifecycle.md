# Continuable Subagent 生命周期诊断

这组指标用于区分两类现象：正常的 child-first settlement 尾部积压，以及父 Agent 已销毁但 child Activation 仍驻留的 orphan。插件只订阅 DSH 的公开 lifecycle seam，不修改 Agent 或 continuation manager 的行为。

## 指标

- `dsh.subagent.activations{state="running|waiting|settled_pending"}`：驻留 Activation 数量。
- `dsh.subagent.activation.oldest_age{state=...}`：各状态中最长连续滞留秒数。
- `dsh.subagent.orphans`：父 Agent 已触发 `agent/disposed`、child Activation 仍未释放的数量。
- `dsh.subagent.orphan.oldest_age`：最老 orphan 的持续秒数。
- `dsh.subagent.lifecycle.events{event="started|disposed|orphaned"}`：累计生命周期事件；`orphaned` 按受影响 Activation 计数。

状态来自公开事件的进程内投影：

- `running`：Agent status 为 running，或存在已进入 inbox 尚未 claimed/discarded 的消息。
- `waiting`：Agent 已 idle，但仍有驻留的直接 continuable child。
- `settled_pending`：Agent 已 idle、没有驻留 child，但 setup disposer 尚未完成；这里包括 session flush、handle dispose 等正常尾部窗口。

`orphan` 是独立维度，不与上述状态互斥。它只在父 Agent 的真实 `agent/disposed` 事件发生后标记，不根据超时猜测。内部只保留 session id 用于进程内关联，导出标签不包含任何 id。

## 判读

| 任务结束后的现象 | 判断 |
|---|---|
| `running` 很快归零，`settled_pending` 短暂升高后归零 | 正常 flush/dispose 尾部 |
| `waiting` 持续且仍有 child | ownership graph 尚未收敛，继续检查最深 child |
| `orphans > 0` | 父子销毁交接缺失，属于生命周期异常的直接证据 |
| Activation 全部归零、ELU 回落，但 RSS 仍高 | 更像 V8 留存，不是事件循环仍忙 |
| Activation 全部归零、active resources 仍高且 ELU 不回落 | 非 subagent Activation 的 timer/socket/stream 等资源残留 |

## 五分钟衰减实验

1. 空闲 2 分钟记录 ELU、event-loop delay、active resources、heap/GC 与 subagent baseline。
2. 启动 4～6 个 continuable subagent，等待 UI 显示完成。
3. 不再发送请求，继续采集 5 分钟。
4. 对齐观察 `activations`、`orphans`、`active_resources`、ELU、heap 与 GC。

正常验收：`running → 0`，`waiting → 0`，`settled_pending → 0`，`orphans = 0`，ELU 和 active resources 回到 baseline。RSS 不要求立即回落。

注意：这组指标证明驻留和父子交接状态；它不能单独证明某个 timer、socket 或 exporter 是持续 ELU 的直接 CPU 来源。直接归因仍需与 active resources、event-loop delay 和 profile 联读。
