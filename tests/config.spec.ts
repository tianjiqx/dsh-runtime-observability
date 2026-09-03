import { describe, expect, it } from 'vitest'
import { normalizeMetricsEndpoint } from '../src/index.ts'

describe('metrics endpoint normalization', () => {
  it('adds the OTLP metrics route to a Collector base URL', () => {
    expect(normalizeMetricsEndpoint('http://localhost:4318')).toBe('http://localhost:4318/v1/metrics')
  })

  it('does not duplicate an explicit metrics route', () => {
    expect(normalizeMetricsEndpoint('http://localhost:4318/v1/metrics')).toBe('http://localhost:4318/v1/metrics')
  })
})
