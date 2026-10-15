/**
 * How a Brush run's shell is configured: rc snapshot, direnv, the
 * non-interactive env, Git Guard, the output minimizer and the persistent
 * shell key. Mirrors upstream `executeBash`; every setting comes from the
 * bound session (#27 C1/G2) instead of upstream's `Settings.init()`.
 *
 * `applyDirenvPreflight`, `buildMinimizerOptions`, `buildSessionKey` and the
 * bash-shell test are copied from can1357/oh-my-pi@c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4
 * (`packages/coding-agent/src/exec/bash-executor.ts`): that module loads the
 * host's own native shell, so it is not imported (#27 G5).
 */
import type { NativeMinimizerOptions, NativeShellOptions } from "./native.ts";
import type { DirenvDiff, HostSettings, OmpHost, ShellMinimizerSettings } from "./omp-host.ts";

/** POSIX-safe variable name — gates which direnv unsets we inject into the
 *  command line, so a hostile `.envrc` can't smuggle shell syntax through
 *  `unset`. `.envrc` never produces non-identifier names in practice. */
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DirenvPreflightOptions {
	/** Caller-supplied env overlay; these values win over direnv-provided ones. */
	callerEnv?: Record<string, string>;
	signal?: AbortSignal;
	/** Full direnv-load budget (`bash.direnvLoadTimeoutMs`). A positive
	 *  `callerTimeoutMs` clamps the effective load below this; `0`/undefined
	 *  leaves the full budget. */
	timeoutMs?: number;
	/** The caller's command deadline (ms). A positive value clamps the direnv
	 *  load so a cold `.envrc` can't outlast a short-timeout command; `0` or
	 *  undefined means "no caller clamp". */
	callerTimeoutMs?: number;
	/** `bash.direnv` setting — `"off"` skips the load entirely. */
	direnvSetting: "auto" | "off";
	/** Shell wrapper prefix (profiler/strace) to place *after* the unset prefix. */
	commandPrefix?: string | undefined;
}

/**
 * Load the repo's direnv/devenv env and fold it into a `(command, env)` pair:
 * merge `set` under the caller's overlay (caller wins), and prepend a
 * regex-gated `unset -v` for variables the `.envrc` removes (skipping any the
 * caller re-supplied). Upstream `applyDirenvPreflight`, with `loadDirenvEnv`
 * passed in from the host (shared cache).
 */
export async function applyDirenvPreflight(
	loadDirenvEnv: OmpHost["loadDirenvEnv"],
	command: string,
	cwd: string,
	opts: DirenvPreflightOptions,
): Promise<{ command: string; env: Record<string, string> | undefined }> {
	const withPrefix = (line: string): string => (opts.commandPrefix ? `${opts.commandPrefix} ${line}` : line);
	const loadTimeoutMs =
		opts.callerTimeoutMs !== undefined && opts.callerTimeoutMs > 0
			? Math.min(opts.timeoutMs ?? opts.callerTimeoutMs, opts.callerTimeoutMs)
			: opts.timeoutMs;
	const direnvDiff: DirenvDiff | null =
		opts.direnvSetting === "off" ? null : await loadDirenvEnv(cwd, { timeoutMs: loadTimeoutMs, signal: opts.signal });
	if (!direnvDiff) {
		return { command: withPrefix(command), env: opts.callerEnv };
	}
	const mergedEnv = { ...direnvDiff.set, ...opts.callerEnv };
	const direnvUnsets = direnvDiff.unset.filter(
		(name) => !(opts.callerEnv && name in opts.callerEnv) && SAFE_ENV_NAME.test(name),
	);
	const unsetPrefix = direnvUnsets.length > 0 ? `unset -v ${direnvUnsets.join(" ")}; ` : "";
	return { command: `${unsetPrefix}${withPrefix(command)}`, env: mergedEnv };
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): NativeMinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? [...group.only] : undefined,
		except: group.except.length > 0 ? [...group.except] : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

/** The persistent shell key (upstream `buildSessionKey`): the agent session plus everything that configures the shell. */
export function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Readonly<Record<string, string>>,
	agentSessionKey?: string,
	minimizer?: NativeMinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}

/** Upstream snapshots the rc only for bash shells. */
function isBashShell(shell: string): boolean {
	const basename = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	return basename.includes("bash");
}

/** Everything a Brush execution needs from the session's configuration. */
export interface BrushRunPlan {
	/** The command line the shell runs: direnv unsets, then the configured prefix, then the command. */
	readonly command: string;
	/** Per-run env: the non-interactive defaults with direnv's exports over them. */
	readonly env: Record<string, string>;
	readonly shellOptions: NativeShellOptions;
	/** Persistent shell key: the session id and the shell's whole configuration. */
	readonly key: string;
}

/**
 * Configure one Brush run the way upstream `executeBash` configures the
 * embedded shell, reading `settings` from the bound session. `sessionId` keys
 * the persistent shell (upstream: `this.session.getSessionId()`).
 */
export async function planBrushRun(
	host: OmpHost,
	settings: HostSettings,
	sessionId: string,
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<BrushRunPlan> {
	const { shell, env: shellEnv, prefix } = host.shellConfig(settings);
	const minimizer = buildMinimizerOptions(host.shellMinimizer(settings));
	const [snapshotPath, preflight] = await Promise.all([
		isBashShell(shell) ? host.getOrCreateSnapshot(shell, shellEnv) : null,
		applyDirenvPreflight(host.loadDirenvEnv, command, cwd, {
			signal,
			timeoutMs: host.direnvLoadTimeoutMs(settings),
			direnvSetting: host.direnv(settings),
			commandPrefix: prefix,
		}),
	]);
	// The embedded shell reads its builtin switches from the session env; a
	// different env also keys a separate persistent session.
	const sessionEnv = host.gitGuard(settings) ? { ...shellEnv, PI_GIT_GUARD: "1" } : { ...shellEnv };
	return {
		command: preflight.command,
		env: host.buildNonInteractiveEnv(preflight.env),
		shellOptions: { sessionEnv, snapshotPath: snapshotPath ?? undefined, minimizer },
		key: buildSessionKey(shell, prefix, snapshotPath, sessionEnv, sessionId, minimizer),
	};
}
