// BrushExecution and BrushShells against a scripted native shell: the
// deadline backstop (#28 acceptance row 24), shell leases, stdin and the
// termination primitive (#27 C2).
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BrushExecution, BrushShells, type BrushExecutionStart, type PreparedBrushRun } from "../fork-features/brush/execution.ts";
import type {
	NativeShell,
	NativeShellModule,
	NativeShellRunOptions,
	NativeShellRunResult,
	NativeShellStdin,
} from "../fork-features/brush/native.ts";

/** How a fake run behaves once started. */
type Script = "hang" | "until-abort" | { exitCode: number; liveJobs?: number };

class FakeStdin implements NativeShellStdin {
	closes = 0;
	written: Uint8Array[] = [];
	async write(data: Uint8Array): Promise<void> {
		if (this.closes > 0) throw new Error("stdin_closed");
		this.written.push(data);
	}
	close(): void {
		this.closes++;
	}
}

class FakeShell implements NativeShell {
	static created: FakeShell[] = [];
	static next: Script[] = [];
	aborts = 0;
	static nextRun = Promise.withResolvers<void>();
	disposed = 0;
	runs: NativeShellRunOptions[] = [];
	liveJobs = 0;
	inputs: NativeShellStdin[] = [];
	disposeCompletion: Promise<void> | undefined;
	signal: AbortSignal | undefined;
	constructor() {
		FakeShell.created.push(this);
	}
	run(options: NativeShellRunOptions, stdin: NativeShellStdin): Promise<NativeShellRunResult> {
		this.runs.push(options);
		this.inputs.push(stdin);
		FakeShell.nextRun.resolve();
		FakeShell.nextRun = Promise.withResolvers<void>();
		this.signal = options.signal;
		const script = FakeShell.next.shift() ?? { exitCode: 0 };
		if (script === "hang") return new Promise<NativeShellRunResult>(() => {});
		if (script === "until-abort") {
			const { promise, resolve } = Promise.withResolvers<NativeShellRunResult>();
			options.signal?.addEventListener("abort", () => resolve({ cancelled: true, timedOut: false }), { once: true });
			return promise;
		}
		this.liveJobs = script.liveJobs ?? 0;
		return Promise.resolve({ exitCode: script.exitCode, cancelled: false, timedOut: false });
	}
	async abort(): Promise<void> {
		this.aborts++;
	}
	async dispose(): Promise<void> {
		this.disposed++;
		await this.disposeCompletion;
	}
	async liveBackgroundJobCount(): Promise<number> {
		return this.liveJobs;
	}
	pids(): number[] {
		return [];
	}
}

const stdins: FakeStdin[] = [];
const native: NativeShellModule = {
	Shell: FakeShell,
	ShellStdin: class extends FakeStdin {
		constructor() {
			super();
			stdins.push(this);
		}
	},
};

function reset(...scripts: Script[]): BrushShells {
	FakeShell.created = [];
	FakeShell.next = scripts;
	FakeShell.nextRun = Promise.withResolvers<void>();
	stdins.length = 0;
	return new BrushShells(native);
}

function preparedRun(): PreparedBrushRun {
	return {
		key: "session-1\nbash",
		shellOptions: {},
		command: "true",
		cwd: "/",
		env: {},
	};
}

function create(shells: BrushShells, overrides: Partial<BrushExecutionStart> = {}): BrushExecution {
	return BrushExecution.create({
		shells,
		native,
		persistent: true,
		prepare: async () => preparedRun(),
		timeoutMs: undefined,
		onOutput: () => {},
		...overrides,
	});
}

/** Wait for the fake native run, not a fixed number of preparation microtasks. */
async function start(shells: BrushShells, overrides: Partial<BrushExecutionStart> = {}): Promise<BrushExecution> {
	const running = FakeShell.nextRun.promise;
	const execution = create(shells, overrides);
	execution.begin();
	await running;
	return execution;
}

/** Let settled promises and their `finally` handlers run. */
function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("BrushExecution deadline backstop", () => {
	it("ends a native run that never returns 5 s after its deadline, with upstream's notice, and aborts it", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const shells = reset("hang");
			const execution = await start(shells, { timeoutMs: 1000 });
			let outcome: unknown;
			void execution.outcome.then((value) => {
				outcome = value;
			});
			mock.timers.tick(5999);
			await flush();
			assert.equal(outcome, undefined, "still waiting on the native deadline and its 5 s grace");
			const shell = FakeShell.created[0]!;
			assert.equal(shell.aborts, 0);
			mock.timers.tick(1);
			await flush();
			assert.deepEqual(outcome, {
				kind: "timed-out",
				notice: "Command timed out after 1 seconds; the shell backend did not respond, so any output above may be incomplete",
			});
			assert.equal(shell.runs[0]!.timeoutMs, 1000, "the native shell owns the 1 s deadline");
			assert.equal(shell.signal?.aborted, true, "the native run's abort signal fired");
			assert.equal(shell.aborts, 1, "the native shell was aborted");
			assert.equal(stdins[0]!.closes, 1, "stdin closed exactly once");
		} finally {
			mock.timers.reset();
		}
	});
});

describe("BrushShells leases", () => {
	it("reuses the key's persistent shell for consecutive executions", async () => {
		const shells = reset();
		const first = await start(shells);
		await first.outcome;
		const second = await start(shells);
		await second.outcome;
		assert.equal(FakeShell.created.length, 1);
		assert.deepEqual(first.lease, { kind: "persistent", key: "session-1\nbash" });
		assert.equal(FakeShell.created[0]!.runs.length, 2);
		assert.equal(FakeShell.created[0]!.disposed, 0);
	});

	it("runs a concurrent execution on a one-shot shell while the persistent one is busy", async () => {
		const shells = reset("until-abort", { exitCode: 0 });
		const busy = await start(shells);
		const concurrent = await start(shells);
		assert.equal(busy.lease?.kind, "persistent");
		assert.equal(concurrent.lease?.kind, "one-shot");
		assert.notEqual(FakeShell.created[0], FakeShell.created[1]);
		await concurrent.outcome;
		await flush();
		assert.equal(FakeShell.created[1]!.disposed, 1, "an idle one-shot shell with no & jobs is released");
		busy.terminate();
		await busy.outcome;
	});

	it("discards a terminated persistent shell and quarantines its key until disposal completes", async () => {
		const shells = reset("until-abort", { exitCode: 0 }, { exitCode: 0 });
		const running = await start(shells);
		const disposed = Promise.withResolvers<void>();
		FakeShell.created[0]!.disposeCompletion = disposed.promise;
		assert.equal(running.terminate(), "cancelled");
		assert.equal(running.terminate(), "cancelled", "idempotent while settling");
		assert.deepEqual(await running.outcome, { kind: "cancelled" });
		assert.equal(running.terminate(), "already-settled");
		assert.equal(FakeShell.created[0]!.disposed, 1, "the persistent shell is discarded");
		const during = await start(shells);
		assert.equal(during.lease?.kind, "one-shot", "quarantined key runs one-shot while disposal is held");
		await during.outcome;
		disposed.resolve();
		await disposed.promise;
		await flush();
		const after = await start(shells);
		assert.equal(after.lease?.kind, "persistent");
		assert.notEqual(FakeShell.created.at(-1), FakeShell.created[0], "a new persistent shell");
		await after.outcome;
	});

	it("retains a one-shot shell while & jobs live and releases it when they exit", async () => {
		const shells = reset("until-abort", { exitCode: 0, liveJobs: 1 });
		const busy = await start(shells);
		const oneShot = await start(shells);
		const shell = FakeShell.created[1]!;
		await oneShot.outcome;
		await flush();
		assert.equal(shell.disposed, 0, "retained while a & job lives");
		await shells.disposeAll();
		assert.equal(shell.disposed, 1, "shutdown disposes retained shells");
		assert.equal(FakeShell.created[0]!.disposed, 1, "and persistent ones");
		busy.terminate();
		await busy.outcome;
	});

	it("moves another session id's persistent shells out of the table", async () => {
		const shells = reset();
		await (await start(shells)).outcome;
		shells.retireOtherSessions("session-2");
		await flush();
		assert.equal(FakeShell.created[0]!.disposed, 1, "idle old shell without & jobs is released");
		await (await start(shells)).outcome;
		assert.equal(FakeShell.created.length, 2, "the old key gets a new shell");
	});
});

describe("BrushExecution preparation", () => {
	it("settles cancellation without waiting for preparation and never launches its late result", async () => {
		const shells = reset();
		const preparation = Promise.withResolvers<PreparedBrushRun>();
		const entered = Promise.withResolvers<AbortSignal>();
		const execution = create(shells, {
			prepare: (signal) => {
				entered.resolve(signal);
				return preparation.promise;
			},
		});
		assert.equal(FakeShell.created.length, 0, "creation is inert");
		assert.equal(execution.lease, undefined);
		execution.begin();
		const signal = await entered.promise;
		assert.equal(execution.terminate(), "cancelled");
		assert.deepEqual(await execution.outcome, { kind: "cancelled" });
		assert.equal(signal.aborted, true, "preparation receives execution cancellation");
		assert.equal(FakeShell.created.length, 0, "cancellation does not need a native shell");
		assert.equal(stdins.length, 0);
		assert.equal(execution.lease, undefined);

		preparation.resolve(preparedRun());
		await flush();
		assert.equal(FakeShell.created.length, 0, "late preparation cannot launch a native shell");
		assert.equal(stdins.length, 0, "late preparation cannot allocate stdin");
		assert.equal(execution.lease, undefined);
		assert.equal(execution.terminate(), "already-settled");
	});
});

describe("BrushExecution stdin", () => {
	it("writes while running, reports not-running after the execution ended, and closes stdin once", async () => {
		const shells = reset("until-abort");
		const execution = await start(shells);
		assert.deepEqual(await execution.writeStdin(new Uint8Array([104, 105])), { kind: "written" });
		execution.terminate();
		await execution.outcome;
		assert.deepEqual(await execution.writeStdin(new Uint8Array([33])), { kind: "not-running" });
		assert.equal(stdins[0]!.written.length, 1);
		assert.equal(stdins[0]!.closes, 1);
	});

	it("waits for prepared stdin without forwarding a cancelled writer or cancelling the execution", async () => {
		const shells = reset("until-abort");
		const preparation = Promise.withResolvers<PreparedBrushRun>();
		const execution = create(shells, { prepare: () => preparation.promise });
		execution.begin();
		const waitingData = new Uint8Array([104, 105]);
		const waiting = execution.writeStdin(waitingData);
		let waitingSettled = false;
		void waiting.then(() => { waitingSettled = true; });
		const cancelledData = new Uint8Array([88]);
		const writer = new AbortController();
		const cancelled = execution.writeStdin(cancelledData, writer.signal);
		writer.abort();
		assert.deepEqual(await cancelled, { kind: "cancelled" });
		assert.equal(waitingSettled, false, "the uncancelled writer still waits for actual stdin");
		assert.equal(execution.settled, false, "writer cancellation does not end the execution");
		assert.equal(execution.terminated, false, "writer cancellation does not abort preparation");
		assert.equal(FakeShell.created.length, 0);
		assert.equal(stdins.length, 0, "preparation has no native stdin to buffer input into");

		preparation.resolve(preparedRun());
		assert.deepEqual(await waiting, { kind: "written" });
		const stdin = stdins[0]!;
		assert.equal(FakeShell.created[0]!.inputs[0], stdin, "writes use the stdin given to the native run");
		assert.deepEqual(stdin.written, [waitingData], "the cancelled payload was not queued");
		const laterData = new Uint8Array([33]);
		assert.deepEqual(await execution.writeStdin(laterData), { kind: "written" });
		assert.deepEqual(stdin.written, [waitingData, laterData], "later writers use the same live stdin");
		assert.equal(stdin.closes, 0, "cancelling one writer leaves stdin open");
		execution.terminate();
		assert.deepEqual(await execution.outcome, { kind: "cancelled" });
		assert.equal(stdin.closes, 1);
	});
});
