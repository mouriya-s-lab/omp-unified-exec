/**
 * omp host services the embedded brush shell uses (fork-features/README.md,
 * "Embedded brush shell"), parsed once at activation into typed functions.
 *
 * Every module is a literal dynamic import: these modules exist only inside
 * omp, and compiled omp rejects variable import specifiers. A missing or
 * reshaped export fails plugin loading instead of degrading later. None of
 * them loads the host's own shell (`exec/bash-executor`, `pi-natives`).
 */

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
	const [root, nonInteractive, snapshot, direnvModule, settings] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/exec/non-interactive-env"),
		import("@oh-my-pi/pi-coding-agent/utils/shell-snapshot"),
		import("@oh-my-pi/pi-coding-agent/exec/direnv"),
		import("@oh-my-pi/pi-coding-agent/exec/settings"),
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
	};
}
