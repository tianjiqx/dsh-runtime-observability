import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

type Cleanup = () => void | Promise<void>

function createContext() {
  const cleanups: Cleanup[] = []
  let provided = 0
  return {
    context: {
      provide: () => {
        provided += 1
        return () => { provided -= 1 }
      },
      effect: (callback: () => Cleanup) => {
        cleanups.push(callback())
      },
    },
    dispose: async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    },
    provided: () => provided,
  }
}

describe('Cordis activation lifecycle', () => {
  it('keeps the shared service alive while an overlapping HMR fiber remains', async () => {
    const firstContext = createContext()
    const secondContext = createContext()
    const first = apply(firstContext.context as never, { enabled: false })
    const second = apply(secondContext.context as never, { enabled: false })

    expect(second).toBe(first)
    await firstContext.dispose()
    expect(first.isDisposed()).toBe(false)
    expect(secondContext.provided()).toBe(1)

    await secondContext.dispose()
    expect(first.isDisposed()).toBe(true)
  })

  it('treats equivalent normalized configs with different key order as the same service', async () => {
    const firstContext = createContext()
    const secondContext = createContext()
    const first = apply(firstContext.context as never, {
      enabled: false,
      profiling: { enabled: false, sampleRateMs: 1000 },
      resilience: { circuitBreakerThreshold: 3, logThrottlePerMinute: 2 },
    })
    const second = apply(secondContext.context as never, {
      resilience: { logThrottlePerMinute: 2, circuitBreakerThreshold: 3 },
      profiling: { sampleRateMs: 1000, enabled: false },
      enabled: false,
    })
    expect(second).toBe(first)
    await firstContext.dispose()
    await secondContext.dispose()
  })

  it('does not install DSH lifecycle observers when no metrics endpoint exists', async () => {
    const context = createContext()
    const service = apply(context.context as never)
    expect(service.isDisposed()).toBe(false)
    await context.dispose()
    expect(service.isDisposed()).toBe(true)
  })
})
