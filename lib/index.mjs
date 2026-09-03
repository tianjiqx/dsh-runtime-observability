import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { monitorEventLoopDelay } from "node:perf_hooks";
//#region src/runtime-snapshot.ts
const NANOS_PER_SECOND = 1e9;
function nanosecondsToSeconds(value) {
	return value / NANOS_PER_SECOND;
}
function countActiveResources(resources, limit = 32) {
	const counts = /* @__PURE__ */ new Map();
	for (const resource of resources) {
		if (counts.size === limit && !counts.has(resource)) continue;
		counts.set(resource, (counts.get(resource) ?? 0) + 1);
	}
	return counts;
}
var RuntimeSnapshotCollector = class {
	delay;
	readEluSnapshot;
	calculateElu;
	memoryUsage;
	activeResources;
	previousElu;
	constructor(delay = monitorEventLoopDelay({ resolution: 20 }), readEluSnapshot = () => performance.eventLoopUtilization(), calculateElu = (current, previous) => previous === void 0 ? current : performance.eventLoopUtilization(current, previous), memoryUsage = () => process.memoryUsage(), activeResources = () => process.getActiveResourcesInfo()) {
		this.delay = delay;
		this.readEluSnapshot = readEluSnapshot;
		this.calculateElu = calculateElu;
		this.memoryUsage = memoryUsage;
		this.activeResources = activeResources;
		this.delay.enable?.();
	}
	collect() {
		const currentElu = this.readEluSnapshot();
		const elu = this.calculateElu(currentElu, this.previousElu);
		this.previousElu = currentElu;
		const memory = this.memoryUsage();
		const snapshot = {
			eventLoopDelayP50Seconds: nanosecondsToSeconds(this.delay.percentile(50)),
			eventLoopDelayP90Seconds: nanosecondsToSeconds(this.delay.percentile(90)),
			eventLoopDelayP99Seconds: nanosecondsToSeconds(this.delay.percentile(99)),
			eventLoopUtilization: elu.utilization,
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
			externalBytes: memory.external,
			arrayBuffersBytes: memory.arrayBuffers,
			activeResources: countActiveResources(this.activeResources())
		};
		this.delay.reset();
		return snapshot;
	}
	dispose() {
		this.delay.disable?.();
	}
};
//#endregion
//#region src/quality.ts
/**
* Tracks telemetry pipeline health: cumulative counters for attempts/failures,
* a sliding-window consecutive-failure counter for the circuit breaker, and a
* token-bucket log throttle so a dead endpoint cannot flood stderr.
*/
var TelemetryQuality = class {
	maxTokens;
	windowMs;
	exportAttempts = 0;
	exportFailures = 0;
	consecutiveFailures = 0;
	circuitOpen = false;
	circuitOpenedAt = 0;
	logTokens;
	logLastRefill = 0;
	logsSuppressed = 0;
	constructor(maxTokens = 5, windowMs = 6e4) {
		this.maxTokens = maxTokens;
		this.windowMs = windowMs;
		this.logTokens = maxTokens;
		this.logLastRefill = now();
	}
	recordExportAttempt() {
		this.exportAttempts += 1;
	}
	recordExportFailure() {
		this.exportFailures += 1;
		this.consecutiveFailures += 1;
	}
	/** Called by the exporter after a successful batch. */
	recordExportSuccess() {
		this.consecutiveFailures = 0;
		if (this.circuitOpen) this.circuitOpen = false;
	}
	/**
	* Returns true when the circuit breaker should OPEN (consecutive failures
	* reached the threshold). Caller is responsible for the actual pause.
	*/
	tripCircuitBreaker(threshold) {
		if (threshold <= 0) return false;
		if (this.consecutiveFailures < threshold) return false;
		if (this.circuitOpen) return false;
		this.circuitOpen = true;
		this.circuitOpenedAt = now();
		return true;
	}
	/**
	* Returns true when the circuit breaker cooldown has elapsed and a single
	* probe export should be allowed through. Caller must reset state on the
	* probe result via recordExportSuccess / recordExportFailure.
	*/
	shouldProbe(cooldownMs) {
		if (!this.circuitOpen) return false;
		return now() - this.circuitOpenedAt >= cooldownMs;
	}
	/**
	* Returns true if a failure log line should be emitted right now. When the
	* bucket is empty, the call is suppressed and `logsSuppressed` increments.
	*/
	consumeLogToken() {
		const t = now();
		const elapsed = t - this.logLastRefill;
		if (elapsed > 0) {
			const refill = elapsed / this.windowMs * this.maxTokens;
			if (refill > 0) {
				this.logTokens = Math.min(this.maxTokens, this.logTokens + refill);
				this.logLastRefill = t;
			}
		}
		if (this.logTokens >= 1) {
			this.logTokens -= 1;
			return true;
		}
		this.logsSuppressed += 1;
		return false;
	}
	snapshot() {
		return {
			exportAttempts: this.exportAttempts,
			exportFailures: this.exportFailures,
			consecutiveFailures: this.consecutiveFailures,
			circuitOpen: this.circuitOpen,
			logsSuppressed: this.logsSuppressed
		};
	}
};
function now() {
	return Date.now();
}
//#endregion
//#region src/counting-exporter.ts
/**
* Wraps an OTLP metric exporter with:
* - cumulative attempt/failure counters (observable via `dsh.telemetry.export`)
* - a token-bucket log throttle so a dead endpoint cannot flood stderr
* - a circuit breaker that pauses exports after N consecutive failures and
*   resumes after a cooldown with a single probe request
*
* A failed batch is reported locally and left to the SDK's configured retry
* behavior; it is never rethrown into an Agent Run.
*/
var CountingMetricExporter = class {
	delegate;
	quality;
	warn;
	logThrottlePerMinute;
	circuitBreakerThreshold;
	circuitBreakerCooldownMs;
	probing = false;
	paused = false;
	constructor(delegate, quality, warn = console.warn, options = {}) {
		this.delegate = delegate;
		this.quality = quality;
		this.warn = warn;
		this.logThrottlePerMinute = options.logThrottlePerMinute ?? 5;
		this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 10;
		this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 3e5;
	}
	isCircuitOpen() {
		return this.quality.snapshot().circuitOpen && !this.probing;
	}
	isPaused() {
		return this.paused;
	}
	setPaused(paused) {
		this.paused = paused;
	}
	export(metrics, resultCallback) {
		if (this.paused) {
			resultCallback({ code: 0 });
			return;
		}
		if (this.quality.snapshot().circuitOpen) {
			if (this.quality.shouldProbe(this.circuitBreakerCooldownMs)) this.probing = true;
			else {
				resultCallback({ code: 0 });
				return;
			}
		}
		this.quality.recordExportAttempt();
		this.delegate.export(metrics, (result) => {
			const wasProbe = this.probing;
			this.probing = false;
			if (result.code !== 0) {
				this.quality.recordExportFailure();
				if (this.quality.consumeLogToken()) this.warn(`[dsh-runtime-observability] metric export failed: ${result.error?.message ?? "unknown error"}`);
				if (this.quality.tripCircuitBreaker(this.circuitBreakerThreshold)) this.warn(`[dsh-runtime-observability] circuit breaker open: ${this.circuitBreakerThreshold} consecutive failures, pausing exports for ${this.circuitBreakerCooldownMs / 1e3}s`);
			} else {
				this.quality.recordExportSuccess();
				if (wasProbe) this.warn("[dsh-runtime-observability] circuit breaker closed: probe export succeeded");
			}
			resultCallback(result);
		});
	}
	forceFlush() {
		return this.delegate.forceFlush();
	}
	shutdown() {
		return this.delegate.shutdown();
	}
	selectAggregationTemporality(instrumentType) {
		return this.delegate.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE;
	}
};
//#endregion
//#region src/profiling.ts
/**
* In-process continuous profiling control. The SDK is loaded lazily so a
* disabled configuration never touches the native binding. Start failures
* are fail-open: they degrade to a local warning and never affect the host.
*/
var ProfilingController = class {
	config;
	log;
	mod;
	running = false;
	constructor(config, log = console) {
		this.config = config;
		this.log = log;
	}
	isRunning() {
		return this.running;
	}
	/** One start attempt; SDK upload failures stay fail-open inside the SDK. */
	async start() {
		if (this.running || this.mod) return;
		try {
			const mod = await import("@pyroscope/nodejs");
			const pyroscope = mod.default ?? mod;
			pyroscope.init({
				appName: this.config.appName,
				serverAddress: this.config.serverAddress,
				flushIntervalMs: this.config.flushIntervalMs
			});
			pyroscope.start();
			this.mod = pyroscope;
			this.running = true;
			this.log.info(`[dsh-runtime-observability] profiling started → ${this.config.serverAddress} (${this.config.appName})`);
		} catch (error) {
			this.log.warn(`[dsh-runtime-observability] profiling failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async stop() {
		if (!this.running || !this.mod) return;
		this.running = false;
		try {
			await this.mod.stop();
			this.log.info("[dsh-runtime-observability] profiling stopped");
		} catch (error) {
			this.log.warn(`[dsh-runtime-observability] profiling stop failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.mod = void 0;
		}
	}
	/**
	* §3.1.8 降级：event loop 明显恶化时自动停止 profiling 并记录原因。
	* 返回 true 表示本次检查触发了自动停止。
	*/
	async autoStopOnPressure(eventLoopUtilization) {
		if (!this.running) return false;
		if (eventLoopUtilization < this.config.eluStopThreshold) return false;
		this.log.warn(`[dsh-runtime-observability] profiling auto-stopped: event loop utilization ${eventLoopUtilization.toFixed(3)} ≥ ${this.config.eluStopThreshold}`);
		await this.stop();
		return true;
	}
};
//#endregion
//#region src/index.ts
const STATE = Symbol.for("dsh.runtime.observability.state");
const SCOPE = "dsh-runtime-observability";
const processState = globalThis;
var RuntimeObservability = class {
	quality = new TelemetryQuality();
	snapshot = new RuntimeSnapshotCollector();
	provider;
	reader;
	countingExporter;
	runtimeInstrumentation;
	profiling;
	profilingStartTimer;
	eluPaused = false;
	disposed = false;
	constructor(rawConfig = {}) {
		const config = normalizeConfig(rawConfig);
		if (config.enabled && config.endpoint) {
			const otlpExporter = new OTLPMetricExporter({ url: normalizeMetricsEndpoint(config.endpoint) });
			this.countingExporter = new CountingMetricExporter(otlpExporter, this.quality, console.warn, {
				logThrottlePerMinute: config.resilience.logThrottlePerMinute,
				circuitBreakerThreshold: config.resilience.circuitBreakerThreshold,
				circuitBreakerCooldownMs: config.resilience.circuitBreakerCooldownMs
			});
			this.reader = new PeriodicExportingMetricReader({
				exporter: this.countingExporter,
				exportIntervalMillis: config.exportIntervalMillis
			});
			this.provider = new MeterProvider({
				resource: resourceFromAttributes({
					"service.name": config.serviceName,
					"service.version": config.serviceVersion,
					"service.instance.id": config.serviceInstanceId
				}),
				readers: [this.reader]
			});
			if (config.runtimeMetrics) {
				this.runtimeInstrumentation = new RuntimeNodeInstrumentation();
				this.runtimeInstrumentation.setMeterProvider(this.provider);
				this.runtimeInstrumentation.enable();
			}
			this.registerMetrics(config.resilience.eluPauseThreshold);
		}
		if (config.enabled && config.profiling.enabled && config.profiling.serverAddress) {
			const profiling = new ProfilingController({
				serverAddress: config.profiling.serverAddress,
				appName: config.profiling.appName,
				flushIntervalMs: config.profiling.flushIntervalMs,
				sampleRateMs: config.profiling.sampleRateMs,
				eluStopThreshold: config.profiling.eluStopThreshold
			});
			this.profiling = profiling;
			this.profilingStartTimer = setTimeout(() => {
				profiling.start();
			}, config.profiling.bootDelayMs);
			this.profilingStartTimer.unref?.();
		}
	}
	telemetryQuality() {
		return this.quality.snapshot();
	}
	isDisposed() {
		return this.disposed;
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.profilingStartTimer) clearTimeout(this.profilingStartTimer);
		this.snapshot.dispose();
		this.runtimeInstrumentation?.disable();
		await this.profiling?.stop();
		await this.provider?.shutdown();
	}
	registerMetrics(eluPauseThreshold) {
		const meter = this.provider?.getMeter(SCOPE);
		if (!meter) return;
		const runtime = meter.createObservableGauge("dsh.runtime.event_loop.delay", {
			description: "Node.js event loop delay in seconds.",
			unit: "s"
		});
		const utilization = meter.createObservableGauge("dsh.runtime.event_loop.utilization", {
			description: "Node.js event loop utilization ratio.",
			unit: "1"
		});
		const memory = meter.createObservableGauge("dsh.runtime.memory", {
			description: "Node.js process memory by area.",
			unit: "By"
		});
		const activeResources = meter.createObservableGauge("dsh.runtime.active_resources", {
			description: "Active Node.js resources by resource type.",
			unit: "{resource}"
		});
		const exports = meter.createObservableGauge("dsh.telemetry.export", {
			description: "Observability exporter quality counters.",
			unit: "{record}"
		});
		meter.addBatchObservableCallback((result) => {
			const values = this.snapshot.collect();
			result.observe(runtime, values.eventLoopDelayP50Seconds, { quantile: "0.5" });
			result.observe(runtime, values.eventLoopDelayP90Seconds, { quantile: "0.9" });
			result.observe(runtime, values.eventLoopDelayP99Seconds, { quantile: "0.99" });
			result.observe(utilization, values.eventLoopUtilization);
			result.observe(memory, values.rssBytes, { area: "rss" });
			result.observe(memory, values.heapUsedBytes, { area: "heap_used" });
			result.observe(memory, values.heapTotalBytes, { area: "heap_total" });
			result.observe(memory, values.externalBytes, { area: "external" });
			result.observe(memory, values.arrayBuffersBytes, { area: "array_buffers" });
			for (const [type, count] of values.activeResources) result.observe(activeResources, count, { type });
			const quality = this.quality.snapshot();
			result.observe(exports, quality.exportAttempts, { outcome: "attempt" });
			result.observe(exports, quality.exportFailures, { outcome: "failure" });
			result.observe(exports, quality.consecutiveFailures, { outcome: "consecutive_failure" });
			result.observe(exports, quality.logsSuppressed, { outcome: "log_suppressed" });
			this.profiling?.autoStopOnPressure(values.eventLoopUtilization);
			this.handleEluDegradation(values.eventLoopUtilization, eluPauseThreshold);
		}, [
			runtime,
			utilization,
			memory,
			activeResources,
			exports
		]);
	}
	/**
	* When ELU exceeds the pause threshold, gate metric exporter network I/O.
	* Resume when ELU drops below (threshold - hysteresis). The reader remains
	* alive so provider lifecycle stays stable while the delegate is paused.
	*/
	handleEluDegradation(elu, threshold) {
		if (threshold <= 0) return;
		if (!this.reader) return;
		const hysteresis = .05;
		if (!this.eluPaused && elu >= threshold) {
			this.eluPaused = true;
			this.countingExporter?.setPaused(true);
			console.warn(`[dsh-runtime-observability] metric export paused: event loop utilization ${elu.toFixed(3)} ≥ ${threshold}`);
		} else if (this.eluPaused && elu < threshold - hysteresis) {
			this.eluPaused = false;
			this.countingExporter?.setPaused(false);
			console.warn(`[dsh-runtime-observability] metric export resumed: event loop utilization ${elu.toFixed(3)} < ${threshold - hysteresis}`);
		}
	}
};
function normalizeConfig(config) {
	return {
		enabled: config.enabled ?? true,
		endpoint: config.endpoint ?? "",
		serviceName: config.serviceName ?? "dsh-agent",
		serviceVersion: config.serviceVersion ?? "unknown",
		serviceInstanceId: config.serviceInstanceId ?? process.pid.toString(),
		exportIntervalMillis: config.exportIntervalMillis ?? 1e4,
		runtimeMetrics: config.runtimeMetrics ?? true,
		profiling: normalizeProfiling(config),
		resilience: normalizeResilience(config)
	};
}
function normalizeProfiling(config) {
	const raw = config.profiling ?? {};
	return {
		enabled: raw.enabled ?? false,
		serverAddress: raw.serverAddress ?? "",
		appName: raw.appName ?? config.serviceName ?? "dsh-agent",
		flushIntervalMs: raw.flushIntervalMs ?? 6e4,
		bootDelayMs: raw.bootDelayMs ?? 3e4,
		sampleRateMs: raw.sampleRateMs ?? 6e4,
		eluStopThreshold: raw.eluStopThreshold ?? .9
	};
}
function normalizeResilience(config) {
	const raw = config.resilience ?? {};
	return {
		logThrottlePerMinute: raw.logThrottlePerMinute ?? 5,
		circuitBreakerThreshold: raw.circuitBreakerThreshold ?? 10,
		circuitBreakerCooldownMs: raw.circuitBreakerCooldownMs ?? 3e5,
		eluPauseThreshold: raw.eluPauseThreshold ?? .95
	};
}
function apply(ctx, config = {}) {
	const configKey = stableStringify(normalizeConfig(config));
	let state = processState[STATE];
	if (!state || state.service.isDisposed() || state.configKey !== configKey) {
		state?.service.dispose();
		state = {
			references: 0,
			service: new RuntimeObservability(config),
			configKey
		};
		processState[STATE] = state;
	}
	state.references += 1;
	const unprovide = ctx.provide("dshRuntimeObservability", state.service);
	ctx.effect(() => () => {
		unprovide();
		release(state);
	}, "dsh-runtime-observability: cleanup");
	return state.service;
}
function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
function release(state) {
	if (!state) return;
	state.references -= 1;
	if (state.references <= 0) {
		state.service.dispose();
		if (processState[STATE] === state) processState[STATE] = void 0;
	}
}
function normalizeMetricsEndpoint(endpoint) {
	const normalized = endpoint.replace(/\/+$/, "");
	return normalized.endsWith("/v1/metrics") ? normalized : `${normalized}/v1/metrics`;
}
//#endregion
export { RuntimeObservability, apply, normalizeMetricsEndpoint };
