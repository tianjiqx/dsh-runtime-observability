import { describe, expect, it, vi } from 'vitest'
import { ProfilingController } from '../src/profiling.ts'

// 模拟原生包加载失败（如 ABI 不匹配的机器）：动态 import 抛错。
vi.mock('@pyroscope/nodejs', () => {
  throw new Error('native binding load failed')
})

describe('profiling controller when the SDK cannot load', () => {
  it('start failure is fail-open: warn locally, never throw, stays not-running', async () => {
    const warnings: string[] = []
    const controller = new ProfilingController({
      serverAddress: 'http://127.0.0.1:1',
      appName: 't',
      flushIntervalMs: 1000,
      sampleRateMs: 1,
      eluStopThreshold: 0.9,
    }, { warn: (m) => warnings.push(m), info: () => {} })

    await expect(controller.start()).resolves.toBeUndefined()
    expect(controller.isRunning()).toBe(false)
    expect(warnings.join('\n')).toContain('profiling failed to start')
  })
})
