/**
 * unified-exec — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, yield_time_ms?, yield_until?)
 *   - set_on_exit(session_id, on_exit)            [disarm/re-arm wake without kill]
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session. If the process is still
 *     alive when the call's yield deadline expires, the tool returns with
 *     `session_id` in its body and the LLM can follow up with write_stdin.
 *   - `write_stdin` with empty `chars` is a pure poll; with non-empty, it also
 *     writes the bytes (including \\x03 for Ctrl-C, \\x04 for EOF).
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Sessions are terminated on session_shutdown (codex parity).
 *   - Every byte the child writes goes to a per-session log file at
 *     /tmp/pi-unified-exec-<sid>-<random>.log. The LLM sees the last ~50 KiB
 *     / 2000 lines per call and the full file is available via `read`.
 */

import { constants as osConstants } from "node:os";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import { approvalCommand, approveCommand } from "../fork-features/brush/approval.ts";
import type { CommandApproval } from "../fork-features/brush/approval.ts";
import { bindingContext, bindSession, recheckBinding } from "../fork-features/brush/binding.ts";
import { planBrushRun } from "../fork-features/brush/environment.ts";
import { BrushExecution, BrushShells, persistentLease } from "../fork-features/brush/execution.ts";
import { createExecPlan, resolveExecutionPlan, rewriteWorktreePlan } from "../fork-features/brush/plan.ts";
import type { ExecPlan } from "../fork-features/brush/plan.ts";
import { resolveUrlCwd } from "../fork-features/brush/url-filesystem.ts";
import { commandDeadline } from "../fork-features/brush/deadline.ts";
import type { CommandDeadline } from "../fork-features/brush/deadline.ts";
import { hostJobManager, registerHostJob, terminalDelivery } from "../fork-features/brush/jobs.ts";
import type { Delivery, TerminalDelivery } from "../fork-features/brush/jobs.ts";
import { brushKillResultContent, brushResultContent, deadlineDetails, finalizeBrushSession, finalizeSessionResult } from "../fork-features/brush/result.ts";
import { BrushOutput, outputArtifactOwner } from "../fork-features/brush/output.ts";
import type { OutputServices } from "../fork-features/brush/output.ts";
import type { EngineHost, EngineSelection, EngineVariant, HostRuntime } from "../fork-features/brush/runtime.ts";
import { type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { registerCompactCodemode } from "./codemode-render.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed } from "./format-time.ts";
import { type LongWaitOutcome, startRateLimitedStream, waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { getPtyLoadError, isPtyAvailable } from "./pty.ts";
import {
	renderExecCommandCall,
	renderKillSessionCall,
	renderKillSessionResult,
	renderListSessionsCall,
	renderListSessionsResult,
	renderProcessResult,
	renderSetOnExitCall,
	renderSetOnExitResult,
	renderWriteStdinCall,
} from "./render.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResult,
	listSessionsScriptResultSchema,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResult,
	setOnExitScriptResultSchema,
} from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { buildShellCommand, IS_WINDOWS, processShellPath, selectProcessShell } from "./shell.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";
import { MIN_EMPTY_YIELD_TIME_MS, nowUtcIso, parseYieldUntil, resolveEmptyPollYield } from "./time.ts";
export { MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "./time.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	terminalViewDetails,
	type FinalizeProcessInput,
	type KillStatus,
	type ProcessResultDetails,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input updates and short empty-poll rate limit
// PTY dimension clamps for exec_command's cols/rows (tty: true only).
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
// Long empty polls use output-driven updates, never a periodic heartbeat.
const LONG_WAIT_UPDATE_INTERVAL_MS = 30_000;
const SESSION_UI_KEY = "unified-exec.sessions";

/**
 * Google-compatible string enum schema (plain `type: "string"` + `enum`,
 * mirroring pi-ai's StringEnum helper) — a TypeBox literal union (anyOf/const)
 * breaks Google models.
 */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function decode(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	warnedShellFallback: boolean;
	notifiedBashSource: boolean;
	/**
	 * Sessions spawned but not yet inserted into the store (inside the
	 * early-exit grace window). session_shutdown must see these too —
	 * otherwise a shutdown racing exec_command orphans the child.
	 */
	pendingSessions: Set<ExecSession>;
	/** Set on session_shutdown; new exec_commands are rejected. */
	shuttingDown: boolean;
	/** The host's light/dark appearance, which tty sessions answer to OSC 10/11. */
	appearance: () => TerminalAppearance;
	/** Which host runs the extension and, on omp, the embedded brush shell's state. */
	engine: EngineHost;
	/** Aborted at session_shutdown: attached waits end with it. */
	lifetime: AbortController;
}


/**
 * Dispatch by host, `tty` and `shell` only (#27 G1). On omp every variant
 * first needs the bound session (C1): without it the session's settings —
 * and every pipeline stage reading them — are unknown, so all three report
 * `host_binding_unavailable` instead of running unconfigured.
 */
function selectEngine(engine: EngineHost, args: ExecCommandArgs): EngineSelection {
	switch (engine.kind) {
		case "pi":
			return args.tty === true ? { kind: "pty-process", host: "pi" } : { kind: "pipe-process", host: "pi" };
		case "omp": {
			const binding = engine.binding;
			if (binding.kind !== "bound") {
				const reason = binding.kind === "unbound" ? binding.reason : "no session has started";
				throw execError("host_binding_unavailable", `this omp session could not be bound to its host session (${reason})`);
			}
			if (args.tty === true) return { kind: "pty-process", host: "omp", engine, binding };
			if (args.shell !== undefined && args.shell.length > 0) {
				return { kind: "pipe-process", host: "omp", engine, binding };
			}
			return { kind: "brush", host: "omp", engine, binding };
		}
	}
}

/** Typed tool error: the model sees `<code>: <detail>`. */
function execError(code: "host_binding_unavailable" | "native_shell_unavailable" | "session_not_running" | "async_requires_brush" | "on_exit_requires_coordinator", detail: string): Error {
	return new Error(`${code}: ${detail}`);
}

type ExecCommandArgs = {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
	timeout?: number;
	async?: boolean;
};

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_b64?: string;
	yield_time_ms?: number;
	yield_until?: string;
};

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

const HELD_OPEN_NOTE =
	"shell has exited, but background process(es) still hold the output pipe " +
	"(inherited stdout/stderr, or a backgrounded `cd … && cmd &` chain whose subshell is still waiting), " +
	"so this session stays open until they exit. To detach: redirect inside the job — " +
	"`(cd dir && cmd >log 2>&1 </dev/null) &` or `setsid cmd >log 2>&1 </dev/null &` — " +
	"or end the session with kill_session.";

/**
 * Explanation for sessions whose shell has exited but whose output pipe is
 * still held open by background processes: they report "running" even though
 * the foreground command is long done. State-driven (never command-text
 * matching), so it covers any construct that leaves a pipe holder behind.
 */
function heldOpenNote(session: ExecSession): string | undefined {
	return session.shellExited && !session.hasExited ? HELD_OPEN_NOTE : undefined;
}

/**
 * Spawn a PipeProcess or PtyProcess session: the configured shell (default
 * bash) as a real process with `process.env`, unchanged from before the
 * Brush engine.
 */
function spawnProcessSession(
	ctx: ExtensionCtx, id: number, args: ExecCommandArgs, plan: ExecPlan,
	variant: Extract<EngineVariant, { readonly kind: "pipe-process" | "pty-process" }>, deadline: CommandDeadline,
): ExecSession {
	const selection = variant.host === "omp" ? variant.shell : selectProcessShell(args.shell);
	const shellBin = processShellPath(selection);
	if (selection.kind === "default") {
		const resolved = selection.selection;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				"unified-exec: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_UNIFIED_EXEC_BASH.",
				"warning",
			);
		} else if (
			!resolved.fellBack &&
			resolved.bashSource &&
			resolved.bashSource !== "path" &&
			resolved.bashSource !== "env" &&
			!ctx.notifiedBashSource
		) {
			// bash located off PATH (derived from git.exe or a known install
			// root) — say so once, so shell selection is never mysterious.
			ctx.notifiedBashSource = true;
			ctx.ui?.notify(`unified-exec: using bash at ${resolved.shell} (not on PATH)`, "info");
		}
	}
	const shellCommand = buildShellCommand(shellBin, plan.command);
	return ExecSession.spawn(id, {
		command: shellCommand.command,
		cwd: plan.cwd,
		env: process.env,
		tty: plan.variant.kind === "pty-process",
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: plan.command,
		shell: shellBin,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
		deadline,
		appearance: ctx.appearance,
	});
}

/**
 * Start a Brush session: the command runs on the plugin's embedded brush
 * shell with the bound session's shell configuration (rc snapshot, direnv,
 * non-interactive env, Git Guard), on the session's persistent shell when the
 * host would run it directly (#27 C2).
 */
function createBrushSession(
	ctx: ExtensionCtx,
	variant: Extract<EngineVariant, { kind: "brush" }>,
	id: number,
	plan: ExecPlan,
	sessionId: string,
	delivery: Delivery,
	deadline: CommandDeadline,
	autoBackground: boolean,
	asyncRequested: boolean,
	caller: unknown,
): ExecSession {
	const { engine, binding } = variant;
	const settings = binding.session.settings;
	if (engine.native.kind === "unavailable") {
		throw execError("native_shell_unavailable", `the embedded shell's native addon could not be loaded (${engine.native.reason})`);
	}
	const native = engine.native.module;
	engine.shells ??= new BrushShells(native);
	const shells = engine.shells;
	shells.retireOtherSessions(sessionId);
	return ExecSession.brush(id, {
		cwd: plan.cwd,
		displayCommand: plan.command,
		delivery,
		deadline,
		output: (observe) => new BrushOutput(engine.services.output, settings, outputArtifactOwner(caller), observe),
		finalize: (session, outcome, output) => finalizeBrushSession(session, outcome, output, engine.services.output),
		start: (onOutput, output) =>
			BrushExecution.create({
				shells,
				native,
				persistent: persistentLease(delivery, autoBackground, asyncRequested),
				prepare: async (signal) => {
					const launch = await planBrushRun(engine.services, settings, sessionId, plan.command, plan.cwd, signal);
					signal.throwIfAborted();
					await output.prepare(signal);
					signal.throwIfAborted();
					if (ctx.shuttingDown) throw new Error("unified-exec: session is shutting down; not starting new commands.");
					return { ...launch, cwd: plan.cwd };
				},
				timeoutMs: deadline.kind === "deadline" ? deadline.milliseconds : undefined,
				filesystem: (signal) => variant.filesystem(signal).nativeFilesystem(),
				onOutput,
			}),
	});
}

/** Serial, output-driven host progress; it owns no output cursor or delivery state. */
async function reportHostProgress(
	session: ExecSession, delivery: Extract<Delivery, { kind: "host-job" }>,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
): Promise<void> {
	const closed = session.outputClosed.closed();
	let reportedBytes = -1;
	while (!session.outputClosed.isClosed && !delivery.signal.aborted) {
		const next = session.outputNotify.notified();
		if (reportedBytes !== session.totalBytesSeen) {
			reportedBytes = session.totalBytesSeen;
			const frame = { state: "running" as const, jobId: delivery.jobId, type: "bash" as const };
			const foreground = delivery.manager.getJob(delivery.jobId)?.foreground === true;
			const update = buildStreamUpdate(session, foreground ? undefined : { job_id: delivery.jobId, async: frame });
			await delivery.reportProgress(update.details.output, { ...update.details, async: frame });
			onUpdate?.(update);
		}
		if (session.outputClosed.isClosed || delivery.signal.aborted) return;
		await Promise.race([next, closed]);
		if (!session.outputClosed.isClosed && !delivery.signal.aborted) await sleep(200, delivery.signal);
	}
}

/** Resolve the manager's sole run relay; never await its own job promise here. */
async function finishHostJob(
	session: ExecSession, delivery: Extract<Delivery, { kind: "host-job" }>,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	services: OutputServices,
): Promise<void> {
	const progress = reportHostProgress(session, delivery, onUpdate);
	void progress.catch(() => undefined);
	try {
		const final = await session.brushFinal;
		await progress;
		if (!final || final.kind === "terminated" || delivery.signal.aborted) throw new Error("The command was terminated.");
		// The command remains in final details/process metadata, not a second copy in the delivered body.
		const content = await brushResultContent(final.details, services);
		const text = content[0]?.type === "text" ? content[0].text : "";
		if (text.length > services.asyncInlineMaxChars) {
			throw new Error("omp-unified-exec: final result exceeds the host async inline boundary");
		}
		const failed = Boolean(final.details.timedOut || final.details.failure_message || final.details.exit_code !== 0);
		const frame = { state: failed ? "failed" as const : "completed" as const, jobId: delivery.jobId, type: "bash" as const };
		await delivery.reportProgress(text, {
			...final.details, async: frame,
			...(final.details.exit_code !== undefined ? { exitCode: final.details.exit_code } : {}),
		});
		if (delivery.manager.getJob(delivery.jobId)?.foreground !== true) onUpdate?.({
			content,
			details: { ...final.details, job_id: delivery.jobId, async: frame, output: text },
		});
		if (failed) throw new Error(text);
		delivery.resolve(text);
	} catch (error) { delivery.reject(error); }
}

type BrushWait = { readonly kind: "until-exit" } | { readonly kind: "finite"; readonly milliseconds: number };

async function waitForBrush(session: ExecSession, wait: BrushWait, signal: AbortSignal | undefined): Promise<LongWaitOutcome> {
	if (wait.kind === "finite") return waitForExitOrDeadline({ exited: session.exited, externalAbort: signal, durationMs: wait.milliseconds });
	if (session.hasExited) return "exit";
	if (signal?.aborted) return "cancelled";
	const done = Promise.withResolvers<LongWaitOutcome>();
	const onAbort = () => done.resolve("cancelled");
	const onExit = () => done.resolve("exit");
	signal?.addEventListener("abort", onAbort, { once: true });
	session.exited.addEventListener("abort", onExit, { once: true });
	try {
		if (session.hasExited) return "exit";
		if (signal?.aborted) return "cancelled";
		return await done.promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		session.exited.removeEventListener("abort", onExit);
	}
}

async function hostTerminalTail(session: ExecSession): Promise<{ collected: CollectResult; delivery: TerminalDelivery }> {
	const delivery = session.delivery;
	if (delivery.kind !== "host-job") throw new Error("Host terminal observation requires a HostJob");
	await delivery.jobPromise;
	await session.outputClosed.closed();
	const state = terminalDelivery(delivery, session.wasTerminated);
	if (state === "pending") delivery.manager.consumeJobResults([delivery.jobId]);
	return {
		delivery: state,
		collected: state === "delivered" ? NO_OUTPUT : await session.collect({ deadlineMs: Date.now() + 100 }),
	};
}

async function observeHostTerminal(
	ctx: ExtensionCtx, session: ExecSession, operation: "exec_command" | "write_stdin",
	wallTimeSec: number, extra: Partial<ProcessResultDetails> = {}, failure?: string,
): Promise<ResponseShape> {
	const observed = await hostTerminalTail(session);
	removeSession(ctx, session.id);
	return finalizeSessionResult(session, {
		operation, wallTimeSec, collected: observed.collected, totalBytes: session.totalBytesSeen,
		sessionId: undefined, exitCode: session.exitCode, signal: session.signal,
		failure: observed.delivery === "terminated" ? "The command was terminated." : failure ?? session.failureMessage,
		tty: false, logPath: session.logPath, cwd: session.cwd, command: session.displayCommand,
		extra: { ...extra, delivery: observed.delivery, ...(session.delivery.kind === "host-job" ? { job_id: session.delivery.jobId } : {}) },
	});
}

async function runBrushCommand(
	ctx: ExtensionCtx, variant: Extract<EngineVariant, { kind: "brush" }>, plan: ExecPlan,
	args: ExecCommandArgs, signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined, sessionId: string, deadline: CommandDeadline,
	caller: unknown,
): Promise<ResponseShape> {
	const manager = hostJobManager(variant.binding.session.asyncJobManager);
	const services = variant.engine.services;
	const autoBackground = services.autoBackgroundEnabled(variant.binding.session.settings);
	let session: ExecSession | undefined;
	let delivery: Delivery = { kind: "coordinator" };
	if (manager && (!manager.atCapacity || args.async === true)) {
		if (args.on_exit === "wake" && !manager.atCapacity) {
			throw execError("on_exit_requires_coordinator", 'HostJob commands deliver through the host; on_exit: "wake" is unavailable.');
		}
		try {
			delivery = registerHostJob(manager, variant.binding.agentId, plan.command, plan.cwd, () => session?.brushPids() ?? []);
		} catch (error) {
			if (args.async === true || !(error instanceof Error) || !error.message.startsWith("Background job limit reached")) throw error;
		}
	} else if (args.async === true) {
		throw new Error("Async job manager unavailable for this session.");
	}
	const id = ctx.store.allocateId();
	try {
		session = createBrushSession(ctx, variant, id, plan, sessionId, delivery, deadline, autoBackground, args.async === true, caller);
		if (session.failureMessage) throw new Error(session.failureMessage);
		const active = session;
		if (delivery.kind === "host-job") {
			const job = delivery;
			const abort = () => active.terminateBrush();
			job.signal.addEventListener("abort", abort, { once: true });
			if (job.signal.aborted) abort();
			void job.jobPromise.then(() => job.signal.removeEventListener("abort", abort));
		}
		const { pruned, count } = ctx.store.insert(active);
		watchSessionExit(ctx, active);
		if (pruned) {
			unwatchSessionExit(ctx, pruned.id);
			if (pruned.delivery.kind === "coordinator") ctx.coordinator.handleEviction(pruned);
			ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
		}
		if (count >= WARNING_SESSIONS) ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
		if (delivery.kind === "host-job") void finishHostJob(active, delivery, onUpdate, services.output);
		active.beginBrush();
		const startedAt = performance.now();
		const wait: BrushWait = args.async === true ? { kind: "finite", milliseconds: 0 }
			: args.yield_time_ms !== undefined ? { kind: "finite", milliseconds: clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS) }
			: delivery.kind === "host-job" && autoBackground ? {
				kind: "finite", milliseconds: services.autoBackgroundWaitMs(
					Math.floor(services.autoBackgroundThresholdMs(variant.binding.session.settings)),
					deadline.kind === "deadline" ? deadline.milliseconds : undefined),
			} : { kind: "until-exit" };
		const stream = onUpdate && delivery.kind === "coordinator" ? startRateLimitedStream({
			outputNotify: active.outputNotify, minIntervalMs: OUTPUT_POLL_INTERVAL_MS,
			emit: () => onUpdate(buildStreamUpdate(active)),
		}) : undefined;
		try {
			await waitForBrush(active, wait, signal);
			const wallTimeSec = (performance.now() - startedAt) / 1000;
			if (active.hasExited) {
				if (delivery.kind === "host-job") {
					delivery.manager.releaseForegroundJob(delivery.jobId);
					if (active.wasTerminated) return observeHostTerminal(ctx, active, "exec_command", wallTimeSec);
				}
				const final = await active.brushFinal;
				removeSession(ctx, active.id);
				if (!final || final.kind === "terminated") {
					return finalizeSessionResult(active, {
						operation: "exec_command", wallTimeSec, collected: await active.collect({ deadlineMs: Date.now() + 100 }),
						sessionId: undefined, exitCode: active.exitCode, signal: active.signal, failure: "The command was terminated.",
						tty: false, logPath: active.logPath, cwd: active.cwd, command: active.displayCommand,
					});
				}
				return final.details;
			}
			if (delivery.kind === "host-job") delivery.manager.backgroundJob(delivery.jobId);
			else if (args.on_exit === "wake") ctx.coordinator.register(active);
			return finalizeSessionResult(active, {
				operation: "exec_command", wallTimeSec,
				collected: await active.collect({ deadlineMs: Date.now(), externalAbort: signal }),
				totalBytes: active.totalBytesSeen, sessionId: active.id, exitCode: undefined, signal: null, failure: null,
				tty: false, logPath: active.logPath, cwd: active.cwd, command: active.displayCommand,
				yieldTimeMs: wait.kind === "finite" ? wait.milliseconds : undefined,
				extra: delivery.kind === "host-job" ? {
					job_id: delivery.jobId, async: { state: "running", jobId: delivery.jobId, type: "bash" },
				} : { on_exit: args.on_exit, ...(args.on_exit === "wake" ? { completion_notification: "armed" as const } : {}) },
			});
		} finally { stream?.stop(); }
	} catch (error) {
		if (delivery.kind === "host-job") {
			delivery.manager.cancel(delivery.jobId);
			delivery.reject(error);
			delivery.manager.releaseForegroundJob(delivery.jobId);
		}
		if (session) { session.terminateBrush(); removeSession(ctx, session.id); }
		throw error;
	}
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	cwd: string,
	/** The host session id, read only by Brush (it keys the persistent shell). */
	sessionId: () => string,
	/** Exact per-call host context; only omp's Brush context parser reads it. */
	caller?: unknown,
): Promise<ResponseShape> {
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
	const selected = selectEngine(ctx.engine, args);
	if (selected.host === "omp" && args.async === true) {
		if (!selected.engine.services.asyncEnabled(selected.binding.session.settings)) {
			throw new Error("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}
		if (selected.kind !== "brush") throw execError("async_requires_brush", "async mode requires the embedded Brush backend.");
	}
	// Pi keeps its synchronous, raw-path process launch. Only omp awaits
	// the host's cwd stage; its async boundary must recheck shutdown.
	let plan: ExecPlan = selected.host === "pi" ? {
		rawCommand: args.cmd,
		command: args.cmd,
		cwd: args.workdir && args.workdir.length > 0 ? args.workdir : cwd,
		variant: selected,
	} : await rewriteWorktreePlan(resolveExecutionPlan(await createExecPlan(args, cwd, selected), args.shell, caller));
	if (selected.host === "omp" && ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
	// The host owns both the mutation detector and the persistent read cache.
	// Approval has already completed; failed execution does not restore stale rows.
	if (plan.variant.host === "omp") {
		plan.variant.engine.services.invalidateGithubCacheForBashCommand(plan.command);
		if (plan.variant.engine.services.paths.canHandleInternalUrl(plan.cwd)) {
			plan = await resolveUrlCwd(plan, signal);
			if (ctx.shuttingDown) throw new Error("unified-exec: session is shutting down; not starting new commands.");
		}
	}
	const variant = plan.variant;
	const deadline: CommandDeadline = variant.host === "pi" ? { kind: "unlimited" }
		: commandDeadline(variant.engine.services, variant.binding.session.settings, variant.kind === "brush", args.timeout);
	if (variant.kind === "brush") return runBrushCommand(ctx, variant, plan, args, signal, onUpdate, sessionId(), deadline, caller);
	const tty = variant.kind === "pty-process";
	if (tty && !isPtyAvailable()) {
		throw new Error(
			`tty: true is unavailable: ${getPtyLoadError() ?? "no supported PTY backend"}.\n` +
				`Upgrade Bun to a version with Bun.Terminal, install Node optional dependencies, or call with tty: false.`,
		);
	}
	const effectiveCwd = plan.cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
	const wantsWake = args.on_exit === "wake";

	const id = ctx.store.allocateId();
	const session = spawnProcessSession(ctx, id, args, plan, variant, deadline);
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeSessionResult(session, { ...input, operation: "exec_command" });

	if (session.failureMessage) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: NO_OUTPUT,
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			tty,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			command: plan.command,
			yieldTimeMs,
		});
	}

	// Track the session from spawn to store-insertion: session_shutdown must
	// be able to terminate children that are still inside the grace window.
	ctx.pendingSessions.add(session);
	try {
		// Early-exit grace: if the process dies within 150 ms, treat it as a
		// short-lived command and never register it.
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);
		if (ctx.engine.kind === "omp" && ctx.shuttingDown) {
			throw new Error("unified-exec: session is shutting down; command attachment ended.");
		}

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			// Fully short-lived: collect everything in the buffer + any trailing
			// bytes. macOS can deliver stdout/stderr shortly after the exit event
			// for very fast commands — give the trailing drain a bounded window.
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty,
				logPath: session.logPath,
				cwd: effectiveCwd,
				command: plan.command,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					// Exit delivered in this very result: a requested wake is
					// satisfied directly without ever being armed.
					...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				},
			});
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		watchSessionExit(ctx, session);
		if (pruned) {
			unwatchSessionExit(ctx, pruned.id);
			// Suppresses the wake for live victims; keeps a tombstone for a
			// naturally-exited wake session so its completion is not silently lost.
			ctx.coordinator.handleEviction(pruned);
			ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
		}
		// Note: sessions stay in the store until a later tool call observes the
		// exit: write_stdin returns the final exit_code/output, and list_sessions
		// reports exited sessions one last time (with exit info) before removing
		// them. Matches codex's lazy-drain so exit information is never silently
		// lost across turns.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();
		if (ctx.engine.kind === "omp" && ctx.shuttingDown) {
			throw new Error("unified-exec: session is shutting down; command attachment ended.");
		}

		session.touch();
		const stillAlive = !session.hasExited;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) still delivers the completion exactly once.
			if (wantsWake) ctx.coordinator.register(session);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				tty,
				logPath: session.logPath,
				cwd: effectiveCwd,
				command: plan.command,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: heldOpenNote(session),
				},
			});
		}
		// Process exited during this call → respond with exit info, not a
		// session_id. The wake is never armed: the exit was delivered directly.
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty,
			logPath: session.logPath,
			cwd: effectiveCwd,
			command: plan.command,
			yieldTimeMs,
			extra: {
				on_exit: args.on_exit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
			},
		});
	} finally {
		ctx.pendingSessions.delete(session);
		// Short-lived commands never enter the store; release their terminal here.
		if (ctx.store.get(session.id) !== session) void session.release();
	}
}

async function runHostAttachedWait(
	ctx: ExtensionCtx, session: ExecSession, durationMs: number, signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	waitFields: Partial<ProcessResultDetails>, input?: Uint8Array,
): Promise<ResponseShape> {
	const delivery = session.delivery;
	if (delivery.kind !== "host-job") throw new Error("Host attachment requires a HostJob");
	const startedAt = performance.now();
	session.touch();
	let writeFailure: string | undefined;
	if (input) {
		const written = await session.writeInput(input, signal);
		signal?.throwIfAborted();
		switch (written.kind) {
			case "cancelled": throw new DOMException("stdin write was cancelled; some bytes may have been delivered", "AbortError");
			case "not_running":
				return observeHostTerminal(ctx, session, "write_stdin", (performance.now() - startedAt) / 1000, waitFields,
					`session_not_running: session_id ${session.id} has already exited; nothing was written and the session is now closed.`);
			case "refused": writeFailure = `stdin write did not complete: ${written.reason}; some bytes may have been delivered`; break;
			case "written": break;
		}
	}
	const streamer = onUpdate ? startRateLimitedStream({
		outputNotify: session.outputNotify, minIntervalMs: LONG_WAIT_UPDATE_INTERVAL_MS,
		emit: () => onUpdate(buildStreamUpdate(session, waitFields)),
	}) : undefined;
	try {
		const outcome = await waitForExitOrDeadline({
			exited: session.exited, externalAbort: signal,
			durationMs: Math.max(0, durationMs - (performance.now() - startedAt)),
		});
		const wallTimeSec = (performance.now() - startedAt) / 1000;
		if (session.hasExited) return observeHostTerminal(ctx, session, "write_stdin", wallTimeSec, {
			...waitFields, wait_status: "completed", completion_delivery: "direct", tool_time_utc: nowUtcIso(),
		}, writeFailure);
		return finalizeSessionResult(session, {
			operation: "write_stdin", wallTimeSec,
			collected: outcome === "cancelled" ? NO_OUTPUT : await session.collect({ deadlineMs: Date.now() }),
			totalBytes: session.totalBytesSeen, sessionId: session.id, exitCode: undefined,
			signal: null, failure: writeFailure ?? null, tty: false, logPath: session.logPath,
			cwd: session.cwd, command: session.displayCommand,
			extra: {
				...waitFields, job_id: delivery.jobId,
				async: { state: "running", jobId: delivery.jobId, type: "bash" },
				wait_status: outcome === "cancelled" ? "cancelled" :
					waitFields.wait_mode === "absolute" ? "absolute_deadline_reached" : "relative_deadline_reached",
				effective_wait_ms: wallTimeSec * 1000, tool_time_utc: nowUtcIso(),
			},
		});
	} finally { streamer?.stop(); }
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const session = ctx.store.get(args.session_id);
	if (!session) {
		throw new Error(`unknown session_id: ${args.session_id}`);
	}
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeSessionResult(session, { ...input, operation: "write_stdin" });
	const writeBytes = resolveWriteInput(args);
	const isEmptyPoll = writeBytes === undefined || writeBytes.length === 0;
	const hasYieldUntil = typeof args.yield_until === "string" && args.yield_until.length > 0;

	// Relative durations and absolute UTC deadlines are mutually exclusive.
	if (hasYieldUntil && args.yield_time_ms !== undefined) {
		throw new Error(
			`write_stdin: pass either yield_time_ms (relative wait) or ` +
				`yield_until (absolute UTC deadline), not both. tool_time_utc: ${nowUtcIso()}`,
		);
	}
	// `yield_until` is only valid for an empty poll (no input bytes).
	if (hasYieldUntil && !isEmptyPoll) {
		throw new Error(
			`write_stdin: yield_until is only valid for an empty poll (no non-empty chars or chars_b64). ` +
				`Send the input with a relative yield_time_ms first, then follow up with an empty yield_until poll. ` +
				`tool_time_utc: ${nowUtcIso()}`,
		);
	}
	if (isEmptyPoll) {
		const parsed = hasYieldUntil ? parseYieldUntil(args.yield_until!, Date.now()) : undefined;
		const wait: EmptyWait = parsed
			? { mode: "absolute", durationMs: parsed.remainingMs, yieldUntil: parsed.normalized }
			: { mode: "relative", durationMs: resolveEmptyPollYield(args.yield_time_ms) };
		return runAttachedWait(ctx, session, wait, signal, onUpdate, toolCallId);
	}

	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);
	if (session.delivery.kind === "host-job") {
		return runHostAttachedWait(ctx, session, yieldTimeMs, signal, onUpdate, { yield_time_ms: yieldTimeMs }, writeBytes);
	}

	const start = Date.now();
	session.touch();

	// Observation lease: while this call may return terminal status, a
	// concurrent exit is held instead of enqueuing a wake (see completion.ts).
	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		let writeFailure: string | null = null;
		if (writeBytes) {
			const written = await session.writeInput(writeBytes, signal);
			if (session.isBrush) signal?.throwIfAborted();
			if (written.kind === "cancelled") {
				throw new DOMException("stdin write was cancelled; some bytes may have been delivered", "AbortError");
			}
			if (written.kind === "refused") {
				// Brush can accept a prefix before a native pipe write fails.
				writeFailure = session.isBrush
					? `stdin write did not complete: ${written.reason}; some bytes may have been delivered`
					: `stdin write failed: ${written.reason}; bytes were not delivered`;
			}
			if (written.kind === "not_running" && session.isBrush) {
				// A Brush execution's stdin ended with it: say so, with its exit
				// status, and drop the record — a later write is an unknown id and
				// can never reach another execution (#27 C2).
				const status =
					session.exitCode !== null ? `exit_code: ${session.exitCode}` : `failure: ${session.failureMessage ?? "unknown"}`;
				ctx.coordinator.observeViaListing(session.id);
				removeSession(ctx, session.id);
				throw execError(
					"session_not_running",
					`session_id ${session.id} has already exited (${status}); nothing was written and the session is now closed.`,
				);
			}
			if (written.kind === "not_running") {
				// Session already exited; return its final state.
				const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
				const armed = ctx.coordinator.isArmed(session.id);
				removeSession(ctx, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				const wallSec = (Date.now() - start) / 1000;
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage,
					tty: session.tty,
					logPath: session.logPath,
					cwd: session.cwd,
					command: session.displayCommand,
					yieldTimeMs,
					// This path is only reachable for input writes (never an empty
					// poll), so no wait_mode is reported — just direct delivery.
					extra: terminalWaitExtra(undefined, armed),
				});
			}
			// Give the child a small window to react before the poll.
			await sleep(100, signal);
		}

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();
		const wallSec = (Date.now() - start) / 1000;

		if (session.hasExited) {
			const armed = ctx.coordinator.isArmed(session.id);
			removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				tty: session.tty,
				logPath: session.logPath,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: terminalWaitExtra(undefined, armed),
			});
		}
		// Still running: release the lease WITHOUT marking observed — the wake
		// (if armed) stays eligible.
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
			tty: session.tty,
			logPath: session.logPath,
			cwd: session.cwd,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
				note: heldOpenNote(session),
			},
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

/** Shared "exited" extra fields for direct terminal delivery. */
function terminalWaitExtra(
	waitMode: "relative" | "absolute" | undefined,
	wakeWasArmed: boolean,
): Partial<ResponseShape> {
	return {
		wait_mode: waitMode,
		wait_status: waitMode ? ("completed" as const) : undefined,
		completion_delivery: "direct",
		tool_time_utc: nowUtcIso(),
		...(wakeWasArmed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
	};
}

type EmptyWait =
	| { mode: "relative"; durationMs: number }
	| { mode: "absolute"; durationMs: number; yieldUntil: string };

/** Both empty-poll forms retain bounded output in the session, not in the wait. */
async function runAttachedWait(
	ctx: ExtensionCtx,
	session: ExecSession,
	wait: EmptyWait,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	if (session.delivery.kind === "host-job") return runHostAttachedWait(ctx, session, wait.durationMs, signal, onUpdate,
		wait.mode === "absolute" ? { wait_mode: wait.mode, yield_until: wait.yieldUntil } :
			{ wait_mode: wait.mode, yield_time_ms: wait.durationMs });
	const startedAt = performance.now();
	const waitFields: Partial<ResponseShape> =
		wait.mode === "absolute"
			? { wait_mode: wait.mode, yield_until: wait.yieldUntil }
			: { wait_mode: wait.mode, yield_time_ms: wait.durationMs };
	session.touch();
	ctx.coordinator.beginObservation(session.id, toolCallId);
	let pendingTerminal = false;
	let streamer: { stop: () => void } | undefined;
	try {
		if (onUpdate) {
			streamer = startRateLimitedStream({
				outputNotify: session.outputNotify,
				minIntervalMs: wait.mode === "relative" && wait.durationMs <= MAX_YIELD_TIME_MS
					? OUTPUT_POLL_INTERVAL_MS : LONG_WAIT_UPDATE_INTERVAL_MS,
				emit: () => onUpdate(buildStreamUpdate(session, waitFields)),
			});
		}
		let outcome: LongWaitOutcome = await waitForExitOrDeadline({
			exited: session.exited,
			externalAbort: signal,
			durationMs: wait.durationMs,
		});
		// Exit wins close races. A cancelled live wait never drains output.
		if (session.hasExited) outcome = "exit";
		const collected = outcome === "cancelled"
			? NO_OUTPUT
			: await session.collect({
				deadlineMs: Date.now() + (outcome === "exit" ? 1000 : 0),
				externalAbort: outcome === "exit" ? undefined : signal,
			});
		const armed = ctx.coordinator.isArmed(session.id);
		const elapsedMs = performance.now() - startedAt;
		const extra: Partial<ResponseShape> = { ...waitFields };
		if (outcome === "exit") {
			Object.assign(extra, terminalWaitExtra(wait.mode, armed));
		} else {
			extra.wait_status = outcome === "cancelled" ? "cancelled"
				: wait.mode === "relative" ? "relative_deadline_reached" : "absolute_deadline_reached";
			extra.effective_wait_ms = elapsedMs;
			extra.tool_time_utc = nowUtcIso();
			extra.note = heldOpenNote(session);
			if (armed) {
				extra.on_exit = "wake";
				extra.completion_notification = "armed";
			}
		}
		const shape = finalizeSessionResult(session, {
			operation: "write_stdin",
			wallTimeSec: elapsedMs / 1000,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: outcome === "exit" ? undefined : session.id,
			exitCode: outcome === "exit" ? session.exitCode : undefined,
			signal: outcome === "exit" ? session.signal : null,
			failure: outcome === "exit" ? session.failureMessage : null,
			tty: session.tty,
			logPath: session.logPath,
			cwd: session.cwd,
			command: session.displayCommand,
			extra,
		});
		if (outcome === "exit") {
			removeSession(ctx, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			pendingTerminal = true;
		} else {
			session.touch();
		}
		return shape;
	} finally {
		streamer?.stop();
		// Successful terminal delivery is committed by tool_execution_end.
		if (!pendingTerminal) ctx.coordinator.releaseObservation(session.id, toolCallId);
	}
}

/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	delivery?: TerminalDelivery;
	/**
	 * `killed`: confirmed dead; `kill_failed`: the kill did NOT land;
	 * `already_exited`: a Brush execution had already ended, so nothing was
	 * terminated (#27 C2).
	 */
	outcome: KillStatus;
}

/** A human control has no output consumer; a model tool result is an observation. */
type TerminationIntent = "control" | "observe";

async function terminationOutput(
	session: ExecSession, intent: TerminationIntent,
): Promise<{ collected: CollectResult; delivery?: TerminalDelivery }> {
	switch (intent) {
		case "control":
			return {
				collected: NO_OUTPUT,
				...(session.delivery.kind === "host-job"
					? { delivery: terminalDelivery(session.delivery, session.wasTerminated) } : {}),
			};
		case "observe":
			if (session.delivery.kind === "host-job") return hostTerminalTail(session);
			if (session.hasExited) await session.outputClosed.closed();
			return { collected: await session.collect({ deadlineMs: Date.now() + 100 }) };
	}
}

/**
 * How long a cancelled Brush execution may take to settle: the native
 * shell's cancellation grace (2 s, 5 s on Windows) plus its output drain.
 */
const BRUSH_TERMINATE_WAIT_MS = IS_WINDOWS ? 8000 : 5000;

/**
 * Brush sessions end only through their execution's termination primitive
 * (#27 C2), which reaps the processes the run spawned. An execution that had
 * already ended is reported as such — observed, not killed.
 */
async function terminateBrushSession(
	ctx: ExtensionCtx, session: ExecSession, intent: TerminationIntent,
): Promise<TerminateOutcome> {
	const sid = session.id;
	if (session.delivery.kind === "host-job") {
		const outcome = session.terminateBrush();
		await waitForExitOrDeadline({ exited: session.exited, durationMs: BRUSH_TERMINATE_WAIT_MS });
		if (!session.hasExited) return { session, collected: NO_OUTPUT, escalated: false, outcome: "kill_failed" };
		const observed = await terminationOutput(session, intent);
		removeSession(ctx, sid);
		return {
			session, ...observed, escalated: false,
			outcome: outcome === "cancelled" ? "killed" : "already_exited",
		};
	}
	const observeEnded = async (): Promise<TerminateOutcome> => {
		const { collected } = await terminationOutput(session, intent);
		if (intent === "observe") ctx.coordinator.observeViaListing(sid);
		removeSession(ctx, sid);
		return { session, escalated: false, collected, outcome: "already_exited" };
	};
	if (session.hasExited) return observeEnded();
	// Suppress the wake BEFORE cancelling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	if (session.terminateBrush() === "already-settled") {
		ctx.coordinator.restoreAfterFailedKill(sid);
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 1000 });
		return observeEnded();
	}
	await waitForExitOrDeadline({ exited: session.exited, durationMs: BRUSH_TERMINATE_WAIT_MS });
	const { collected } = await terminationOutput(session, intent);
	if (!session.hasExited) {
		ctx.coordinator.restoreAfterFailedKill(sid);
		return { session, escalated: false, collected, outcome: "kill_failed" };
	}
	ctx.coordinator.confirmKill(sid);
	removeSession(ctx, sid);
	return { session, escalated: false, collected, outcome: "killed" };
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store — but ONLY on confirmed
 * exit. A kill that doesn't land (taskkill failure, access denied,
 * unkillable state) keeps the session in the store and returns
 * `kill_failed`, so ownership of a live process is never silently dropped.
 * Brush sessions go through their termination primitive instead.
 * Shared by the kill_session tool, the /unified-exec-sessions command and
 * the Tern HUD.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
	intent: TerminationIntent,
): Promise<TerminateOutcome | undefined> {
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	if (session.isBrush) return terminateBrushSession(ctx, session, intent);
	// Explicit kill (model tool or human slash command): suppress the wake
	// BEFORE signaling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	session.kill(initial);
	// Event-driven wait (resolves the instant the exit fires): up to 2s.
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	let escalated = false;
	// On Windows every kill is already a force tree-kill (taskkill /T /F);
	// a "SIGKILL escalation" would spawn a byte-identical taskkill that
	// cannot behave differently, so skip it there.
	if (!session.hasExited && !IS_WINDOWS) {
		session.kill("SIGKILL");
		escalated = true;
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	// Final drain.
	const collected = await session.collect({ deadlineMs: Date.now() + 100 });
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		removeSession(ctx, sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
	}
	return { session, escalated, collected, outcome: killed ? "killed" : "kill_failed" };
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		`⚠ unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
			const held = s.shellExited ? " (shell exited, pipe held)" : "";
			return `  #${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`;
		}),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `unified-exec: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		if (session.delivery.kind === "host-job" && session.wasTerminated) removeSession(ctx, session.id);
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/list_sessions/kill_session observes it. The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

interface StreamUpdateDetails extends ProcessUpdateDetails {
	readonly output: string;
}

/** Shared streaming-update payload (relative polls and absolute waits). */
function buildStreamUpdate(
	session: ExecSession,
	extra?: Partial<ProcessResultDetails>,
): AgentToolResult<StreamUpdateDetails> {
	const live = session.liveOutput();
	const text = live.kind === "screen"
		? sanitizeOutputText(live.snapshot.text)
		: sanitizeOutputText(decode(live.bytes));
	return {
		content: [{ type: "text", text }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			tty: session.tty,
			command: session.displayCommand,
			cwd: session.cwd,
			log_path: session.logPath,
			// Populate `output` so renderResult has a single source regardless
			// of streaming vs final state.
			output: text,
			...(live.kind === "screen" ? { terminal: terminalViewDetails(live.snapshot.view, true) } : {}),
			...extra,
		},
	};
}

function startStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = () => {
		if (stopped) return;
		try {
			onUpdate(buildStreamUpdate(session));
		} catch {
			// ignore transient errors
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

/** The tool call's own abort plus the plugin's lifetime: shutdown ends every attached wait. */
function withLifetime(ctx: ExtensionCtx, signal: AbortSignal | undefined): AbortSignal | undefined {
	if (ctx.engine.kind === "pi") return signal;
	return signal ? AbortSignal.any([signal, ctx.lifetime.signal]) : ctx.lifetime.signal;
}

/** Once omp starts shutdown, its session index no longer admits tool operations. */
function assertHostSessionOpen(ctx: ExtensionCtx): void {
	if (ctx.engine.kind === "omp" && ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not observing sessions.");
	}
}

/** omp-only session events, absent from Pi's typings: `/new`, resume and fork; `/branch` and btw. */
interface OmpSessionEvents {
	on(event: "session_switch" | "session_branch", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
}

/**
 * @param host Pi, or omp with its appearance and the embedded brush shell's
 *   services. Pi leaves the default dark appearance, as omp's own Console answers.
 */
function activate(pi: ExtensionAPI, host: HostRuntime = { kind: "pi" }): ActivatedExtension {
	const coordinator = new CompletionCoordinator({
		send: (message) => {
			// If pi is idle this starts a model turn; if a run is active it is
			// queued as a follow-up — never steering/interrupting the current turn.
			pi.sendMessage(
				{
					customType: "unified-exec-completed",
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onSendError: (err) => {
			ctx.ui?.notify(
				`unified-exec: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		// Eviction UI (status clear + warning) is handled at the insert site;
		// no onEvict callback needed.
		store: new SessionStore({ maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT }),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		warnedShellFallback: false,
		notifiedBashSource: false,
		pendingSessions: new Set(),
		shuttingDown: false,
		appearance: host.kind === "omp" ? host.appearance : () => "dark",
		engine:
			host.kind === "omp"
				? {
						kind: "omp",
						services: host.services,
						native: host.native,
						warn: host.warn,
						binding: { kind: "pending" },
						shells: undefined,
					}
				: { kind: "pi" },
		lifetime: new AbortController(),
	};
	const engine = ctx.engine;

	// By default, unified-exec removes pi's built-in `bash` tool so the LLM
	// is steered toward exec_command/write_stdin. Pass --keep-builtin-bash to
	// preserve the built-in alongside the unified-exec tools.
	pi.registerFlag("keep-builtin-bash", {
		description: "Keep pi's built-in `bash` tool alongside exec_command/write_stdin. By default it is removed.",
		type: "boolean",
		default: false,
	});

	// Observation finalization: "observed" is committed at pi's finalized
	// tool-result event, not merely when the handler returns — see completion.ts.
	pi.on("tool_execution_end", async (event) => {
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	pi.on("agent_settled", async () => {
		ctx.coordinator.flushPending();
	});

	pi.on("session_start", async (_event, eventCtx) => {
		// First session_start of this activation: bind the host session once
		// (#27 C1), before the active tool set changes.
		if (engine.kind === "omp" && engine.binding.kind === "pending") {
			engine.binding = bindSession(engine.services, bindingContext(eventCtx));
			if (engine.binding.kind === "unbound") {
				engine.warn(`omp-unified-exec: host session binding unavailable (${engine.binding.reason})`);
			}
		}
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		if (ctx.lifetime.signal.aborted) ctx.lifetime = new AbortController();
		ctx.coordinator.reset(); // never resurrect wakes from a previous session
		updateRunningSessionsUi(ctx);
		// Default behavior is to remove the built-in `bash` tool. Only keep it
		// if --keep-builtin-bash was passed. Flag lookup uses the registered
		// name without leading dashes.
		const keep = pi.getFlag("keep-builtin-bash");
		if (keep !== true) {
			const active = pi.getActiveTools();
			const filtered = active.filter((name) => name !== "bash");
			if (filtered.length !== active.length) {
				pi.setActiveTools(filtered);
			}
		}
		if (!isPtyAvailable() && eventCtx.hasUI) {
			// Non-fatal: pipes mode still works.
			eventCtx.ui.notify(
				`unified-exec: PTY backend unavailable (${getPtyLoadError() ?? "unknown error"}); tty: true will fail. Pipes still work.`,
				"info",
			);
		}
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	if (engine.kind === "omp") {
		// omp's `/new`, resume and fork emit session_switch; `/branch` and btw
		// emit session_branch; neither emits session_start. Both keep this
		// activation's AgentSession, so only its identity is re-checked (#27 C1).
		// The session id may have changed: shells keyed by another id leave the
		// persistent table (#27 C2).
		const onSessionBoundary = async (branch: boolean, event: unknown, eventCtx: ExtensionContext): Promise<void> => {
			const before = engine.binding.kind;
			const next = recheckBinding(engine.binding, bindingContext(eventCtx));
			engine.binding = next;
			if (before === "bound" && next.kind === "unbound") {
				engine.warn(`omp-unified-exec: host session binding lost (${next.reason})`);
			}
			engine.shells?.retireOtherSessions(eventCtx.sessionManager.getSessionId());
			const reason = typeof event === "object" && event !== null && "reason" in event ? event.reason : undefined;
			const previousFile = typeof event === "object" && event !== null && "previousSessionFile" in event
				? event.previousSessionFile : undefined;
			const cancel = branch || reason === "new";
			const preserve = !branch && (reason === "resume" || reason === "fork") &&
				previousFile !== eventCtx.sessionManager.getSessionFile();
			if (!cancel && !preserve) return;
			for (const session of ctx.store.values()) {
				if (session.delivery.kind === "host-job" &&
					session.delivery.manager.getJob(session.delivery.jobId) === undefined) removeSession(ctx, session.id);
			}
			if (cancel || reason === "resume") ctx.coordinator.reset();
			if (cancel) {
				for (const session of ctx.store.values()) if (session.isBrush) {
					session.terminateBrush();
					removeSession(ctx, session.id);
				}
			}
			updateRunningSessionsUi(ctx);
		};
		// These events exist only on omp; Pi's ExtensionAPI typings do not declare them.
		const ompEvents = pi as unknown as OmpSessionEvents;
		ompEvents.on("session_switch", (event, context) => onSessionBoundary(false, event, context));
		ompEvents.on("session_branch", (event, context) => onSessionBoundary(true, event, context));
	}

	pi.on("session_shutdown", async () => {
		// Reject new executions and observations from here on and terminate
		// everything we own — including sessions still inside exec_command's
		// early-exit grace window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		// Cancel wake timers/listeners first: no stale prompt may ever be
		// injected into a new or closed session.
		ctx.coordinator.shutdown();
		const owned = [...ctx.store.values(), ...ctx.pendingSessions];
		// Brush executions end through their termination primitive (#27 C2),
		// then attached waits end, then every persistent and retained shell is
		// disposed, which ends their `&` jobs. omp gives this handler ~2 s, so
		// the dispose is not awaited past a short budget; the native side
		// finishes it.
		for (const s of owned) if (s.isBrush && !s.hasExited) s.terminateBrush();
		ctx.lifetime.abort();
		if (engine.kind === "omp" && engine.shells) {
			const disposing = engine.shells.disposeAll();
			engine.shells = undefined;
			await Promise.race([disposing, sleep(500)]);
		}
		const drained = ctx.store.terminateAll();
		for (const s of ctx.pendingSessions) {
			if (!s.hasExited) {
				s.terminate();
				drained.push(s);
			}
		}
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation. On Windows the
		// initial kill is already a force tree-kill and a second taskkill is
		// byte-identical, so skip the escalation there (the grace wait above
		// still confirms exits). Event-driven per session: each wait resolves
		// the instant that session's exit fires. A Brush session ignores the
		// signal: its cancelled execution settles on its own.
		await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 1000 })));
		if (!IS_WINDOWS) {
			const survivors = drained.filter((s) => !s.hasExited && !s.isBrush);
			for (const s of survivors) s.kill("SIGKILL");
			await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 500 })));
		}
		if (drained.length && ctx.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.ui.notify(
				`unified-exec: terminated ${drained.length - leftover} live session(s) on shutdown` +
					(leftover ? `; ${leftover} did not confirm exit` : ""),
				 leftover ? "warning" : "info",
			);
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("unified-exec-sessions", {
		description: "List live unified-exec sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			// Reap silently-exited sessions first so the picker only shows live ones.
			for (const s of ctx.store.values()) {
				if (s.hasExited) removeSession(ctx, s.id);
			}
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("unified-exec: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
				const held = s.shellExited ? " (shell exited, pipe held)" : "";
				return `#${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 60)}`;
			});
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`unified-exec: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM", "control");
				if (outcome?.outcome === "killed") killed++;
				else if (outcome?.outcome === "kill_failed") failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				`unified-exec: killed ${killed} ${plural(killed, "session")}` +
					(failed ? `; ${failed} did not confirm exit (still listed)` : ""),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------

	const execProperties = {
		cmd: Type.String({ description: "Shell command to execute." }),
		workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
		shell: Type.Optional(Type.String({ description:
			"Shell binary. Defaults to bash (on Windows: bash if on PATH, else powershell). cmd and powershell/pwsh get shell-appropriate flags." })),
		tty: Type.Optional(Type.Boolean({ description:
			"Allocate a PTY. Default false (plain pipes). With a PTY, output is the rendered terminal screen (plus lines that scrolled off since the last call) rather than the raw stream." })),
		cols: Type.Optional(Type.Number({ description:
			`PTY width in columns (tty: true only; ignored for pipes). Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].` })),
		rows: Type.Optional(Type.Number({ description:
			`PTY height in rows (tty: true only; ignored for pipes). Default 30, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].` })),
		yield_time_ms: Type.Optional(Type.Number({ description:
			`How long (ms) this call stays attached waiting for output before yielding — an attachment window, not the command's lifetime or completion timeout. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].` })),
		on_exit: Type.Optional(StringEnum(["none", "wake"] as const,
			'"none" (default): no auto-resume; poll with write_stdin. "wake": ONE follow-up notification on unobserved exit that resumes the agent — only when the human explicitly wants auto-resume. Change later via set_on_exit. A completion observed directly by a tool result consumes the wake.')),
	};
	const ompExecProperties = engine.kind === "omp" ? {
		...execProperties, timeout: Type.Optional(Type.Number({ description:
			"Command deadline in seconds, not an attachment wait. 0 disables it; otherwise 1..3600 and tools.maxTimeout apply. Brush defaults to 300 seconds; real processes have no default deadline." })),
		yield_time_ms: Type.Optional(Type.Number({ description:
			`Attachment wait only. Explicit values are clamped to ${MIN_YIELD_TIME_MS}..${MAX_YIELD_TIME_MS} ms. Omitted Brush waits use the host auto-background threshold or wait until completion; omitted process waits default to ${DEFAULT_EXEC_YIELD_MS} ms.` })),
	} : undefined;
	const execSchemas = ompExecProperties === undefined ? {
		kind: "pi" as const, base: Type.Object(execProperties),
	} : {
		kind: "omp" as const, base: Type.Object(ompExecProperties),
		async: Type.Object({ ...ompExecProperties, async: Type.Optional(Type.Boolean({ description:
			"Start a Brush command as a host background job immediately. Requires async.enabled and an available host job slot." })) }),
	};

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		...(engine.kind === "omp" ? {
			readsSkillUris: true,
			// These replace essential bash; an outer write xd:// call owns a different abort lifecycle.
			loadMode: "essential" as const,
			approval: (args: unknown): CommandApproval => {
				if (engine.binding.kind !== "bound") return "exec";
				const settings = engine.binding.session.settings;
				return approveCommand(
					approvalCommand(args, ""),
					engine.services.approvalRules(settings),
					engine.services.allowCompoundCommands(settings) ? engine.services.shellConfig(settings).shell : undefined,
					engine.services.approval,
				);
			},
			formatApprovalDetails: (args: unknown): string[] =>
				[`Command: ${engine.services.approval.truncateForPrompt(approvalCommand(args, "(missing)"))}`],
		} : {}),
		description:
			'Run a command in a persistent session. Returns `session_id` if still running (drive with write_stdin) or `exit_code` if it finished within yield_time_ms. on_exit defaults to "none". Only pass on_exit: "wake" when the human explicitly wants auto-resume on unobserved exit — stale wakes interrupt later work. Use set_on_exit to disarm or re-arm a running session.',
		promptSnippet: "Run a shell command; long-running ones yield a session_id",
		promptGuidelines: [
			"Prefer dedicated file tools when available (read/grep/find/ls). Otherwise use exec_command with fast shell tools: rg for content search, fd if available (or find) for file names, and ls for directories.",
			"Use a small yield_time_ms (~500ms) for quick one-shots and the 10s default for most commands; long-running or interactive processes (dev servers, REPLs, ssh, sudo) return a session_id you then drive with write_stdin.",
			"For a long non-interactive command, start with a short yield to obtain a session_id, then use an empty write_stdin poll with a finite yield_time_ms suited to its expected duration. There is no built-in empty-poll maximum; an operator may configure one. Keep waits short for interactive or indefinite processes. Pi manages cache warming independently.",
			'on_exit defaults to "none". Prefer polling or human follow-up. Use on_exit: "wake" ONLY when the human explicitly wants auto-resume on unobserved completion — not for indefinite processes (dev servers, watchers). If you armed wake by mistake or the job is wrong/abandoned, call set_on_exit(session_id, on_exit: "none") promptly (does not kill the process). kill_session still kills and suppresses wake. Combining wake with an observing write_stdin is safe: direct completion consumes the wake.',
			"In codemode scripts, exec_command and write_stdin resolve to objects: print r.output with text(r.output) and check r.exit_code / r.session_id, instead of printing the whole result object.",
			"tty: true output is the rendered terminal, as a human would see it, not the raw stream: each result shows any history_lines that scrolled off above the screen since the last call, then the full current screen, plus the cursor position. screen_changed: false means the screen is exactly as last reported. Full-screen programs (alternate screen) are shown as the whole screen. Styling (colours, reverse video) is not shown; the raw byte stream is in log_path.",
		],
		outputSchema: processScriptResultSchema,
		get parameters() {
			if (execSchemas.kind === "pi") return execSchemas.base;
			return engine.kind === "omp" && engine.binding.kind === "bound" &&
				engine.services.asyncEnabled(engine.binding.session.settings) ? execSchemas.async : execSchemas.base;
		},
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(
				ctx,
				params,
				withLifetime(ctx, signal),
				onUpdate,
				eventCtx.cwd,
				() => eventCtx.sessionManager.getSessionId(),
				eventCtx,
			);
			updateRunningSessionsUi(ctx);
			return {
				content: ctx.engine.kind === "omp"
					? await brushResultContent(shape, ctx.engine.services.output, shape.command)
					: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				...(ctx.engine.kind === "omp" && (shape.timedOut || shape.failure_message ||
					(params.tty !== true && !params.shell && shape.exit_code !== undefined && shape.exit_code !== 0)) ? { isError: true } : {}),
				structuredContent: processScriptResult(shape),
			};
		},
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		...(engine.kind === "omp" ? { loadMode: "essential" as const } : {}),
		description:
			"Write bytes to a running session. Omit both chars and chars_b64 to poll without writing. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\n newline); use `chars_b64` for raw binary. For empty polls, wait with a finite yield_time_ms (relative, no built-in maximum) or yield_until (absolute UTC deadline, only when the human explicitly asks).",
		promptSnippet: "Send input to or poll a running session",
		promptGuidelines: [
			"Empty write_stdin polls default to 5 seconds and accept finite yield_time_ms durations with no built-in maximum. Choose a wait based on expected job duration and needed responsiveness, not cache lifetime. Exit or cancellation returns early; cancellation leaves the process alive. Respect any configured operator limit.",
			'Use yield_until ONLY when the human explicitly asks for a long attached wait or an explicit UTC deadline. Omit yield_time_ms and pass a future UTC timestamp ending in "Z" (compute it from tool_time_utc in tool results). Finite non-interactive sessions only. The call returns immediately when the process exits.',
			"NEVER use yield_until for REPLs, sudo, ssh, password prompts, dev servers, file watchers, debuggers, or any indefinite/interactive session — it is only for finite commands that will exit on their own.",
			'on_exit wake is set via exec_command or set_on_exit, not write_stdin. Observing an exit here consumes an armed wake (direct result). To disarm wake without killing, call set_on_exit(session_id, on_exit: "none").',
			"In tty sessions, submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r.",
			"For very noisy jobs, rely on the log_path and final/truncated output instead of repeatedly polling.",
		],
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `Attachment window in ms, not a process timeout. With input: default ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}]. Empty polls: default/minimum ${MIN_EMPTY_YIELD_TIME_MS}, no built-in maximum; an optional PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS limit rejects larger values. Use a non-negative finite number no greater than Number.MAX_SAFE_INTEGER; fractional ms are rounded down. Mutually exclusive with yield_until.`,
				}),
			),
			yield_until: Type.Optional(
				Type.String({
					description:
						'Absolute UTC deadline to stay attached to an EMPTY poll, as strict RFC 3339 UTC ("2026-07-21T18:30:00Z" or with .mmm; uppercase Z, full date+time with seconds; no offsets). Only when the human explicitly asks for a long attached wait. Returns immediately when the process exits. No default max horizon. Mutually exclusive with yield_time_ms and with input bytes.',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			assertHostSessionOpen(ctx);
			const target = ctx.store.get(params.session_id);
			const shape = await runWriteStdin(ctx, params, withLifetime(ctx, signal), onUpdate, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: ctx.engine.kind === "omp"
					? await brushResultContent(shape, ctx.engine.services.output)
					: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				...(ctx.engine.kind === "omp" && (shape.timedOut || shape.failure_message ||
					(target?.isBrush && shape.exit_code !== undefined && shape.exit_code !== 0)) ? { isError: true } : {}),
				structuredContent: processScriptResult(shape),
			};
		},
		renderCall: renderWriteStdinCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "set_on_exit",
		label: "set_on_exit",
		description:
			'Change on_exit policy for a session without killing it. on_exit: "none" disarms a pending wake (including coordinator tombstones after eviction). on_exit: "wake" arms auto-resume if the process is still running. Cannot recall a follow-up already queued to the agent. kill_session both kills and suppresses.',
		promptSnippet: "Disarm or re-arm on_exit wake for a session",
		promptGuidelines: [
			'Default on_exit is "none". If you set "wake" and no longer need auto-resume (wrong command, user moved on, abandoned approach), call set_on_exit with "none" promptly — do not leave stale wakes armed.',
			"This does not stop the process. Use kill_session to terminate.",
			"Prefer arming wake only when the human explicitly asked for auto-resume.",
			"Disarm cannot recall a completion follow-up that was already delivered to pi.",
		],
		outputSchema: setOnExitScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			on_exit: StringEnum(
				["none", "wake"] as const,
				'"none": disarm wake (process keeps running). "wake": arm auto-resume if still running.',
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			assertHostSessionOpen(ctx);
			const { session_id: sid, on_exit: policy } = params as { session_id: number; on_exit: OnExitPolicy };
			const session = ctx.store.get(sid);
			if (session?.delivery.kind === "host-job") {
				if (policy === "wake") throw execError("on_exit_requires_coordinator",
					'HostJob commands deliver through the host; on_exit: "wake" is unavailable.');
				const value = { session_id: sid, found: true, on_exit: "none" as const,
					status: "already_none", running: !session.hasExited, wake_armed: false };
				return {
					content: [{ type: "text", text: `set_on_exit session_id=${sid} on_exit=none: host delivery is unchanged.` }],
					details: value, structuredContent: setOnExitScriptResult(value),
				};
			}
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			// unknown id: no store session and nothing to disarm
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			const text =
				`set_on_exit session_id=${sid} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				structuredContent: setOnExitScriptResult({
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
				}),
				details: {
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
					command: session?.displayCommand,
					log_path: session?.logPath,
					tool_time_utc: nowUtcIso(),
				},
			};
		},
		renderCall: renderSetOnExitCall,
		renderResult: renderSetOnExitResult,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session (SIGTERM, escalates to SIGKILL after 2s; on Windows any signal force-kills the process tree). Use when the process won't exit via Ctrl-C. session_id is invalid after. Also suppresses any armed on_exit wake.",
		promptSnippet: "Terminate a session",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			assertHostSessionOpen(ctx);
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, "observe");
			if (!outcome) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
					structuredContent: killNotFoundScriptResult(sid),
				};
			}
			const { session, escalated, collected } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure =
				outcome.outcome === "kill_failed"
					? [
							session.isBrush
								? "the command did not confirm termination; the session remains registered — retry kill_session"
								: `process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
									"the session remains registered — retry kill_session or check permissions",
							session.failureMessage,
						]
							.filter((value): value is string => Boolean(value))
							.join("; ")
					: session.failureMessage;
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: sid,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				tty: session.tty,
				logPath: session.logPath,
				cwd: session.cwd,
				command: session.displayCommand,
				escalated,
				outcome: outcome.outcome,
			});
			Object.assign(details, deadlineDetails(session), outcome.delivery ? { delivery: outcome.delivery } : {});
			const output = session.brushOutput;
			const content = output && ctx.engine.kind === "omp"
				? await brushKillResultContent(details, output, ctx.engine.services.output)
				: [{ type: "text" as const, text: renderKillResultText(details) }];
			return {
				content,
				details,
				structuredContent: killScriptResult(details),
			};
		},
		renderCall: renderKillSessionCall,
		renderResult: renderKillSessionResult,
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List all live unified-exec sessions in this pi run.",
		promptSnippet: "List live sessions",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			assertHostSessionOpen(ctx);
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them) — but report each of them
			// one final time with exit info instead of dropping them on the floor.
			// This mirrors codex's `refresh_process_state` filter while preserving
			// our "exit information is never silently lost" guarantee.
			const reaped: ExecSession[] = [];
			for (const s of ctx.store.values()) {
				if (s.hasExited) {
					if (s.delivery.kind === "host-job") {
						if (terminalDelivery(s.delivery, s.wasTerminated) !== "pending") removeSession(ctx, s.id);
					} else {
						ctx.coordinator.observeViaListing(s.id);
						removeSession(ctx, s.id);
					}
					reaped.push(s);
				}
			}
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const live = ctx.store.values().filter((session) => !session.hasExited);
			const sessions = [...live, ...reaped]
				.sort((a, b) => a.id - b.id)
				.map((s) => ({
					session_id: s.id,
					command: s.displayCommand,
					cwd: s.cwd,
					tty: s.tty,
					pid: s.pid,
					// Brush sessions have no process of their own: while running they report the pids their run spawned.
					pids: s.isBrush && !s.hasExited ? [...(s.brushPids() ?? [])] : undefined,
					job_id: s.delivery.kind === "host-job" ? s.delivery.jobId : undefined,
					delivery: s.delivery.kind === "host-job" && s.hasExited
						? terminalDelivery(s.delivery, s.wasTerminated) : undefined,
					started_at_ms: s.startedAt,
					elapsed_ms: now - s.startedAt,
					running: !s.hasExited,
					wake_armed: ctx.coordinator.isArmed(s.id),
					exit_code: s.hasExited ? s.exitCode : undefined,
					signal: s.hasExited ? (s.signal ?? undefined) : undefined,
					failure_message: s.failureMessage ?? undefined,
					output_bytes_total: s.totalBytesSeen,
					log_path: s.logPath,
				}));
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; ${s.delivery === "pending" ? "pending host delivery" : "removed from store"}]`;
						const wake = s.wake_armed ? " [wake]" : "";
						const pidLabel = s.pids ? `pids=${s.pids.join(",") || "-"}` : `pid=${String(s.pid ?? "?").padStart(6)}`;
						return `  ${String(s.session_id).padStart(3)}  ${pidLabel}  ${
							s.tty ? "tty" : "pipe"
						}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}  ${oneLineCommand(s.command, 60)}${exitedSuffix}\n        log: ${s.log_path}`;
					})
				: ["  (no live sessions)"];
			const header = reaped.length
				? `unified-exec sessions (${live.length} live, ${reaped.length} just exited):`
				: `unified-exec sessions (${live.length}):`;
			return {
				// tool_time_utc lets the model compute a yield_until deadline from a
				// trustworthy host clock without an extra probing call.
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, active_count: live.length, just_exited_count: reaped.length, tool_time_utc: toolTimeUtc },
				structuredContent: listSessionsScriptResult({
					sessions,
					active_count: live.length,
					just_exited_count: reaped.length,
					tool_time_utc: toolTimeUtc,
				}),
			};
		},
		renderCall: renderListSessionsCall,
		renderResult: renderListSessionsResult,
	});

	// Shadows native codemode at session start without replacing
	// builtin:codemode. Presentation only, for every nested tool.
	registerCompactCodemode(pi);
	return {
		store: ctx.store,
		// A human kill from the Tern HUD: same path as the slash command.
		kill: async (id) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", "control");
			updateRunningSessionsUi(ctx);
			return outcome?.outcome === "killed";
		},
	};
}

// Fork: on oh-my-pi, tools present through omp's bash renderer and tty sessions
// get a Tern HUD (fork-features/README.md).
export default withHostPresentation(activate);
