import { describe, expect, it, vi } from 'vitest'
import { ProfilingController } from '../src/profiling.ts'

function silence() {
  return { warn: () => {}, info: () => {} }
}

function makeController() {
  return new ProfilingController({
    serverAddress: 'http://127.0.0.1:1', // 不可达：SDK 上传 fail-open，不影响生命周期
    appName: 'profiling-spec',
    flushIntervalMs: 60_000,
    sampleRateMs: 1,
    eluStopThreshold: 0.9,
  }, silence())
}

describe('profiling controller lifecycle (real SDK, off by default)', () => {
  it('is not running before start and autoStop is a no-op', async () => {
    const controller = makeController()
    expect(controller.isRunning()).toBe(false)
    await expect(controller.autoStopOnPressure(1)).resolves.toBe(false)
    await controller.stop()
    expect(controller.isRunning()).toBe(false)
  })

  it('starts with the real SDK and auto-stops on event loop pressure', async () => {
    const controller = makeController()
    await controller.start()
    expect(controller.isRunning()).toBe(true)

    // ELU ≥ 阈值 → 自动停止并返回 true
    await expect(controller.autoStopOnPressure(0.95)).resolves.toBe(true)
    expect(controller.isRunning()).toBe(false)

    // 自动停止后 autoStop 不再触发
    await expect(controller.autoStopOnPressure(0.99)).resolves.toBe(false)

    // 可再次启动（HMR/巡检场景），stop 幂等
    await controller.start()
    expect(controller.isRunning()).toBe(true)
    await controller.stop()
    await controller.stop()
    expect(controller.isRunning()).toBe(false)
  })

  it('keeps running when ELU stays below the threshold', async () => {
    const controller = makeController()
    await controller.start()
    await expect(controller.autoStopOnPressure(0.1)).resolves.toBe(false)
    expect(controller.isRunning()).toBe(true)
    await controller.stop()
  })
})
