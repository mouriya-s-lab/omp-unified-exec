/** C6 adapter for the bound session's actual AsyncJobManager.
 * API source: can1357/oh-my-pi@c2cb79e, packages/coding-agent/src/async/job-manager.ts.
 * The manager alone owns admission, foreground visibility, consumption and delivery.
 */
import type { ProcessResultDetails } from "../../src/tool-result.ts";

export type HostJobState = "running" | "completed" | "failed" | "cancelled";
export interface HostJobFrame {
	readonly state: HostJobState;
	readonly jobId: string;
	readonly type: "bash";
}

export interface HostJobProgress extends Partial<ProcessResultDetails> {
	/** Host job snapshots use camelCase; model/session results retain exit_code. */
	readonly exitCode?: number;
}
export interface HostJobRunContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly reportProgress: (text: string, details?: HostJobProgress) => Promise<void>;
}
export interface HostJobRow {
	readonly id: string;
	readonly promise: Promise<void>;
	readonly status: HostJobState;
	readonly endTime?: number;
	readonly foreground?: true;
}
export interface HostJobManager {
	readonly atCapacity: boolean;
	register(label: string, run: (context: HostJobRunContext) => Promise<string>, options: {
		readonly ownerId: string;
		readonly foreground: true;
		readonly process: { readonly command: string; readonly cwd: string; readonly pids: () => readonly number[] };
	}): string;
	getJob(id: string): HostJobRow | undefined;
	cancel(id: string): boolean;
	backgroundJob(id: string): boolean;
	releaseForegroundJob(id: string): void;
	isJobResultConsumed(id: string): boolean;
	consumeJobResults(ids: string[]): number;
}
export type Delivery =
	| { readonly kind: "coordinator" }
	| {
		readonly kind: "host-job";
		readonly manager: HostJobManager;
		readonly jobId: string;
		readonly jobPromise: Promise<void>;
		readonly signal: AbortSignal;
		readonly reportProgress: HostJobRunContext["reportProgress"];
		/** Settles the single callback relay. It is not a delivery receipt. */
		readonly resolve: (text: string) => void;
		readonly reject: (error: unknown) => void;
	};

function property(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
function method(value: unknown, key: string): (...args: unknown[]) => unknown {
	const fn = property(value, key);
	if (typeof fn !== "function") throw new Error(`omp-unified-exec: AsyncJobManager lacks ${key}()`);
	return (...args) => fn.call(value, ...args);
}
function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`omp-unified-exec: AsyncJobManager ${label} is not boolean`);
	return value;
}

/** Parse capabilities, preserving the real manager and returned job object identities. */
export function hostJobManager(value: unknown): HostJobManager | undefined {
	if (value === undefined || value === null) return undefined;
	const register = method(value, "register");
	const getJob = method(value, "getJob");
	const cancel = method(value, "cancel");
	const background = method(value, "backgroundJob");
	const release = method(value, "releaseForegroundJob");
	const consumed = method(value, "isJobResultConsumed");
	const consume = method(value, "consumeJobResults");
	return {
		get atCapacity() { return boolean(property(value, "atCapacity"), "atCapacity"); },
		register: (label, run, options) => {
			const id = register("bash", label, (context: unknown) => {
				const jobId = property(context, "jobId");
				const signal = property(context, "signal");
				const reportProgress = method(context, "reportProgress");
				if (typeof jobId !== "string" || !(signal instanceof AbortSignal)) {
					return Promise.reject(new Error("omp-unified-exec: malformed host job run context"));
				}
				return run({ jobId, signal, reportProgress: async (text, details) => { await reportProgress(text, details); } });
			}, options);
			if (typeof id !== "string") throw new Error("omp-unified-exec: AsyncJobManager returned no job id");
			return id;
		},
		getJob: (id) => {
			const row = getJob(id);
			if (row === undefined) return undefined;
			const status = property(row, "status");
			if (property(row, "id") !== id || !(property(row, "promise") instanceof Promise) ||
				(status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled")) {
				throw new Error("omp-unified-exec: AsyncJobManager returned a malformed job");
			}
			return row as HostJobRow;
		},
		cancel: (id) => boolean(cancel(id), "cancel()"),
		backgroundJob: (id) => boolean(background(id), "backgroundJob()"),
		releaseForegroundJob: (id) => { release(id); },
		isJobResultConsumed: (id) => boolean(consumed(id), "isJobResultConsumed()"),
		consumeJobResults: (ids) => {
			const count = consume(ids);
			if (typeof count !== "number") throw new Error("omp-unified-exec: AsyncJobManager returned an invalid consume count");
			return count;
		},
	};
}

/** Register first; no preparation or native work occurs inside the callback. */
export function registerHostJob(
	manager: HostJobManager, ownerId: string, command: string, cwd: string, pids: () => readonly number[],
): Extract<Delivery, { readonly kind: "host-job" }> {
	const relay = Promise.withResolvers<string>();
	const capture: { context: HostJobRunContext | undefined } = { context: undefined };
	const jobId = manager.register(command.slice(0, 120), (context) => {
		capture.context = context;
		return relay.promise;
	}, { ownerId, foreground: true, process: { command, cwd, pids } });
	try {
		const context = capture.context;
		const job = manager.getJob(jobId);
		if (!context || context.jobId !== jobId || !job) {
			throw new Error("omp-unified-exec: host job registration did not synchronously expose its context and row");
		}
		return {
			kind: "host-job", manager, jobId, jobPromise: job.promise,
			signal: context.signal, reportProgress: context.reportProgress,
			resolve: relay.resolve, reject: relay.reject,
		};
	} catch (error) {
		relay.reject(error);
		void relay.promise.catch(() => undefined);
		manager.cancel(jobId);
		manager.releaseForegroundJob(jobId);
		throw error;
	}
}

export type TerminalDelivery = "pending" | "delivered" | "terminated";
/** Query only after the host run settled; check/consume callers must not await between these operations. */
export function terminalDelivery(delivery: Extract<Delivery, { readonly kind: "host-job" }>, terminated: boolean): TerminalDelivery {
	if (terminated || delivery.signal.aborted) return "terminated";
	return delivery.manager.getJob(delivery.jobId) === undefined || delivery.manager.isJobResultConsumed(delivery.jobId)
		? "delivered" : "pending";
}
