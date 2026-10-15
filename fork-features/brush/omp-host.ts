/**
 * omp host services the embedded brush shell uses (fork-features/README.md,
 * "Embedded brush shell"), parsed once at activation into typed functions.
 *
 * Every module is a literal dynamic import: these modules exist only inside
 * omp, and compiled omp rejects variable import specifiers. A missing or
 * reshaped export fails plugin loading instead of degrading later. Helpers
 * never construct or execute the host's Shell or import bash-executor.
 */
import { getBashApprovalPatternRules } from "./approval.ts";
import type { ApprovalHelpers, BashApprovalPatternRule } from "./approval.ts";
import type { CwdServices } from "./plan.ts";
import type { CliResolutionHelpers } from "./cli.ts";
import { resolveCliEntryCmd } from "./cli.ts";
import type { FlatShellSegment } from "./worktree.ts";

/** omp's `Settings` for one session. Read only through the readers below. */
export interface HostSettings {
	readonly __hostSettings: unique symbol;
}

/** `Settings.getShellConfig()`: the configured shell and its session env. */
export interface HostShellConfig {
	readonly shell: string;
	readonly env: Readonly<Record<string, string>>;
	/** Wrapper prepended to every command line (profiler, strace); may be empty. */
	readonly prefix: string | undefined;
}

/** `shellMinimizer.*` (upstream `ShellMinimizerSettings`). */
export interface ShellMinimizerSettings {
	readonly enabled: boolean;
	readonly settingsPath: string | undefined;
	readonly only: readonly string[];
	readonly except: readonly string[];
	readonly maxCaptureBytes: number;
	readonly sourceOutlineLevel: string;
	readonly legacyFilters: boolean | undefined;
}

/** `exec/direnv` `DirenvExportDiff`. */
export interface DirenvDiff {
	readonly set: Readonly<Record<string, string>>;
	readonly unset: readonly string[];
}

/** One registered agent's session as the registry holds it (unparsed). */
export interface RegisteredSession {
	readonly session: unknown;
}

export interface OmpHost {
	/** `AgentRegistry.global().get(agentId)`: the agent's live registration. */
	readonly registeredSession: (agentId: string) => RegisteredSession | undefined;
	readonly buildNonInteractiveEnv: (overrides: Record<string, string> | undefined) => Record<string, string>;
	readonly getOrCreateSnapshot: (shell: string, env: Readonly<Record<string, string>>) => Promise<string | null>;
	readonly loadDirenvEnv: (cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal }) => Promise<DirenvDiff | null>;
	readonly shellConfig: (settings: HostSettings) => HostShellConfig;
	readonly gitGuard: (settings: HostSettings) => boolean;
	readonly direnv: (settings: HostSettings) => "auto" | "off";
	readonly direnvLoadTimeoutMs: (settings: HostSettings) => number;
	readonly shellMinimizer: (settings: HostSettings) => ShellMinimizerSettings;
	readonly approvalRules: (settings: HostSettings) => readonly BashApprovalPatternRule[];
	readonly allowCompoundCommands: (settings: HostSettings) => boolean;
	readonly approval: ApprovalHelpers;
	readonly paths: CwdServices;
	readonly worktreeClone: (settings: HostSettings) => boolean;
	readonly rewriteGitWorktreeAdd: (command: string, cli: readonly string[]) => string;
	readonly resolveCliEntryCmd: () => Promise<readonly string[]>;
	readonly extractFlatShellCommandSegments: (command: string) => readonly FlatShellSegment[];
}

type Fn = (...args: never[]) => unknown;

/** `value[name]` when `value` is an object that has it. */
function property(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

function exportedFunction(module: unknown, name: string, from: string): Fn {
	const value = property(module, name);
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}()`);
	// A host export checked to be a function; its parameters are typed by the caller's declaration.
	const fn = value as Fn;
	return fn;
}

/** A registered setting (`cfg*` from `exec/settings`): `get(settings)` reads one session's value. */
function settingReader(module: unknown, name: string): (settings: HostSettings) => unknown {
	const setting = property(module, name);
	const get = property(setting, "get");
	if (typeof get !== "function") throw new Error(`omp-unified-exec: exec/settings lacks ${name}.get()`);
	return (settings) => get.call(setting, settings);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function expect<T>(setting: string, value: unknown, valid: (value: unknown) => value is T): T {
	if (!valid(value)) throw new Error(`omp-unified-exec: setting ${setting} has an unexpected value`);
	return value;
}

function parseShellConfig(value: unknown): HostShellConfig {
	if (typeof value !== "object" || value === null) throw new Error("omp-unified-exec: getShellConfig() returned no object");
	const shell = "shell" in value ? value.shell : undefined;
	const env = "env" in value ? value.env : undefined;
	const prefix = "prefix" in value ? value.prefix : undefined;
	if (typeof shell !== "string" || !isStringRecord(env) || (prefix !== undefined && typeof prefix !== "string")) {
		throw new Error("omp-unified-exec: getShellConfig() returned an unexpected shape");
	}
	return { shell, env, prefix: prefix || undefined };
}

function parseMinimizer(value: unknown): ShellMinimizerSettings {
	if (typeof value !== "object" || value === null) throw new Error("omp-unified-exec: shellMinimizer is not an object");
	const optionalString = (x: unknown): x is string | undefined => x === undefined || typeof x === "string";
	const optionalBoolean = (x: unknown): x is boolean | undefined => x === undefined || typeof x === "boolean";
	return {
		enabled: expect("shellMinimizer.enabled", property(value, "enabled"), (x): x is boolean => typeof x === "boolean"),
		settingsPath: expect("shellMinimizer.settingsPath", property(value, "settingsPath"), optionalString),
		only: expect("shellMinimizer.only", property(value, "only"), isStringArray),
		except: expect("shellMinimizer.except", property(value, "except"), isStringArray),
		maxCaptureBytes: expect(
			"shellMinimizer.maxCaptureBytes",
			property(value, "maxCaptureBytes"),
			(x): x is number => typeof x === "number",
		),
		sourceOutlineLevel: expect(
			"shellMinimizer.sourceOutlineLevel",
			property(value, "sourceOutlineLevel"),
			(x): x is string => typeof x === "string",
		),
		legacyFilters: expect("shellMinimizer.legacyFilters", property(value, "legacyFilters"), optionalBoolean),
	};
}

function parseDirenvDiff(value: unknown): DirenvDiff | null {
	if (value === null) return null;
	if (typeof value !== "object" || !("set" in value) || !("unset" in value) || !isStringRecord(value.set) || !isStringArray(value.unset)) {
		throw new Error("omp-unified-exec: loadDirenvEnv() returned an unexpected shape");
	}
	return { set: value.set, unset: value.unset };
}

/** Load and parse the host services; rejects when omp lacks any of them. */
export async function loadOmpHost(): Promise<OmpHost> {
	const [root, nonInteractive, snapshot, direnvModule, settings, tokenizer, approvalModule, internalUrls, pathUtils, worktree, taskSettings, utils] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/exec/non-interactive-env"),
		import("@oh-my-pi/pi-coding-agent/utils/shell-snapshot"),
		import("@oh-my-pi/pi-coding-agent/exec/direnv"),
		import("@oh-my-pi/pi-coding-agent/exec/settings"),
		import("@oh-my-pi/pi-coding-agent/tools/shell-tokenize"),
		import("@oh-my-pi/pi-coding-agent/tools/approval"),
		import("@oh-my-pi/pi-coding-agent/internal-urls"),
		import("@oh-my-pi/pi-coding-agent/tools/path-utils"),
		import("@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite"),
		import("@oh-my-pi/pi-coding-agent/task/settings"),
		import("@oh-my-pi/pi-utils"),
	]);
	const registryClass: unknown = root.AgentRegistry;
	const global = typeof registryClass === "function" && "global" in registryClass ? registryClass.global : undefined;
	if (typeof global !== "function") throw new Error("omp-unified-exec: @oh-my-pi/pi-coding-agent lacks AgentRegistry.global()");
	const buildEnv = exportedFunction(nonInteractive, "buildNonInteractiveEnv", "exec/non-interactive-env") as (
		overrides?: Record<string, string>,
	) => unknown;
	const getSnapshot = exportedFunction(snapshot, "getOrCreateSnapshot", "utils/shell-snapshot") as (
		shell: string,
		env: Readonly<Record<string, string>>,
	) => Promise<unknown>;
	const loadDirenv = exportedFunction(direnvModule, "loadDirenvEnv", "exec/direnv") as (
		cwd: string,
		opts: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<unknown>;
	const gitGuard = settingReader(settings, "cfgBashGitGuard");
	const direnv = settingReader(settings, "cfgBashDirenv");
	const direnvLoadTimeoutMs = settingReader(settings, "cfgBashDirenvLoadTimeoutMs");
	const shellMinimizer = settingReader(settings, "cfgShellMinimizer");
	const approvalPatterns = settingReader(settings, "cfgBashPatterns");
	const allowCompoundCommands = settingReader(settings, "cfgBashAllowCompoundCommands");
	const worktreeClone = settingReader(taskSettings, "cfgWorktreeClone");
	const isCompiledBinary = exportedFunction(utils, "isCompiledBinary", "pi-utils");
	const stripPrefix = exportedFunction(utils, "stripWindowsExtendedLengthPathPrefix", "pi-utils") as (path: string) => unknown;
	const isExecutable = exportedFunction(utils, "isExecutable", "pi-utils") as (path: string) => unknown;
	const isFullyQualifiedPath = exportedFunction(utils, "isFullyQualifiedPath", "pi-utils") as (path: string) => unknown;
	const which = exportedFunction(utils, "$which", "pi-utils") as (
		command: string, options: { readonly requireAbsolutePaths: true; readonly cache: number },
	) => unknown;
	const bypass = property(property(utils, "WhichCachePolicy"), "Bypass");
	if (typeof bypass !== "number") throw new Error("omp-unified-exec: pi-utils lacks WhichCachePolicy.Bypass");
	const boolean = (value: unknown): value is boolean => typeof value === "boolean";
	const string = (value: unknown): value is string => typeof value === "string";
	const cliHelpers: CliResolutionHelpers = {
		isCompiledBinary: () => expect("isCompiledBinary()", isCompiledBinary(), boolean),
		stripWindowsExtendedLengthPathPrefix: (path) => expect("stripWindowsExtendedLengthPathPrefix()", stripPrefix(path), string),
		isExecutable: (path) => expect("isExecutable()", isExecutable(path), boolean),
		isFullyQualifiedPath: (path) => expect("isFullyQualifiedPath()", isFullyQualifiedPath(path), boolean),
		which: (command) => expect("$which()", which(command, { requireAbsolutePaths: true, cache: bypass }),
			(x): x is string | null => x === null || typeof x === "string"),
		sourceCliEntryCmd: async () => {
			// Only source hosts import this path; compiled omp does not retain it.
			const module = await import("@oh-my-pi/pi-coding-agent/subprocess/worker-client");
			const resolve = exportedFunction(module, "resolveCliEntryCmd", "subprocess/worker-client");
			return expect("resolveCliEntryCmd()", resolve(),
				(x): x is string[] => isStringArray(x) && x.length > 0 && x.every((part) => part.length > 0));
		},
	};
	const rewrite = exportedFunction(worktree, "rewriteGitWorktreeAdd", "tools/bash-worktree-rewrite") as (
		command: string, cli: readonly string[],
	) => unknown;
	const approval: ApprovalHelpers = {
		criticalPatterns: expect("CRITICAL_BASH_PATTERNS", root.CRITICAL_BASH_PATTERNS,
			(x): x is RegExp[] => Array.isArray(x) && x.every((pattern: unknown) => pattern instanceof RegExp)),
		tokenizeShellSegments: exportedFunction(tokenizer, "tokenizeShellSegments", "tools/shell-tokenize") as ApprovalHelpers["tokenizeShellSegments"],
		extractLiteralAndChainSegments: exportedFunction(tokenizer, "extractLiteralAndChainSegments", "tools/shell-tokenize") as ApprovalHelpers["extractLiteralAndChainSegments"],
		truncateForPrompt: exportedFunction(approvalModule, "truncateForPrompt", "tools/approval") as ApprovalHelpers["truncateForPrompt"],
	};
	const routerClass: unknown = internalUrls.InternalUrlRouter;
	const instance = typeof routerClass === "function" && "instance" in routerClass ? routerClass.instance : undefined;
	if (typeof instance !== "function") throw new Error("omp-unified-exec: internal-urls lacks InternalUrlRouter.instance()");
	const router: unknown = instance.call(routerClass);
	const canHandle = property(router, "canHandle");
	if (typeof canHandle !== "function") throw new Error("omp-unified-exec: InternalUrlRouter lacks canHandle()");
	const paths: CwdServices = {
		extractLeadingCdTarget: exportedFunction(tokenizer, "extractLeadingCdTarget", "tools/shell-tokenize") as CwdServices["extractLeadingCdTarget"],
		resolveToCwd: exportedFunction(pathUtils, "resolveToCwd", "tools/path-utils") as CwdServices["resolveToCwd"],
		canHandleInternalUrl: (path) =>
			expect("InternalUrlRouter.canHandle()", canHandle.call(router, path), (x): x is boolean => typeof x === "boolean"),
	};
	return {
		registeredSession: (agentId) => {
			const registry: unknown = global.call(registryClass);
			const get = typeof registry === "object" && registry !== null && "get" in registry ? registry.get : undefined;
			if (typeof get !== "function") throw new Error("omp-unified-exec: AgentRegistry lacks get()");
			const ref: unknown = get.call(registry, agentId);
			return typeof ref === "object" && ref !== null && "session" in ref ? { session: ref.session } : undefined;
		},
		buildNonInteractiveEnv: (overrides) =>
			expect("buildNonInteractiveEnv()", buildEnv(overrides), isStringRecord),
		getOrCreateSnapshot: async (shell, env) => {
			const path = await getSnapshot(shell, env);
			return expect("getOrCreateSnapshot()", path, (x): x is string | null => x === null || typeof x === "string");
		},
		loadDirenvEnv: async (cwd, opts) => parseDirenvDiff(await loadDirenv(cwd, opts)),
		shellConfig: (s) => {
			const getShellConfig = property(s, "getShellConfig");
			if (typeof getShellConfig !== "function") throw new Error("omp-unified-exec: session settings lack getShellConfig()");
			return parseShellConfig(getShellConfig.call(s));
		},
		gitGuard: (s) => expect("bash.gitGuard", gitGuard(s), (x): x is boolean => typeof x === "boolean"),
		direnv: (s) => expect("bash.direnv", direnv(s), (x): x is "auto" | "off" => x === "auto" || x === "off"),
		direnvLoadTimeoutMs: (s) =>
			expect("bash.direnvLoadTimeoutMs", direnvLoadTimeoutMs(s), (x): x is number => typeof x === "number"),
		shellMinimizer: (s) => parseMinimizer(shellMinimizer(s)),
		approvalRules: (s) => getBashApprovalPatternRules(approvalPatterns(s)),
		allowCompoundCommands: (s) => expect("bash.allowCompoundCommands", allowCompoundCommands(s), (x): x is boolean => typeof x === "boolean"),
		approval,
		paths,
		worktreeClone: (s) => expect("worktree.clone", worktreeClone(s), boolean),
		rewriteGitWorktreeAdd: (command, cli) => expect("rewriteGitWorktreeAdd()", rewrite(command, cli), string),
		resolveCliEntryCmd: () => resolveCliEntryCmd(cliHelpers),
		extractFlatShellCommandSegments: exportedFunction(tokenizer, "extractFlatShellCommandSegments", "tools/shell-tokenize") as OmpHost["extractFlatShellCommandSegments"],
	};
}
