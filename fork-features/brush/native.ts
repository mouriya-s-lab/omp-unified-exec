/**
 * The embedded brush shell's native addon (fork-features/README.md,
 * "Embedded brush shell"): its API as this plugin uses it, and loading the
 * platform's leaf package.
 *
 * Each platform's `.node` ships as its own package
 * (`omp-unified-exec-native-<platform>`), referenced by URL from
 * `optionalDependencies` and installed without any install script. It is
 * loaded through `createRequire`, which compiled omp supports for `.node`
 * files (`import()` is rejected there).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `minimizer` option of the native shell (upstream `MinimizerOptions`). */
export interface NativeMinimizerOptions {
	enabled?: boolean;
	settingsPath?: string;
	only?: string[];
	except?: string[];
	maxCaptureBytes?: number;
	sourceOutlineLevel?: string;
	legacyFilters?: boolean;
}

export interface NativeShellOptions {
	sessionEnv?: Record<string, string>;
	snapshotPath?: string;
	minimizer?: NativeMinimizerOptions;
	/** Host filesystem bridge (`shell/vfs.rs`); supplied by internal-URL support. */
	filesystem?: unknown;
}

export interface NativeShellRunOptions {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	filesystem?: unknown;
}

export interface NativeMinimizerResult {
	filter: string;
	text: string;
	originalText: string;
	inputBytes: number;
	outputBytes: number;
}

export interface NativeShellRunResult {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
	minimized?: NativeMinimizerResult;
	workingDir?: string;
}

/** One run's stdin pipe; see `ShellStdin` in `crates/unified-exec-native/src/shell.rs`. */
export interface NativeShellStdin {
	/** Resolves once the pipe accepted every byte; rejects `stdin_closed` / `stdin_broken: …`. */
	write(data: Uint8Array): Promise<void>;
	/** Close the write end (EOF for the command). Idempotent. */
	close(): void;
}

export interface NativeShell {
	run(
		options: NativeShellRunOptions,
		stdin: NativeShellStdin,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<NativeShellRunResult>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	liveBackgroundJobCount(): Promise<number>;
	pids(): number[];
}

/** The addon's exports this plugin uses. */
export interface NativeShellModule {
	readonly Shell: new (options?: NativeShellOptions) => NativeShell;
	readonly ShellStdin: new () => NativeShellStdin;
}

export type NativeLoad =
	| { readonly kind: "loaded"; readonly module: NativeShellModule }
	| { readonly kind: "unavailable"; readonly reason: string };

/** Upstream omp's native platforms; each has a leaf package from the release workflow. */
const NATIVE_PLATFORMS: Readonly<Record<string, true>> = {
	"darwin-arm64": true,
	"darwin-x64": true,
	"linux-x64": true,
	"linux-arm64": true,
	"win32-x64": true,
	"win32-arm64": true,
};

function parseModule(value: unknown): NativeShellModule | string {
	if (typeof value !== "object" || value === null) return "the addon exported no object";
	if (!("Shell" in value) || typeof value.Shell !== "function") return "the addon lacks Shell";
	if (!("ShellStdin" in value) || typeof value.ShellStdin !== "function") return "the addon lacks ShellStdin";
	return value as NativeShellModule;
}

/**
 * The leaf package's directory: the nearest `node_modules/<name>` above this
 * module, as Node resolves a bare specifier. Resolved here because compiled
 * omp's `require` does not search `node_modules` for a plugin file's bare
 * specifiers; it does load an absolute `.node` path.
 */
function findPackage(name: string): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Load this platform's addon. Never throws: a missing leaf package or a load
 * failure is `unavailable` with the reason, which Brush dispatch reports as
 * `native_shell_unavailable`.
 */
export function loadNativeShell(): NativeLoad {
	const platform = `${process.platform}-${process.arch}`;
	if (NATIVE_PLATFORMS[platform] !== true) return { kind: "unavailable", reason: `no native shell package for ${platform}` };
	const name = `omp-unified-exec-native-${platform}`;
	const dir = findPackage(name);
	if (!dir) return { kind: "unavailable", reason: `${name} is not installed` };
	let loaded: unknown;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const main = typeof manifest === "object" && manifest !== null && "main" in manifest ? manifest.main : undefined;
		if (typeof main !== "string") return { kind: "unavailable", reason: `${name}: package.json has no main` };
		loaded = createRequire(import.meta.url)(join(dir, main));
	} catch (err) {
		return { kind: "unavailable", reason: `${name}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const parsed = parseModule(loaded);
	return typeof parsed === "string" ? { kind: "unavailable", reason: `${name}: ${parsed}` } : { kind: "loaded", module: parsed };
}
