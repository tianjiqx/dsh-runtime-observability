import type { UserConfig } from 'tsdown'

export default [{
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      'cordis',
      '@pyroscope/nodejs',
      '@opentelemetry/exporter-metrics-otlp-proto',
      '@opentelemetry/instrumentation-runtime-node',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-metrics',
    ],
  },
}] satisfies UserConfig[]
