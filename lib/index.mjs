import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { monitorEventLoopDelay } from "node:perf_hooks";
//#region src/runtime-snapshot.ts
const NANOS_PER_SECOND = 1e9;
const MICROS_PER_SECOND = 1e6;
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
	cpuUsage;
	uptime;
	previousElu;
	constructor(delay = monitorEventLoopDelay({ resolution: 20 }), readEluSnapshot = () => performance.eventLoopUtilization(), calculateElu = (current, previous) => previous === void 0 ? current : performance.eventLoopUtilization(current, previous), memoryUsage = () => process.memoryUsage(), activeResources = () => process.getActiveResourcesInfo(), cpuUsage = () => process.cpuUsage(), uptime = () => process.uptime()) {
		this.delay = delay;
		this.readEluSnapshot = readEluSnapshot;
		this.calculateElu = calculateElu;
		this.memoryUsage = memoryUsage;
		this.activeResources = activeResources;
		this.cpuUsage = cpuUsage;
		this.uptime = uptime;
		this.delay.enable?.();
	}
	collect() {
		const currentElu = this.readEluSnapshot();
		const elu = this.calculateElu(currentElu, this.previousElu);
		this.previousElu = currentElu;
		const memory = this.memoryUsage();
		const cpu = this.cpuUsage();
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
			activeResources: countActiveResources(this.activeResources()),
			processCpuUserSeconds: cpu.user / MICROS_PER_SECOND,
			processCpuSystemSeconds: cpu.system / MICROS_PER_SECOND,
			processUptimeSeconds: this.uptime()
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
const DEGRADATION_REASONS = ["elu_pause", "circuit_open"];
function zeroByReason() {
	return {
		elu_pause: 0,
		circuit_open: 0
	};
}
/**
* Tracks telemetry pipeline health: cumulative counters for attempts/failures,
* a sliding-window consecutive-failure counter for the circuit breaker, and a
* token-bucket log throttle so a dead endpoint cannot flood stderr.
*/
var TelemetryQuality = class {
	maxTokens;
	windowMs;
	nowMs;
	exportAttempts = 0;
	exportFailures = 0;
	exportSkipped = zeroByReason();
	consecutiveFailures = 0;
	circuitOpen = false;
	circuitOpenedAt = 0;
	logTokens;
	logLastRefill = 0;
	logsSuppressed = 0;
	degradationEvents = zeroByReason();
	degradationDurationMs = zeroByReason();
	degradationStartedAt = {};
	constructor(maxTokens = 5, windowMs = 6e4, nowMs = now) {
		this.maxTokens = maxTokens;
		this.windowMs = windowMs;
		this.nowMs = nowMs;
		this.logTokens = maxTokens;
		this.logLastRefill = this.nowMs();
	}
	recordExportAttempt() {
		this.exportAttempts += 1;
	}
	recordExportFailure() {
		this.exportFailures += 1;
		this.consecutiveFailures += 1;
	}
	recordExportSkipped(reason) {
		this.exportSkipped[reason] += 1;
	}
	startDegradation(reason) {
		if (this.degradationStartedAt[reason] !== void 0) return;
		this.degradationStartedAt[reason] = this.nowMs();
		this.degradationEvents[reason] += 1;
	}
	endDegradation(reason) {
		const startedAt = this.degradationStartedAt[reason];
		if (startedAt === void 0) return;
		this.degradationDurationMs[reason] += Math.max(0, this.nowMs() - startedAt);
		delete this.degradationStartedAt[reason];
	}
	/** Called by the exporter after a successful batch. */
	recordExportSuccess() {
		this.consecutiveFailures = 0;
		if (this.circuitOpen) {
			this.circuitOpen = false;
			this.endDegradation("circuit_open");
		}
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
		this.circuitOpenedAt = this.nowMs();
		this.startDegradation("circuit_open");
		return true;
	}
	/**
	* Returns true when the circuit breaker cooldown has elapsed and a single
	* probe export should be allowed through. Caller must reset state on the
	* probe result via recordExportSuccess / recordExportFailure.
	*/
	shouldProbe(cooldownMs) {
		if (!this.circuitOpen) return false;
		return this.nowMs() - this.circuitOpenedAt >= cooldownMs;
	}
	/**
	* Returns true if a failure log line should be emitted right now. When the
	* bucket is empty, the call is suppressed and `logsSuppressed` increments.
	*/
	consumeLogToken() {
		const t = this.nowMs();
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
		const capturedAt = this.nowMs();
		const degradationDurationSeconds = zeroByReason();
		const degradationActive = {
			elu_pause: false,
			circuit_open: false
		};
		for (const reason of DEGRADATION_REASONS) {
			const startedAt = this.degradationStartedAt[reason];
			const activeMs = startedAt === void 0 ? 0 : Math.max(0, capturedAt - startedAt);
			degradationDurationSeconds[reason] = (this.degradationDurationMs[reason] + activeMs) / 1e3;
			degradationActive[reason] = startedAt !== void 0;
		}
		return {
			exportAttempts: this.exportAttempts,
			exportFailures: this.exportFailures,
			exportSkipped: { ...this.exportSkipped },
			consecutiveFailures: this.consecutiveFailures,
			circuitOpen: this.circuitOpen,
			logsSuppressed: this.logsSuppressed,
			degradationEvents: { ...this.degradationEvents },
			degradationDurationSeconds,
			degradationActive
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
		if (this.paused === paused) return;
		this.paused = paused;
		if (paused) this.quality.startDegradation("elu_pause");
		else this.quality.endDegradation("elu_pause");
	}
	export(metrics, resultCallback) {
		if (this.paused) {
			this.quality.recordExportSkipped("elu_pause");
			resultCallback({ code: 0 });
			return;
		}
		if (this.quality.snapshot().circuitOpen) {
			if (this.quality.shouldProbe(this.circuitBreakerCooldownMs)) this.probing = true;
			else {
				this.quality.recordExportSkipped("circuit_open");
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
					"service.instance.id": config.serviceInstanceId,
					"process.pid": process.pid,
					"process.creation.time": (/* @__PURE__ */ new Date(Date.now() - process.uptime() * 1e3)).toISOString()
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
		const processCpuTime = meter.createObservableCounter("process.cpu.time", {
			description: "Total CPU seconds consumed by the process.",
			unit: "s"
		});
		const processUptime = meter.createObservableGauge("process.uptime", {
			description: "Seconds since the process started.",
			unit: "s"
		});
		const exports = meter.createObservableGauge("dsh.telemetry.export", {
			description: "Observability exporter quality counters.",
			unit: "{record}"
		});
		const exportAttempts = meter.createObservableCounter("dsh.telemetry.export.attempts", {
			description: "Metric export batches attempted.",
			unit: "{attempt}"
		});
		const exportFailures = meter.createObservableCounter("dsh.telemetry.export.failures", {
			description: "Metric export batches that failed.",
			unit: "{failure}"
		});
		const exportSkipped = meter.createObservableCounter("dsh.telemetry.export.skipped", {
			description: "Metric export batches intentionally skipped by degradation reason.",
			unit: "{batch}"
		});
		const logsSuppressed = meter.createObservableCounter("dsh.telemetry.logs.suppressed", {
			description: "Exporter failure log messages suppressed by throttling.",
			unit: "{log}"
		});
		const consecutiveFailures = meter.createObservableGauge("dsh.telemetry.export.consecutive_failures", {
			description: "Current consecutive metric export failure count.",
			unit: "{failure}"
		});
		const circuitOpen = meter.createObservableGauge("dsh.telemetry.circuit.open", {
			description: "Whether the metric export circuit breaker is open.",
			unit: "1"
		});
		const degradationEvents = meter.createObservableCounter("dsh.telemetry.degradation.events", {
			description: "Telemetry degradation state transitions.",
			unit: "{event}"
		});
		const degradationDuration = meter.createObservableCounter("dsh.telemetry.degradation.duration", {
			description: "Cumulative time spent in telemetry degradation.",
			unit: "s"
		});
		const degraded = meter.createObservableGauge("dsh.telemetry.degraded", {
			description: "Whether telemetry is currently degraded.",
			unit: "1"
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
			result.observe(processCpuTime, values.processCpuUserSeconds, { "cpu.mode": "user" });
			result.observe(processCpuTime, values.processCpuSystemSeconds, { "cpu.mode": "system" });
			result.observe(processUptime, values.processUptimeSeconds);
			this.profiling?.autoStopOnPressure(values.eventLoopUtilization);
			this.handleEluDegradation(values.eventLoopUtilization, eluPauseThreshold);
			const quality = this.quality.snapshot();
			result.observe(exports, quality.exportAttempts, { outcome: "attempt" });
			result.observe(exports, quality.exportFailures, { outcome: "failure" });
			result.observe(exports, quality.consecutiveFailures, { outcome: "consecutive_failure" });
			result.observe(exports, quality.logsSuppressed, { outcome: "log_suppressed" });
			result.observe(exportAttempts, quality.exportAttempts);
			result.observe(exportFailures, quality.exportFailures);
			result.observe(logsSuppressed, quality.logsSuppressed);
			result.observe(consecutiveFailures, quality.consecutiveFailures);
			result.observe(circuitOpen, quality.circuitOpen ? 1 : 0);
			for (const reason of ["elu_pause", "circuit_open"]) {
				result.observe(exportSkipped, quality.exportSkipped[reason], { reason });
				result.observe(degradationEvents, quality.degradationEvents[reason], { reason });
				result.observe(degradationDuration, quality.degradationDurationSeconds[reason], { reason });
				result.observe(degraded, quality.degradationActive[reason] ? 1 : 0, { reason });
			}
		}, [
			runtime,
			utilization,
			memory,
			activeResources,
			processCpuTime,
			processUptime,
			exports,
			exportAttempts,
			exportFailures,
			exportSkipped,
			logsSuppressed,
			consecutiveFailures,
			circuitOpen,
			degradationEvents,
			degradationDuration,
			degraded
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
