/** Omp-only OutputSink, graphics and settings boundary; loaded with the host adapter. */
import type { HostSettings } from "./omp-host.ts";
import type { GraphicsDecoder, HostOutputSink, OutputBudgets, OutputServices } from "./output.ts";

type HostFunction = (...args: never[]) => unknown;
function exported(module: unknown, name: string): HostFunction {
	const value = typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
	if (typeof value !== "function") throw new Error(`omp-unified-exec: host output service ${name} is unavailable`);
	return value as HostFunction;
}
function number(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`omp-unified-exec: invalid host output budget ${name}`);
	}
	return value;
}

export async function loadOutputServices(root: unknown): Promise<OutputServices> {
	const [graphics, outputMeta, notices, settings, asyncDelivery] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/utils/terminal-graphics"),
		import("@oh-my-pi/pi-coding-agent/tools/output-meta"),
		import("@oh-my-pi/pi-tui/tools/output-meta"),
		import("@oh-my-pi/pi-coding-agent/tools/settings"),
		import("@oh-my-pi/pi-coding-agent/session/async-job-delivery"),
	]);
	const Sink = exported(root, "OutputSink") as unknown as new (options: OutputBudgets & {
		onChunk: (text: string) => void; chunkThrottleMs: number;
	}) => HostOutputSink;
	const Graphics = exported(graphics, "TerminalGraphicsDecoder") as unknown as new () => GraphicsDecoder;
	const head = exported(outputMeta, "resolveOutputSinkHeadBytes") as (settings: HostSettings) => unknown;
	const columns = exported(outputMeta, "resolveOutputMaxColumns") as (settings: HostSettings) => unknown;
	const cap = exported(root, "enforceInlineByteCap") as OutputServices["enforceInlineByteCap"];
	const artifactNotice = exported(notices, "formatArtifactErrorNotice") as OutputServices["formatArtifactErrorNotice"];
	const threshold = settings.cfgToolsArtifactSpillThreshold;
	if (typeof threshold !== "object" || threshold === null || !("get" in threshold) || typeof threshold.get !== "function") {
		throw new Error("omp-unified-exec: host lacks cfgToolsArtifactSpillThreshold.get()");
	}
	const getThreshold = threshold.get;
	const asyncInlineMaxChars = number(asyncDelivery.ASYNC_INLINE_RESULT_MAX_CHARS, "ASYNC_INLINE_RESULT_MAX_CHARS");
	if (!Number.isInteger(asyncInlineMaxChars) || asyncInlineMaxChars <= 0) {
		throw new Error("omp-unified-exec: invalid host async inline boundary");
	}
	return {
		createSink: (budgets, onChunk) => new Sink({ ...budgets, onChunk, chunkThrottleMs: 0 }),
		createGraphicsDecoder: () => new Graphics(),
		budgets: (s) => ({
			spillThreshold: number(getThreshold.call(threshold, s), "tools.artifactSpillThreshold") * 1024,
			headBytes: number(head(s), "headBytes"),
			maxColumns: number(columns(s), "maxColumns"),
		}),
		enforceInlineByteCap: cap,
		formatArtifactErrorNotice: artifactNotice,
		asyncInlineMaxChars,
	};
}
