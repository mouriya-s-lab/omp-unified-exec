/**
 * Synchronizes the bundled Tern plugin through Tern's normal copy installer.
 *
 * omp awaits its extension factories during package installation validation,
 * so this initialization completes before install/force-reinstall succeeds.
 * Ordinary extension loading uses the same idempotent initialization; no
 * session event performs installation and no developer link is created.
 *
 * The installed package owns the source files. Tern owns its registration,
 * copied files and loaded plugin state; its CLI publishes the plugin directory
 * and current catalog, and performs all mutations. Local reads only verify
 * Tern's documented directory representation and the resulting copy.
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findOnPath } from "../src/shell.ts";
import { sanitizeOutputText } from "../src/output-safety.ts";

/** The plugin's `id` in `plugin.toml`. */
export const TERN_PLUGIN_ID = "omp-unified-exec";
/** Bundled source directory, resolved from this installed module, never the caller's cwd. */
export const TERN_PLUGIN_DIR = fileURLToPath(new URL("./tern-plugin/", import.meta.url));
// Tern's documented reload wait is up to 60 seconds; allow command startup/copy overhead.
const CLI_TIMEOUT_MS = 75_000;
const MAX_DIAGNOSTIC_CHARS = 4096;
const BUNDLE_FILES: readonly string[] = ["plugin.toml", "terminals.css", "window.luau"];

/** Complete contents of the three files shipped in this CSS-only Tern plugin. */
export interface PluginFiles {
	readonly version: string;
	readonly css: string;
	readonly manifest: string;
	readonly windowScript: string;
}

/** One plugin in `tern plugin list --json`. */
export interface ListedPlugin {
	readonly id: string;
	readonly version: string;
	readonly css: string;
	readonly status: string;
}

/** Whether Tern's normal installed copy exactly matches the bundled files. */
export type CopyState = "current" | "stale";

/** The requested owner operation; a current catalog alone does not prove a normal copy. */
export type PluginAction = { readonly kind: "current" } | { readonly kind: "install" };

export type InstallStage = "inspect" | "install" | "unlink" | "verify";

interface CommandFailure {
	readonly command: readonly string[];
	readonly exitCode: string | number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly message: string;
}

export type InstallFailure =
	| { readonly kind: "command"; readonly stage: InstallStage; readonly details: CommandFailure }
	| { readonly kind: "inspection"; readonly stage: "inspect" | "verify"; readonly message: string }
	| { readonly kind: "verification"; readonly message: string };

export type InstallOutcome =
	/** Tern is not installed; the non-Tern extension remains usable. */
	| { readonly kind: "unavailable" }
	| { readonly kind: "current" }
	| { readonly kind: "installed"; readonly version: string }
	| { readonly kind: "failed"; readonly failure: InstallFailure };

/** Pure: the `version` string of a `plugin.toml`. */
export function parsePluginVersion(toml: string): string {
	const match = /^\s*version\s*=\s*"([^"]*)"\s*$/m.exec(toml);
	if (!match) throw new Error("omp-unified-exec: tern-plugin/plugin.toml has no version");
	return match[1]!;
}

/** Pure: the plugins of a `tern plugin list --json` answer. */
export function parsePluginList(json: string): ListedPlugin[] {
	const value: unknown = JSON.parse(json);
	if (typeof value !== "object" || value === null || !("plugins" in value) || !Array.isArray(value.plugins)) {
		throw new Error("tern plugin list --json: no plugins array");
	}
	return value.plugins.flatMap((entry: unknown): ListedPlugin[] => {
		if (typeof entry !== "object" || entry === null) return [];
		const field = (key: string): string => {
			const v = (entry as Record<string, unknown>)[key];
			return typeof v === "string" ? v : "";
		};
		const id = field("id");
		return id ? [{ id, version: field("version"), css: field("css"), status: field("status") }] : [];
	});
}

/** Pure decision from Tern's catalog and verification of its normal installed copy. */
export function planPluginAction(loaded: readonly ListedPlugin[], files: PluginFiles, copy: CopyState): PluginAction {
	const ours = loaded.find((plugin) => plugin.id === TERN_PLUGIN_ID);
	return copy === "current" && ours?.status === "ready" && ours.version === files.version && ours.css === files.css
		? { kind: "current" }
		: { kind: "install" };
}

/** Read the bundled source, whose identity must match the registration this module manages. */
export function readPluginFiles(dir: string = TERN_PLUGIN_DIR): PluginFiles {
	const manifest = readFileSync(join(dir, "plugin.toml"), "utf8");
	if (!/^\s*id\s*=\s*"omp-unified-exec"\s*$/m.test(manifest)) {
		throw new Error("omp-unified-exec: bundled Tern plugin has an unexpected id");
	}
	return {
		version: parsePluginVersion(manifest),
		css: readFileSync(join(dir, "terminals.css"), "utf8"),
		manifest,
		windowScript: readFileSync(join(dir, "window.luau"), "utf8"),
	};
}

type CliResult =
	| { readonly kind: "success"; readonly stdout: string; readonly stderr: string }
	| { readonly kind: "failure"; readonly details: CommandFailure };

/** Argument-vector spawning, awaited by the factory; never a detached install or shell command. */
function ternPlugin(tern: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	execFile(tern, ["plugin", ...args], { env, timeout: CLI_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
		if (error) {
			resolve({
				kind: "failure",
				details: {
					command: [tern, "plugin", ...args],
					exitCode: error.code ?? null,
					signal: error.signal ?? null,
					stdout,
					stderr,
					message: error.message,
				},
			});
		} else {
			resolve({ kind: "success", stdout, stderr });
		}
	});
	return promise;
}

function parsePluginDirectory(json: string): string {
	const value: unknown = JSON.parse(json);
	if (typeof value !== "object" || value === null || !("dir" in value) ||
		typeof value.dir !== "string" || !isAbsolute(value.dir)) {
		throw new Error("tern plugin dir: no absolute plugin directory");
	}
	return value.dir;
}

function isMissing(error: unknown): error is { readonly code: "ENOENT" } {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function statEntry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** Tern's published registration files are inspected, not written or treated as loaded-state copies. */
function copyState(pluginRoot: string, files: PluginFiles): CopyState {
	if (statEntry(join(pluginRoot, `${TERN_PLUGIN_ID}.path`))) return "stale";
	const dir = join(pluginRoot, TERN_PLUGIN_ID);
	const entry = statEntry(dir);
	if (!entry?.isDirectory() || entry.isSymbolicLink()) return "stale";
	const inventory = readdirSync(dir, { withFileTypes: true });
	if (inventory.length !== BUNDLE_FILES.length ||
		!inventory.every((file) => file.isFile() && BUNDLE_FILES.includes(file.name))) return "stale";
	try {
		return readFileSync(join(dir, "plugin.toml"), "utf8") === files.manifest &&
			readFileSync(join(dir, "terminals.css"), "utf8") === files.css &&
			readFileSync(join(dir, "window.luau"), "utf8") === files.windowScript ? "current" : "stale";
	} catch (error) {
		if (isMissing(error)) return "stale";
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function commandFailure(stage: InstallStage, details: CommandFailure): InstallOutcome {
	return { kind: "failed", failure: { kind: "command", stage, details } };
}

/** Only Tern's exact target-specific link conflict permits the legacy migration. */
function linkedTarget(details: CommandFailure): string | undefined {
	const match = /^tern plugin: omp-unified-exec is linked \((.+)\); use unlink first$/.exec(details.stderr.trim());
	return match?.[1];
}

function knownLegacyLink(pluginRoot: string, target: string): boolean {
	const path = join(pluginRoot, `${TERN_PLUGIN_ID}.path`);
	const entry = statEntry(path);
	if (!entry?.isFile() || entry.isSymbolicLink() || !isAbsolute(target)) return false;
	return resolve(readFileSync(path, "utf8").trim()) === resolve(target);
}

interface InstalledPlugin {
	readonly id: string;
	readonly version: string;
	readonly dir: string;
}

function parseInstalledPlugin(json: string): InstalledPlugin {
	const value: unknown = JSON.parse(json);
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" ||
		!("version" in value) || typeof value.version !== "string" ||
		!("dir" in value) || typeof value.dir !== "string" || !isAbsolute(value.dir)) {
		throw new Error("tern plugin install: no plugin identity, version or absolute destination");
	}
	return { id: value.id, version: value.version, dir: value.dir };
}

/**
 * Ask Tern to install a normal copy when its catalog/copy is not current.
 * Legacy unlink is permitted only after a precise owner-reported collision,
 * matching canonical registration and a fresh catalog identifying this plugin.
 */
export async function ensureTernPlugin(env: NodeJS.ProcessEnv, dir: string = TERN_PLUGIN_DIR): Promise<InstallOutcome> {
	const tern = findOnPath("tern", env);
	if (!tern) return { kind: "unavailable" };
	let files: PluginFiles;
	let pluginRoot: string;
	let loaded: ListedPlugin[];
	try {
		files = readPluginFiles(dir);
		const directory = await ternPlugin(tern, ["dir", "--json"], env);
		if (directory.kind === "failure") return commandFailure("inspect", directory.details);
		pluginRoot = parsePluginDirectory(directory.stdout);
		const catalog = await ternPlugin(tern, ["list", "--json"], env);
		if (catalog.kind === "failure") return commandFailure("inspect", catalog.details);
		loaded = parsePluginList(catalog.stdout);
		if (planPluginAction(loaded, files, copyState(pluginRoot, files)).kind === "current") return { kind: "current" };
	} catch (error) {
		return { kind: "failed", failure: { kind: "inspection", stage: "inspect", message: errorMessage(error) } };
	}

	let installed = await ternPlugin(tern, ["install", dir, "--force", "--json"], env);
	if (installed.kind === "failure") {
		const target = linkedTarget(installed.details);
		if (target === undefined) return commandFailure("install", installed.details);
		try {
			const catalog = await ternPlugin(tern, ["list", "--json"], env);
			if (catalog.kind === "failure") return commandFailure("inspect", catalog.details);
			const registered = parsePluginList(catalog.stdout).some((plugin) => plugin.id === TERN_PLUGIN_ID);
			if (!registered || !knownLegacyLink(pluginRoot, target)) {
				return { kind: "failed", failure: { kind: "verification", message: "Tern's link conflict does not match this plugin's known legacy registration; nothing was unlinked" } };
			}
		} catch (error) {
			return { kind: "failed", failure: { kind: "inspection", stage: "inspect", message: errorMessage(error) } };
		}
		const unlinked = await ternPlugin(tern, ["unlink", TERN_PLUGIN_ID, "--json"], env);
		if (unlinked.kind === "failure") return commandFailure("unlink", unlinked.details);
		installed = await ternPlugin(tern, ["install", dir, "--force", "--json"], env);
		if (installed.kind === "failure") return commandFailure("install", installed.details);
	}

	try {
		const reply = parseInstalledPlugin(installed.stdout);
		if (reply.id !== TERN_PLUGIN_ID || reply.version !== files.version ||
			resolve(reply.dir) !== resolve(join(pluginRoot, TERN_PLUGIN_ID))) {
			return { kind: "failed", failure: { kind: "verification", message: "Tern install returned a different plugin identity, version or destination" } };
		}
		const catalog = await ternPlugin(tern, ["list", "--json"], env);
		if (catalog.kind === "failure") return commandFailure("verify", catalog.details);
		if (planPluginAction(parsePluginList(catalog.stdout), files, copyState(pluginRoot, files)).kind !== "current") {
			return { kind: "failed", failure: { kind: "verification", message: "Tern did not confirm the exact ready normal copy of the bundled plugin" } };
		}
		return { kind: "installed", version: files.version };
	} catch (error) {
		return { kind: "failed", failure: { kind: "inspection", stage: "verify", message: errorMessage(error) } };
	}
}

function diagnostic(text: string): string {
	const bounded = text.length > MAX_DIAGNOSTIC_CHARS
		? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]` : text;
	return sanitizeOutputText(bounded);
}

function formatFailure(failure: InstallFailure): string {
	switch (failure.kind) {
		case "command": {
			const details = failure.details;
			return `omp-unified-exec: Tern plugin ${failure.stage} failed\n` +
				`command: ${JSON.stringify(details.command)}\nexit: ${details.exitCode}; signal: ${details.signal}\n` +
				`stdout: ${diagnostic(details.stdout)}\nstderr: ${diagnostic(details.stderr || details.message)}`;
		}
		case "inspection":
			return `omp-unified-exec: Tern plugin ${failure.stage} failed: ${diagnostic(failure.message)}`;
		case "verification":
			return `omp-unified-exec: Tern plugin verification failed: ${diagnostic(failure.message)}`;
	}
}

export class TernPluginInitializationError extends Error {
	constructor(readonly failure: InstallFailure) {
		super(formatFailure(failure));
		this.name = "TernPluginInitializationError";
	}
}

/** omp awaits this during install validation and ordinary loading, not at session_start. */
export async function initializeTernPlugin(env: NodeJS.ProcessEnv = process.env, dir: string = TERN_PLUGIN_DIR): Promise<void> {
	const outcome = await ensureTernPlugin(env, dir);
	switch (outcome.kind) {
		case "unavailable":
		case "current":
		case "installed":
			return;
		case "failed":
			throw new TernPluginInitializationError(outcome.failure);
	}
}
