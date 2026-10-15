/**
 * ExecSession — wraps one execution engine with:
 *   - pipe sessions: a head+tail output buffer (drained by polls) and a
 *     rolling tail window (for TUI streaming via onUpdate)
 *   - tty sessions: a TerminalScreen that renders the child's output as a
 *     terminal shows it (observed by polls, snapshotted for TUI streaming)
 *   - state transitions (has_exited / exit_code / signal / failure)
 *   - lifecycle callbacks (onData taps, onExit fan-out)
 *
 * The engine is a real process (`SpawnedChild`: pipes or PTY) or, on omp, an
 * embedded brush shell execution (`BrushExecution`, fork-features/README.md
 * "Embedded brush shell"); output, logs and exit state are handled the same.
 *
 * Mirrors codex's `UnifiedExecProcess` in `unified_exec/process.rs`, simplified
 * to the subset we need for the pi extension.
 */

import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrushExecution, TerminateResult } from "../fork-features/brush/execution.ts";
import { type CollectResult, collectOutputUntilDeadline } from "./collect.ts";
import { HeadTailBuffer } from "./head-tail-buffer.ts";
import { Gate, Notify } from "./notify.ts";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, type SpawnedChild, spawnChild } from "./pty.ts";
import { type StyledScreen, type TerminalAppearance, TerminalScreen, type TerminalSnapshot } from "./terminal-screen.ts";

/** Default per-session output retention. */
export const DEFAULT_HEAD_TAIL_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Default rolling tail window used for TUI streaming (independent of the head+tail buffer). */
export const DEFAULT_STREAM_TAIL_BYTES = 32 * 1024; // 32 KiB

export interface SessionSpawnOptions {
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	tty: boolean;
	cols?: number;
	rows?: number;
	headTailMaxBytes?: number;
	streamTailBytes?: number;
	displayCommand?: string; // human-readable command for list_sessions/UI
	shell?: string; // raw `shell` arg recorded for introspection
	windowsVerbatimArguments?: boolean; // Windows cmd.exe quoting (see shell.ts)
	/** tty only: the background the session's screen is shown on (default dark), answered to OSC 10/11. */
	appearance?: () => TerminalAppearance;
}

/** A Brush session: an embedded brush shell execution instead of a spawned process. */
export interface BrushSessionOptions {
	cwd: string;
	displayCommand: string;
	headTailMaxBytes?: number;
	streamTailBytes?: number;
	/** Start the execution, forwarding its output to `onOutput`. */
	start: (onOutput: (chunk: string) => void) => BrushExecution;
}

/** What a session runs: a spawned process (pipes or PTY) or an embedded brush execution. */
type SessionEngine =
	| { readonly kind: "process"; readonly child: SpawnedChild }
	| { readonly kind: "brush"; readonly execution: BrushExecution };

/** Outcome of writing input to a session. */
export type InputWrite =
	| { readonly kind: "written" }
	/** The session already exited; nothing was written. */
	| { readonly kind: "not_running" }
	/** The process is running but did not take the bytes (its stdin is closed). */
	| { readonly kind: "refused"; readonly reason: string };

export interface SessionState {
	hasExited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failureMessage: string | null;
}

/** What a live (non-consuming) streaming update can show right now. */
export type LiveOutput =
	| { readonly kind: "stream"; readonly bytes: Uint8Array }
	| { readonly kind: "screen"; readonly snapshot: TerminalSnapshot };

export class ExecSession {
	readonly id: number;
	readonly tty: boolean;
	readonly command: string[];
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly pid: number | undefined;
	/** Path to a log file that receives the full stdout+stderr stream. */
	readonly logPath: string;
	private logStream: WriteStream | undefined;

	/** Head+tail buffer drained by each collectOutputUntilDeadline() call (pipe sessions). */
	readonly outputBuffer: HeadTailBuffer;
	/** Rendered terminal for tty sessions; created once the PTY child exists. */
	private screen: TerminalScreen | undefined;
	/** Fired whenever new data arrives in outputBuffer. */
	readonly outputNotify = new Notify();
	/** Closed when the stream is done (all data flushed after exit). */
	readonly outputClosed = new Gate();
	/** Aborts when the process has exited (may still have trailing output). */
	private readonly exitedAc = new AbortController();
	get exited(): AbortSignal {
		return this.exitedAc.signal;
	}

	/** Running tail window for TUI streaming; independent of outputBuffer. */
	private streamTail: Uint8Array[] = [];
	private streamTailBytes = 0;
	private readonly streamTailCap: number;
	private totalOutputBytes = 0;

	private state: SessionState = {
		hasExited: false,
		exitCode: null,
		signal: null,
		failureMessage: null,
	};
	private readonly exitListeners = new Set<(session: ExecSession) => void>();
	private lastUsedAt: number;
	private engine!: SessionEngine;

	private constructor(
		id: number,
		opts: Pick<SessionSpawnOptions, "cwd" | "tty" | "headTailMaxBytes" | "streamTailBytes"> & {
			command: string[];
			displayCommand: string;
		},
	) {
		this.id = id;
		this.command = opts.command;
		this.displayCommand = opts.displayCommand;
		this.cwd = opts.cwd;
		this.tty = opts.tty;
		this.startedAt = Date.now();
		this.lastUsedAt = this.startedAt;
		this.outputBuffer = new HeadTailBuffer(opts.headTailMaxBytes ?? DEFAULT_HEAD_TAIL_MAX_BYTES);
		this.streamTailCap = opts.streamTailBytes ?? DEFAULT_STREAM_TAIL_BYTES;
		this.pid = undefined; // set in `start`
		this.logPath = join(tmpdir(), `pi-unified-exec-${id}-${randomBytes(4).toString("hex")}.log`);
	}

	static spawn(id: number, opts: SessionSpawnOptions): ExecSession {
		const self = new ExecSession(id, { ...opts, displayCommand: opts.displayCommand ?? opts.command.join(" ") });
		if (!self.openLog()) return self;

		const cols = opts.cols ?? DEFAULT_PTY_COLS;
		const rows = opts.rows ?? DEFAULT_PTY_ROWS;
		let child: SpawnedChild;
		try {
			child = spawnChild({
				command: opts.command,
				cwd: opts.cwd,
				env: opts.env,
				tty: opts.tty,
				cols,
				rows,
				windowsVerbatimArguments: opts.windowsVerbatimArguments,
			});
		} catch (err: any) {
			self.markFailure(err?.message ?? String(err));
			self.logStream?.end();
			self.logStream = undefined;
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}
		self.engine = { kind: "process", child };

		// child's actual pid
		Object.defineProperty(self, "pid", { value: child.pid, enumerable: true });

		// A real terminal answers queries (cursor position, device attributes);
		// a child that waits for the answer would otherwise stall.
		if (opts.tty) self.screen = new TerminalScreen(cols, rows, (reply) => void self.write(reply), opts.appearance);

		child.onData((chunk) => self.receive(chunk));
		child.onExit((exitCode, signal, failureMessage) => self.finish(exitCode, signal, failureMessage ?? null));
		return self;
	}

	/**
	 * A Brush session: `opts.start` starts the embedded shell execution, whose
	 * output and outcome drive this session exactly like a pipe child's.
	 * Brush sessions have no pid (their shell runs in-process).
	 */
	static brush(id: number, opts: BrushSessionOptions): ExecSession {
		const self = new ExecSession(id, { ...opts, command: [opts.displayCommand], tty: false });
		if (!self.openLog()) return self;
		const encoder = new TextEncoder();
		let execution: BrushExecution;
		try {
			execution = opts.start((chunk) => self.receive(encoder.encode(chunk)));
		} catch (err) {
			self.markFailure(err instanceof Error ? err.message : String(err));
			self.logStream?.end();
			self.logStream = undefined;
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}
		self.engine = { kind: "brush", execution };
		void execution.outcome.then((outcome) => {
			switch (outcome.kind) {
				case "exited":
					return self.finish(outcome.exitCode, null, null);
				case "timed-out":
					return self.finish(null, null, outcome.notice);
				case "cancelled":
					return self.finish(null, null, "the command was terminated");
				case "failed":
					return self.finish(null, null, outcome.message);
			}
		});
		return self;
	}

	/**
	 * Touch-create the log file synchronously so it exists on disk from t=0
	 * even before the child writes anything (and before the lazy stream opens
	 * the fd on its first buffered write), then open a stream in append mode
	 * for the actual writes. False when the log cannot be created: the session
	 * is then already failed and exited.
	 */
	private openLog(): boolean {
		try {
			closeSync(openSync(this.logPath, "w"));
			this.logStream = createWriteStream(this.logPath, { flags: "a" });
			this.logStream.on("error", (err) => {
				// Log-stream error (disk full, permissions, etc.). The child is
				// still running: record the failure and stop mirroring writes, but
				// do NOT mark the session exited — that would make it unkillable
				// (kill() no-ops once hasExited) and orphan the process.
				this.recordFailure(`log stream error: ${err?.message ?? err}`);
				this.logStream = undefined;
			});
			return true;
		} catch (err: any) {
			this.markFailure(`failed to open log file ${this.logPath}: ${err?.message ?? err}`);
			this.exitedAc.abort();
			this.outputClosed.close();
			return false;
		}
	}

	/** One chunk of the engine's combined stdout+stderr. */
	private receive(chunk: Uint8Array): void {
		this.totalOutputBytes += chunk.length;
		if (this.screen) {
			this.screen.write(chunk);
		} else {
			this.outputBuffer.pushChunk(chunk);
			this.appendStreamTail(chunk);
		}
		// Mirror every byte to the log file. Errors are handled by the
		// 'error' listener on the stream, which nulls `logStream` out.
		this.logStream?.write(Buffer.from(chunk));
		this.outputNotify.notifyAll();
	}

	/** The engine ended: record the exit, wake waiters, then flush the log and close the output gate. */
	private finish(exitCode: number | null, signal: NodeJS.Signals | null, failureMessage: string | null): void {
		this.state = {
			hasExited: true,
			exitCode,
			signal,
			failureMessage: this.state.failureMessage ?? failureMessage,
		};
		this.exitedAc.abort();
		this.notifyExitListeners();
		// Fire a notify so any parked waiters wake up and see the exit.
		this.outputNotify.notifyAll();
		// A short tick later, flush the log stream to disk, then close the
		// output gate. The tick lets any pending data-handler chunks land
		// in the buffer+log before we declare the session fully done.
		setImmediate(() => {
			this.outputNotify.notifyAll();
			const stream = this.logStream;
			this.logStream = undefined;
			if (!stream) {
				this.outputClosed.close();
				this.outputNotify.notifyAll();
				return;
			}
			const finalize = () => {
				this.outputClosed.close();
				this.outputNotify.notifyAll();
			};
			// Wait for the stream to finish flushing before declaring
			// `outputClosed` so consumers that await the drain see a
			// fully-flushed log file on disk.
			stream.once("close", finalize);
			stream.end();
		});
	}

	private appendStreamTail(chunk: Uint8Array): void {
		// A single chunk larger than the whole window replaces it outright —
		// the trim loop below never shrinks a lone chunk, and shipping a
		// multi-megabyte "tail" to the TUI every tick defeats the cap.
		if (chunk.length >= this.streamTailCap) {
			this.streamTail = [chunk.subarray(chunk.length - this.streamTailCap)];
			this.streamTailBytes = this.streamTailCap;
			return;
		}
		this.streamTail.push(chunk);
		this.streamTailBytes += chunk.length;
		while (this.streamTailBytes > this.streamTailCap && this.streamTail.length > 1) {
			const front = this.streamTail[0]!;
			if (this.streamTailBytes - front.length >= this.streamTailCap) {
				this.streamTail.shift();
				this.streamTailBytes -= front.length;
			} else {
				// Trim the front of the leading chunk just enough.
				const drop = this.streamTailBytes - this.streamTailCap;
				this.streamTail[0] = front.subarray(drop);
				this.streamTailBytes -= drop;
				break;
			}
		}
	}

	/**
	 * Record a non-fatal failure (e.g. log mirroring broke) WITHOUT marking the
	 * session exited. The child keeps running and stays controllable.
	 */
	private recordFailure(message: string): void {
		this.state = {
			...this.state,
			failureMessage: this.state.failureMessage ?? message,
		};
	}

	/** Mark the session as failed-and-exited. Only for spawn-time failures. */
	private markFailure(message: string): void {
		this.state = {
			hasExited: true,
			exitCode: this.state.exitCode,
			signal: this.state.signal,
			failureMessage: message,
		};
		this.notifyExitListeners();
	}

	private notifyExitListeners(): void {
		for (const listener of this.exitListeners) {
			try {
				listener(this);
			} catch {
				// ignore listener failures
			}
		}
	}

	/** Register a listener fired when this session exits. */
	onExit(listener: (session: ExecSession) => void): () => void {
		this.exitListeners.add(listener);
		if (this.hasExited) {
			queueMicrotask(() => {
				if (this.exitListeners.has(listener)) listener(this);
			});
		}
		return () => this.exitListeners.delete(listener);
	}

	/** What a streaming update shows now, without consuming anything. */
	liveOutput(): LiveOutput {
		if (this.screen) return { kind: "screen", snapshot: this.screen.snapshot() };
		let total = 0;
		for (const c of this.streamTail) total += c.length;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const c of this.streamTail) {
			out.set(c, offset);
			offset += c.length;
		}
		return { kind: "stream", bytes: out };
	}

	/** The tty screen with styling for live display (undefined for pipe sessions); consumes nothing. */
	styledScreen(): StyledScreen | undefined {
		return this.screen?.styledScreen();
	}

	/** Call `listener` whenever new tty output has been parsed into the screen; returns the unsubscribe. */
	onScreenChange(listener: () => void): () => void {
		return this.screen?.onChange(listener) ?? (() => {});
	}

	/**
	 * Wait until `deadlineMs` (or exit/abort), then consume this session's
	 * output: pipe sessions drain their retained bytes; tty sessions observe
	 * their terminal screen (see terminal-screen.ts).
	 */
	async collect(opts: { deadlineMs: number; externalAbort?: AbortSignal; postExitCloseWaitMs?: number }): Promise<CollectResult> {
		const drained = await collectOutputUntilDeadline({
			buffer: this.outputBuffer,
			outputNotify: this.outputNotify,
			outputClosed: this.outputClosed,
			exited: this.exited,
			deadlineMs: opts.deadlineMs,
			externalAbort: opts.externalAbort,
			postExitCloseWaitMs: opts.postExitCloseWaitMs,
		});
		if (!this.screen) return drained;
		return { kind: "screen", observation: await this.screen.observe() };
	}

	/** Release the terminal emulator once the session leaves ownership (removed, evicted, never registered). */
	release(): Promise<void> {
		return this.screen?.release() ?? Promise.resolve();
	}

	/**
	 * Write bytes to a process session's stdin or PTY (terminal query replies
	 * included). Returns true on success, false if closed/dead. Brush sessions
	 * take input through {@link writeInput} only.
	 */
	write(data: Uint8Array): boolean {
		if (this.state.hasExited) return false;
		switch (this.engine.kind) {
			case "process":
				return this.engine.child.write(data);
			case "brush":
				return false;
		}
	}

	/**
	 * Write model input. A Brush execution resolves once its stdin pipe has
	 * accepted every byte (no buffering beyond the pipe); a process takes the
	 * bytes synchronously as before.
	 */
	async writeInput(data: Uint8Array): Promise<InputWrite> {
		if (this.state.hasExited) return { kind: "not_running" };
		switch (this.engine.kind) {
			case "process":
				if (this.engine.child.write(data)) return { kind: "written" };
				return this.state.hasExited
					? { kind: "not_running" }
					: { kind: "refused", reason: "the child closed its stdin" };
			case "brush": {
				const written = await this.engine.execution.writeStdin(data);
				switch (written.kind) {
					case "written":
						return written;
					case "not-running":
						return { kind: "not_running" };
					case "refused":
						return { kind: "refused", reason: `the command did not take the bytes (${written.reason})` };
				}
			}
		}
	}

	/**
	 * Stop the session. A process gets `signal`; a Brush execution ignores it
	 * and is cancelled through its termination primitive. No-op if already
	 * exited (the primitive is never called for an ended execution).
	 */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.state.hasExited) return;
		switch (this.engine.kind) {
			case "process":
				this.engine.child.kill(signal);
				return;
			case "brush":
				this.engine.execution.terminate();
				return;
		}
	}

	/** The Brush execution's termination primitive; undefined for process sessions. */
	terminateBrush(): TerminateResult | undefined {
		return this.engine?.kind === "brush" ? this.engine.execution.terminate() : undefined;
	}

	/** Whether this session runs on the embedded brush shell. */
	get isBrush(): boolean {
		return this.engine?.kind === "brush";
	}

	/** Brush: pids of the running execution's processes (none once it ended); process sessions report `pid`. */
	brushPids(): readonly number[] | undefined {
		return this.engine?.kind === "brush" ? this.engine.execution.pids() : undefined;
	}

	get hasExited(): boolean {
		return this.state.hasExited;
	}

	/**
	 * The shell process itself has exited. In pipes mode this can be true
	 * while `hasExited` is still false: background jobs that inherited the
	 * output pipe keep it open, so the close-based session exit lags (or
	 * never arrives). Lets callers explain a session that reports "running"
	 * although its shell is gone. A Brush execution ends with its foreground
	 * command, so its shell exits with the session.
	 */
	get shellExited(): boolean {
		switch (this.engine?.kind) {
			case "process":
				return this.engine.child.processExited;
			case "brush":
			case undefined:
				return this.state.hasExited;
		}
	}

	get exitCode(): number | null {
		return this.state.exitCode;
	}

	get signal(): NodeJS.Signals | null {
		return this.state.signal;
	}

	get failureMessage(): string | null {
		return this.state.failureMessage;
	}

	get totalBytesSeen(): number {
		return this.totalOutputBytes;
	}

	get lastUsed(): number {
		return this.lastUsedAt;
	}

	touch(): void {
		this.lastUsedAt = Date.now();
	}

	/** Terminate + mark closed. Used by session-store LRU eviction / shutdown. */
	terminate(signal: NodeJS.Signals = "SIGTERM"): void {
		this.kill(signal);
		// onExit closes logStream; terminate() is idempotent so this is fine.
	}
}
