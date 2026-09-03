import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { TelemetryQuality } from '../src/quality.ts'
import { CountingMetricExporter } from '../src/counting-exporter.ts'

describe('telemetry quality counters', () => {
  it('records exporter attempts and failures', () => {
    const quality = new TelemetryQuality()
    quality.recordExportAttempt()
    quality.recordExportFailure()
    quality.recordExportSuccess() // resets consecutive

    const snap = quality.snapshot()
    expect(snap.exportAttempts).toBe(1)
    expect(snap.exportFailures).toBe(1)
    expect(snap.consecutiveFailures).toBe(0)
    expect(snap.circuitOpen).toBe(false)
  })

  it('tracks consecutive failures and trips the circuit breaker', () => {
    const quality = new TelemetryQuality()
    for (let i = 0; i < 5; i++) {
      quality.recordExportAttempt()
      quality.recordExportFailure()
    }
    expect(quality.snapshot().consecutiveFailures).toBe(5)
    expect(quality.tripCircuitBreaker(10)).toBe(false) // not yet

    for (let i = 0; i < 5; i++) {
      quality.recordExportAttempt()
      quality.recordExportFailure()
    }
    expect(quality.snapshot().consecutiveFailures).toBe(10)
    expect(quality.tripCircuitBreaker(10)).toBe(true) // trips
    expect(quality.snapshot().circuitOpen).toBe(true)

    // tripCircuitBreaker is idempotent while open
    expect(quality.tripCircuitBreaker(10)).toBe(false)
  })

  it('resets consecutive failures on success', () => {
    const quality = new TelemetryQuality()
    quality.recordExportFailure()
    quality.recordExportFailure()
    expect(quality.snapshot().consecutiveFailures).toBe(2)
    quality.recordExportSuccess()
    expect(quality.snapshot().consecutiveFailures).toBe(0)
  })

  it('throttles log tokens and tracks suppressed count', () => {
    const quality = new TelemetryQuality(3, 60_000) // 3 tokens per minute
    expect(quality.consumeLogToken()).toBe(true)
    expect(quality.consumeLogToken()).toBe(true)
    expect(quality.consumeLogToken()).toBe(true)
    // bucket empty
    expect(quality.consumeLogToken()).toBe(false)
    expect(quality.consumeLogToken()).toBe(false)
    expect(quality.snapshot().logsSuppressed).toBe(2)
  })
})

describe('counting metric exporter with resilience', () => {
  let warnMessages: string[]

  beforeEach(() => {
    warnMessages = []
  })

  function makeWarn(): (msg: string) => void {
    return (msg: string) => { warnMessages.push(msg) }
  }

  function makeFailingDelegate() {
    return {
      export: (_metrics: unknown, callback: (result: { code: number; error?: Error }) => void) => {
        callback({ code: 1, error: new Error('offline') })
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
  }

  function makeSucceedingDelegate() {
    return {
      export: (_metrics: unknown, callback: (result: { code: number }) => void) => {
        callback({ code: 0 })
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
  }

  it('counts failed transport batches without throwing', () => {
    const quality = new TelemetryQuality()
    const exporter = new CountingMetricExporter({
      export: (_metrics, callback) => callback({ code: 1, error: new Error('offline') }),
      forceFlush: async () => {},
      shutdown: async () => {},
    }, quality, () => {})

    exporter.export({} as never, () => {})
    expect(quality.snapshot()).toMatchObject({ exportAttempts: 1, exportFailures: 1 })
  })

  it('skips delegate export while explicitly paused and resumes afterwards', () => {
    const quality = new TelemetryQuality()
    let delegateCalls = 0
    const exporter = new CountingMetricExporter({
      export: (_metrics, callback) => { delegateCalls++; callback({ code: 0 }) },
      forceFlush: async () => {},
      shutdown: async () => {},
    }, quality, () => {})

    exporter.setPaused(true)
    exporter.export({} as never, () => {})
    expect(delegateCalls).toBe(0)
    expect(exporter.isPaused()).toBe(true)

    exporter.setPaused(false)
    exporter.export({} as never, () => {})
    expect(delegateCalls).toBe(1)
  })

  it('throttles failure logs to the configured per-minute limit', () => {
    const quality = new TelemetryQuality(2, 60_000) // 2 logs/min
    const exporter = new CountingMetricExporter(
      makeFailingDelegate(),
      quality,
      makeWarn(),
      { logThrottlePerMinute: 2, circuitBreakerThreshold: 0 }, // disable circuit breaker
    )

    exporter.export({} as never, () => {})
    exporter.export({} as never, () => {})
    exporter.export({} as never, () => {}) // suppressed

    expect(warnMessages.filter(m => m.includes('metric export failed'))).toHaveLength(2)
    expect(quality.snapshot().logsSuppressed).toBe(1)
  })

  it('opens the circuit breaker after N consecutive failures', () => {
    const quality = new TelemetryQuality()
    const exporter = new CountingMetricExporter(
      makeFailingDelegate(),
      quality,
      makeWarn(),
      { circuitBreakerThreshold: 3, circuitBreakerCooldownMs: 60_000, logThrottlePerMinute: 100 },
    )

    // 3 failures → circuit opens
    exporter.export({} as never, () => {})
    exporter.export({} as never, () => {})
    exporter.export({} as never, () => {})

    expect(quality.snapshot().circuitOpen).toBe(true)
    expect(warnMessages.some(m => m.includes('circuit breaker open'))).toBe(true)

    // Next export is skipped (circuit open, cooldown not elapsed)
    let callbackCalled = false
    exporter.export({} as never, () => { callbackCalled = true })
    expect(callbackCalled).toBe(true) // callback called with code 0 (skipped)
    // No additional attempt counted (delegate not called)
    expect(quality.snapshot().exportAttempts).toBe(3)
  })

  it('allows a probe export after cooldown and closes circuit on success', () => {
    vi.useFakeTimers()
    const quality = new TelemetryQuality()
    let delegateCallCount = 0
    let delegateShouldSucceed = false

    const delegate = {
      export: (_metrics: unknown, callback: (result: { code: number; error?: Error }) => void) => {
        delegateCallCount++
        if (delegateShouldSucceed) {
          callback({ code: 0 })
        } else {
          callback({ code: 1, error: new Error('offline') })
        }
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }

    const exporter = new CountingMetricExporter(
      delegate,
      quality,
      makeWarn(),
      { circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 5000, logThrottlePerMinute: 100 },
    )

    // Trip the breaker
    exporter.export({} as never, () => {})
    exporter.export({} as never, () => {})
    expect(quality.snapshot().circuitOpen).toBe(true)

    // Before cooldown: skipped
    exporter.export({} as never, () => {})
    expect(delegateCallCount).toBe(2) // not called

    // After cooldown: probe allowed
    vi.advanceTimersByTime(6000)
    delegateShouldSucceed = true
    exporter.export({} as never, () => {})
    expect(delegateCallCount).toBe(3) // probe went through
    expect(quality.snapshot().circuitOpen).toBe(false)
    expect(warnMessages.some(m => m.includes('circuit breaker closed'))).toBe(true)

    vi.useRealTimers()
  })
})
