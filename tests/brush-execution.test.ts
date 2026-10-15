// BrushExecution and BrushShells against a scripted native shell: the
// deadline backstop (#28 acceptance row 24), shell leases, stdin and the
// termination primitive (#27 C2).
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BrushExecution, BrushShells, type BrushExecutionStart } from "../fork-features/brush/execution.ts";
import type {
	NativeShell,
	NativeShellModule,
	NativeShellRunOptions,
	NativeShellRunResult,
	NativeShellStdin,
} from "../fork-features/brush/native.ts";

/** How a fake run behaves once started. */
type Script = "hang" | "until-abort" | { exitCode: number };

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
	disposed = 0;
	runs: NativeShellRunOptions[] = [];
	liveJobs = 0;
	signal: AbortSignal | undefined;
	constructor() {
		FakeShell.created.push(this);
	}
	run(options: NativeShellRunOptions, _stdin: NativeShellStdin): Promise<NativeShellRunResult> {
		this.runs.push(options);
		this.signal = options.signal;
		const script = FakeShell.next.shift() ?? { exitCode: 0 };
		if (script === "hang") return new Promise<NativeShellRunResult>(() => {});
		if (script === "until-abort") {
			const { promise, resolve } = Promise.withResolvers<NativeShellRunResult>();
			options.signal?.addEventListener("abort", () => resolve({ cancelled: true, timedOut: false }), { once: true });
			return promise;
		}
		return Promise.resolve({ exitCode: script.exitCode, cancelled: false, timedOut: false });
	}
	async abort(): Promise<void> {
		this.aborts++;
	}
	async dispose(): Promise<void> {
		this.disposed++;
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
	stdins.length = 0;
	return new BrushShells(native);
}

function start(shells: BrushShells, overrides: Partial<BrushExecutionStart> = {}): BrushExecution {
	return BrushExecution.start({
		shells,
		native,
		key: "session-1\nbash",
		shellOptions: {},
		persistent: true,
		command: "true",
		cwd: "/",
		env: {},
		timeoutMs: undefined,
		onOutput: () => {},
		...overrides,
	});
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
			const execution = start(shells, { timeoutMs: 1000 });
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
		const first = start(shells);
		await first.outcome;
		const second = start(shells);
		await second.outcome;
		assert.equal(FakeShell.created.length, 1);
		assert.deepEqual(first.lease, { kind: "persistent", key: "session-1\nbash" });
		assert.equal(FakeShell.created[0]!.runs.length, 2);
		assert.equal(FakeShell.created[0]!.disposed, 0);
	});

	it("runs a concurrent execution on a one-shot shell while the persistent one is busy", async () => {
		const shells = reset("until-abort", { exitCode: 0 });
		const busy = start(shells);
		const concurrent = start(shells);
		assert.equal(busy.lease.kind, "persistent");
		assert.equal(concurrent.lease.kind, "one-shot");
		assert.notEqual(FakeShell.created[0], FakeShell.created[1]);
		await concurrent.outcome;
		await flush();
		assert.equal(FakeShell.created[1]!.disposed, 1, "an idle one-shot shell with no & jobs is released");
		busy.terminate();
		await busy.outcome;
	});

	it("discards a terminated persistent shell and quarantines its key until the run settles", async () => {
		const shells = reset("until-abort", { exitCode: 0 }, { exitCode: 0 });
		const running = start(shells);
		assert.equal(running.terminate(), "cancelled");
		assert.equal(running.terminate(), "cancelled", "idempotent while settling");
		assert.deepEqual(await running.outcome, { kind: "cancelled" });
		assert.equal(running.terminate(), "already-settled");
		assert.equal(FakeShell.created[0]!.disposed, 1, "the persistent shell is discarded");
		const during = start(shells);
		assert.equal(during.lease.kind, "one-shot", "quarantined key runs one-shot");
		await during.outcome;
		await flush();
		const after = start(shells);
		assert.equal(after.lease.kind, "persistent");
		assert.notEqual(FakeShell.created.at(-1), FakeShell.created[0], "a new persistent shell");
		await after.outcome;
	});

	it("retains a one-shot shell while & jobs live and releases it when they exit", async () => {
		const shells = reset("until-abort", { exitCode: 0 });
		const busy = start(shells);
		const oneShot = start(shells);
		const shell = FakeShell.created[1]!;
		shell.liveJobs = 1;
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
		await start(shells).outcome;
		shells.retireOtherSessions("session-2");
		await flush();
		assert.equal(FakeShell.created[0]!.disposed, 1, "idle old shell without & jobs is released");
		await start(shells).outcome;
		assert.equal(FakeShell.created.length, 2, "the old key gets a new shell");
	});
});

describe("BrushExecution stdin", () => {
	it("writes while running, reports not-running after the execution ended, and closes stdin once", async () => {
		const shells = reset("until-abort");
		const execution = start(shells);
		assert.deepEqual(await execution.writeStdin(new Uint8Array([104, 105])), { kind: "written" });
		execution.terminate();
		await execution.outcome;
		assert.deepEqual(await execution.writeStdin(new Uint8Array([33])), { kind: "not-running" });
		assert.equal(stdins[0]!.written.length, 1);
		assert.equal(stdins[0]!.closes, 1);
	});
});
