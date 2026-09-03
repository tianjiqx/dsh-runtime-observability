type PyroscopeModule = {
  init(config: Record<string, unknown>): unknown
  start(): unknown
  stop(): Promise<void> | void
}

/**
 * In-process continuous profiling control. The SDK is loaded lazily so a
 * disabled configuration never touches the native binding. Start failures
 * are fail-open: they degrade to a local warning and never affect the host.
 */
export class ProfilingController {
  private mod: PyroscopeModule | undefined
  private running = false

  constructor(
    private readonly config: {
      serverAddress: string
      appName: string
      flushIntervalMs: number
      sampleRateMs: number
      eluStopThreshold: number
    },
    private readonly log: {
      warn: (message: string) => void
      info: (message: string) => void
    } = console,
  ) {}

  isRunning(): boolean { return this.running }

  /** One start attempt; SDK upload failures stay fail-open inside the SDK. */
  async start(): Promise<void> {
    if (this.running || this.mod) return
    try {
      const mod = (await import('@pyroscope/nodejs')) as { default?: PyroscopeModule } & PyroscopeModule
      const pyroscope = (mod.default ?? mod) as PyroscopeModule
      pyroscope.init({
        appName: this.config.appName,
        serverAddress: this.config.serverAddress,
        flushIntervalMs: this.config.flushIntervalMs,
      })
      pyroscope.start()
      this.mod = pyroscope
      this.running = true
      this.log.info(`[dsh-runtime-observability] profiling started → ${this.config.serverAddress} (${this.config.appName})`)
    } catch (error) {
      this.log.warn(`[dsh-runtime-observability] profiling failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.mod) return
    this.running = false
    try {
      await this.mod.stop()
      this.log.info('[dsh-runtime-observability] profiling stopped')
    } catch (error) {
      this.log.warn(`[dsh-runtime-observability] profiling stop failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.mod = undefined
    }
  }

  /**
   * §3.1.8 降级：event loop 明显恶化时自动停止 profiling 并记录原因。
   * 返回 true 表示本次检查触发了自动停止。
   */
  async autoStopOnPressure(eventLoopUtilization: number): Promise<boolean> {
    if (!this.running) return false
    if (eventLoopUtilization < this.config.eluStopThreshold) return false
    this.log.warn(`[dsh-runtime-observability] profiling auto-stopped: event loop utilization ${eventLoopUtilization.toFixed(3)} ≥ ${this.config.eluStopThreshold}`)
    await this.stop()
    return true
  }
}
