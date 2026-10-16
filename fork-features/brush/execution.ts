/**
 * Brush executions and the shells they lease (#27 contract C2;
 * fork-features/README.md, "Embedded brush shell").
 *
 * A Brush session has exactly one {@link BrushExecution}: its shell lease, its
 * stdin, its outcome and its single termination primitive. Shells follow
 * upstream `executeBash` (can1357/oh-my-pi@c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * `packages/coding-agent/src/exec/bash-executor.ts`): an execution the host
 * would run directly uses its session's persistent shell, so `export`, aliases
 * and functions carry over; a busy or quarantined key runs on a one-shot
 * shell; a timed-out, cancelled or failed persistent shell is discarded and
 * its key quarantined until that run and its abort settle (at most 30 s).
 * Shells whose execution ended while `&` jobs still run are retained until
 * the jobs exit (upstream `retainShellWithLiveBackgroundJobs`). Unlike
 * upstream's process-global tables, the shells belong to one plugin
 * activation and are disposed when it shuts down.
 */
import type { NativeFilesystem, NativeShell, NativeShellModule, NativeShellOptions, NativeShellRunResult, NativeShellStdin } from "./native.ts";
import type { Delivery } from "./jobs.ts";

/** How often a retained shell re-reads its live background job count (upstream `RETAIN_REAP_INTERVAL_MS`). */
const RETAIN_REAP_INTERVAL_MS = 5_000;
/** The JS backstop runs this long past the native deadline (upstream `NATIVE_TIMEOUT_FALLBACK_GRACE_MS`). */
export const NATIVE_TIMEOUT_FALLBACK_GRACE_MS = 5_000;
/** Upper bound on a quarantine (upstream `QUARANTINE_CLEANUP_TIMEOUT_MS`). */
const QUARANTINE_CLEANUP_TIMEOUT_MS = 30_000;

export type ShellLease = { readonly kind: "persistent"; readonly key: string } | { readonly kind: "one-shot" };

/** How an execution ended. Cancellation is the termination primitive's doing; timeouts are not. */
export type BrushOutcome =
	| { readonly kind: "exited"; readonly exitCode: number }
	| { readonly kind: "timed-out"; readonly notice: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly message: string };

/** Result of {@link BrushExecution.terminate}. */
export type TerminateResult = "cancelled" | "already-settled";

/** Result of {@link BrushExecution.writeStdin}. */
export type StdinWrite =
	| { readonly kind: "written" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "not-running" }
	| { readonly kind: "refused"; readonly reason: string };

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms).unref?.();
	return promise;
}

/**
 * The persistent and retained shells of one plugin activation, keyed like
 * upstream's `shellSessions` (`buildSessionKey`).
 */
export class BrushShells {
	readonly #native: NativeShellModule;
	readonly #persistent = new Map<string, NativeShell>();
	readonly #inUse = new Set<string>();
	readonly #quarantined = new Map<string, Promise<unknown>>();
	/** Persistent shells removed from the table while a run was on them; released when it ends. */
	readonly #detached = new Set<NativeShell>();
	readonly #retained = new Map<NativeShell, NodeJS.Timeout>();
	#disposed = false;

	constructor(native: NativeShellModule) {
		this.#native = native;
	}

	/** Lease a shell for one execution: the key's persistent shell when free, else a one-shot shell. */
	lease(key: string, options: NativeShellOptions, persistent: boolean): { shell: NativeShell; lease: ShellLease } {
		if (this.#disposed) throw new Error("the plugin is shutting down");
		if (!persistent || this.#inUse.has(key) || this.#quarantined.has(key)) {
			return { shell: new this.#native.Shell(options), lease: { kind: "one-shot" } };
		}
		let shell = this.#persistent.get(key);
		if (!shell) {
			shell = new this.#native.Shell(options);
			this.#persistent.set(key, shell);
		}
		this.#inUse.add(key);
		return { shell, lease: { kind: "persistent", key } };
	}

	/**
	 * The execution on `shell` ended. A normal end keeps a persistent shell in
	 * its table; a timeout, cancellation or failure discards it and
	 * quarantines its key until `settled` (the run and its abort) resolves.
	 * One-shot and detached shells are released or retained by their `&` jobs.
	 */
	settle(shell: NativeShell, lease: ShellLease, normal: boolean, settled: Promise<unknown>): void {
		if (this.#disposed) {
			// Ended after shutdown disposed the tables: nothing may outlive the activation.
			void shell.dispose().catch(() => undefined);
			return;
		}
		switch (lease.kind) {
			case "persistent": {
				this.#inUse.delete(lease.key);
				const detached = this.#detached.delete(shell);
				if (normal) {
					if (detached) void this.#releaseOrRetain(shell);
					return;
				}
				if (this.#persistent.get(lease.key) === shell) this.#persistent.delete(lease.key);
				this.#quarantine(lease.key, Promise.allSettled([settled, shell.dispose()]));
				return;
			}
			case "one-shot":
				if (normal) void this.#releaseOrRetain(shell);
				else void shell.dispose().catch(() => undefined);
				return;
		}
	}

	/**
	 * The session id changed (`/new`, resume, fork): persistent shells keyed
	 * by another session id leave the table. Idle ones are released or
	 * retained now; busy ones when their execution ends.
	 */
	retireOtherSessions(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const [key, shell] of this.#persistent) {
			if (key.startsWith(prefix)) continue;
			this.#persistent.delete(key);
			if (this.#inUse.has(key)) this.#detached.add(shell);
			else void this.#releaseOrRetain(shell);
		}
	}

	/** Plugin shutdown: refuse new leases and dispose every persistent and retained shell (their `&` jobs end). */
	disposeAll(): Promise<unknown> {
		this.#disposed = true;
		const shells = new Set<NativeShell>([...this.#persistent.values(), ...this.#detached, ...this.#retained.keys()]);
		for (const timer of this.#retained.values()) clearInterval(timer);
		this.#persistent.clear();
		this.#detached.clear();
		this.#retained.clear();
		return Promise.allSettled([...shells].map((shell) => shell.dispose()));
	}

	#quarantine(key: string, settled: Promise<unknown>): void {
		const cleanup = Promise.race([settled, sleep(QUARANTINE_CLEANUP_TIMEOUT_MS)]);
		this.#quarantined.set(key, cleanup);
		void cleanup.finally(() => {
			if (this.#quarantined.get(key) === cleanup) this.#quarantined.delete(key);
		});
	}

	/** Upstream `retainShellWithLiveBackgroundJobs`, with release made explicit (`dispose`). */
	async #releaseOrRetain(shell: NativeShell): Promise<void> {
		let live = 0;
		try {
			live = await shell.liveBackgroundJobCount();
		} catch {
			live = 0;
		}
		if (live <= 0 || this.#disposed) {
			await shell.dispose().catch(() => undefined);
			return;
		}
		const timer = setInterval(() => {
			void shell
				.liveBackgroundJobCount()
				.catch(() => 0)
				.then((remaining) => {
					if (remaining > 0 || this.#retained.get(shell) !== timer) return;
					clearInterval(timer);
					this.#retained.delete(shell);
					void shell.dispose().catch(() => undefined);
				});
		}, RETAIN_REAP_INTERVAL_MS);
		timer.unref?.();
		this.#retained.set(shell, timer);
	}
}

export interface PreparedBrushRun {
	readonly key: string;
	readonly shellOptions: NativeShellOptions;
	readonly command: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
}

export interface BrushExecutionStart {
	readonly shells: BrushShells;
	readonly native: NativeShellModule;
	readonly persistent: boolean;
	/** Preparation begins only after the owning session has been indexed. */
	readonly prepare: (signal: AbortSignal) => Promise<PreparedBrushRun>;
	readonly timeoutMs: number | undefined;
	readonly filesystem?: (signal: AbortSignal) => NativeFilesystem;
	readonly onOutput: (chunk: string) => void;
}

/** Upstream's direct-execution lease rule, after delivery/admission is fixed. */
export function persistentLease(delivery: Delivery, autoBackground: boolean, asyncRequested: boolean): boolean {
	return !asyncRequested && (!autoBackground || delivery.kind === "coordinator");
}

type ExecutionPhase =
	| { readonly kind: "pending" }
	| { readonly kind: "preparing" }
	| { readonly kind: "running"; readonly shell: NativeShell; readonly stdin: NativeShellStdin }
	| { readonly kind: "ended"; readonly outcome: BrushOutcome };

/** One Brush session's execution: lease, stdin, outcome and the termination primitive. */
export class BrushExecution {
	readonly #start: BrushExecutionStart;
	readonly #abort = new AbortController();
	readonly #completion = Promise.withResolvers<BrushOutcome>();
	readonly #ready = Promise.withResolvers<void>();
	readonly outcome = this.#completion.promise;
	#phase: ExecutionPhase = { kind: "pending" };
	#lease: ShellLease | undefined;

	private constructor(start: BrushExecutionStart) { this.#start = start; }

	static create(start: BrushExecutionStart): BrushExecution { return new BrushExecution(start); }

	/** Called once, synchronously after the outer HostJob and session index exist. */
	begin(): void {
		if (this.#phase.kind !== "pending") throw new Error("Brush execution was already started");
		this.#phase = { kind: "preparing" };
		void this.#run().then((outcome) => {
			if (outcome.kind !== "exited") this.#abort.abort();
			this.#phase = { kind: "ended", outcome };
			this.#ready.resolve();
			this.#completion.resolve(outcome);
		});
	}

	get lease(): ShellLease | undefined { return this.#lease; }
	get settled(): boolean { return this.#phase.kind === "ended"; }
	get terminated(): boolean {
		return this.#phase.kind === "ended" ? this.#phase.outcome.kind === "cancelled" : this.#abort.signal.aborted;
	}

	pids(): number[] { return this.#phase.kind === "running" ? this.#phase.shell.pids() : []; }

	async #run(): Promise<BrushOutcome> {
		const start = this.#start;
		try {
			const aborted = Promise.withResolvers<undefined>();
			const onAbort = () => aborted.resolve(undefined);
			this.#abort.signal.addEventListener("abort", onAbort, { once: true });
			let prepared: PreparedBrushRun | undefined;
			try {
				if (this.#abort.signal.aborted) return { kind: "cancelled" };
				prepared = await Promise.race([start.prepare(this.#abort.signal), aborted.promise]);
			} finally {
				this.#abort.signal.removeEventListener("abort", onAbort);
			}
			if (!prepared || this.#abort.signal.aborted) return { kind: "cancelled" };
			const filesystem = start.filesystem?.(this.#abort.signal);
			if (this.#abort.signal.aborted) return { kind: "cancelled" };
			const { shell, lease } = start.shells.lease(prepared.key, prepared.shellOptions, start.persistent);
			this.#lease = lease;
			let stdin: NativeShellStdin;
			try { stdin = new start.native.ShellStdin(); }
			catch (error) {
				start.shells.settle(shell, lease, false, Promise.resolve());
				throw error;
			}
			this.#phase = { kind: "running", shell, stdin };
			this.#ready.resolve();
			let run: Promise<NativeShellRunResult>;
			try {
				run = shell.run({
					command: prepared.command, cwd: prepared.cwd, env: prepared.env,
					timeoutMs: start.timeoutMs, signal: this.#abort.signal, filesystem,
				}, stdin, (error, chunk) => { if (!error) start.onOutput(chunk); });
			} catch (error) {
				stdin.close();
				start.shells.settle(shell, lease, false, Promise.resolve());
				throw error;
			}
			const outcome = await this.#race(run, start.timeoutMs, shell);
			if (outcome.kind !== "exited") this.#abort.abort();
			stdin.close();
			start.shells.settle(shell, lease, outcome.kind === "exited", run.catch(() => undefined));
			return outcome;
		} catch (error) {
			return this.#abort.signal.aborted ? { kind: "cancelled" }
				: { kind: "failed", message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Preparation has no input queue: wait for this execution's actual stdin. */
	async writeStdin(data: Uint8Array, signal?: AbortSignal): Promise<StdinWrite> {
		if (signal?.aborted) return { kind: "cancelled" };
		const cancelled = Promise.withResolvers<void>();
		const onCancel = () => cancelled.resolve();
		signal?.addEventListener("abort", onCancel, { once: true });
		try { await Promise.race([this.#ready.promise, cancelled.promise]); }
		finally { signal?.removeEventListener("abort", onCancel); }
		if (signal?.aborted) return { kind: "cancelled" };
		const phase = this.#phase;
		if (phase.kind !== "running") return { kind: "not-running" };
		const writeAbort = signal ? new AbortController() : undefined;
		const onAbort = () => writeAbort?.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await phase.stdin.write(data, writeAbort?.signal);
			return { kind: "written" };
		} catch (error) {
			if (this.settled) return { kind: "not-running" };
			if (signal?.aborted) return { kind: "cancelled" };
			return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
		} finally { signal?.removeEventListener("abort", onAbort); }
	}

	/** The one cancellation primitive, including during preparation. */
	terminate(): TerminateResult {
		if (this.#phase.kind === "ended") return "already-settled";
		if (!this.#abort.signal.aborted) {
			this.#abort.abort();
			if (this.#phase.kind === "running") void this.#phase.shell.abort().catch(() => undefined);
		}
		return "cancelled";
	}

	async #race(run: Promise<NativeShellRunResult>, timeoutMs: number | undefined, shell: NativeShell): Promise<BrushOutcome> {
		const settled = run.then(
			(result): BrushOutcome => {
				if (result.timedOut) {
					return { kind: "timed-out", notice: `Command timed out after ${Math.round((timeoutMs ?? 0) / 1000)} seconds` };
				}
				if (result.cancelled) return { kind: "cancelled" };
				if (result.exitCode === undefined) return { kind: "failed", message: "Command failed: missing exit status" };
				return { kind: "exited", exitCode: result.exitCode };
			},
			(err: unknown): BrushOutcome => ({ kind: "failed", message: err instanceof Error ? err.message : String(err) }),
		);
		if (timeoutMs === undefined) return settled;
		// The native shell owns the deadline; this backstop only fires when the
		// native run has not returned 5 s after it (upstream executeBash, whose
		// deadline is at least one second).
		const deadlineMs = Math.max(1_000, timeoutMs);
		const { promise: backstop, resolve } = Promise.withResolvers<BrushOutcome>();
		const timer = setTimeout(() => {
			this.#abort.abort();
			void shell.abort().catch(() => undefined);
			const seconds = Math.round(deadlineMs / 1000);
			resolve({
				kind: "timed-out",
				notice: `Command timed out after ${seconds} seconds; the shell backend did not respond, so any output above may be incomplete`,
			});
		}, deadlineMs + NATIVE_TIMEOUT_FALLBACK_GRACE_MS);
		try {
			return await Promise.race([settled, backstop]);
		} finally {
			clearTimeout(timer);
		}
	}
}
