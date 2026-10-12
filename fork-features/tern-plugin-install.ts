/**
 * Keeps the package's Tern plugin (`fork-features/tern-plugin/`) installed in
 * the Tern that runs omp, so the terminals pill and the Terminals sheet's
 * output preview are styled without a manual `tern plugin link`.
 *
 * Authority: Tern's daemon owns its plugin set; this module only asks it
 * through the `tern plugin` CLI (`list --json`, `link`, `remove`) and acts on
 * its answers. The package's plugin directory is the source of the plugin's
 * files. Nothing is recorded here: every omp start asks Tern again.
 *
 * Tern is detected as omp itself does (`resolveTernPane` in omp's browser
 * tool): Tern exports `TERN_PANE_SOCKET` and a numeric `TERN_PANE` into every
 * pane. The `tern` CLI comes from PATH and inherits omp's environment, so it
 * addresses the daemon and plugin directory of the Tern omp runs in.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findOnPath } from "../src/shell.ts";

/** The plugin's `id` in `plugin.toml`. */
export const TERN_PLUGIN_ID = "omp-unified-exec";
/** The package's plugin directory, which `tern plugin link` uses in place. */
export const TERN_PLUGIN_DIR = fileURLToPath(new URL("./tern-plugin/", import.meta.url));
const CLI_TIMEOUT_MS = 10_000;

/** The package's plugin as Tern loads it: the fields compared against `tern plugin list`. */
export interface PluginFiles {
	readonly version: string;
	readonly css: string;
}

/** One plugin in `tern plugin list --json`. */
export interface ListedPlugin {
	readonly id: string;
	readonly version: string;
	readonly css: string;
	readonly status: string;
}

/** What to do about the package's plugin, given what Tern has loaded. */
export type PluginAction =
	/** Tern runs these exact files already. */
	| { readonly kind: "current" }
	/** Tern lacks the plugin: link the package's directory. */
	| { readonly kind: "link" }
	/** Tern runs another copy or stale files: link again (replacing an installed copy if link refuses). */
	| { readonly kind: "relink"; readonly loaded: string };

/** How the install attempt ended, for the notice. */
export type InstallOutcome =
	| { readonly kind: "not-tern" }
	| { readonly kind: "current" }
	| { readonly kind: "linked"; readonly version: string; readonly replaced: string | undefined }
	| { readonly kind: "failed"; readonly reason: string };

/** Pure: whether omp runs in a Tern pane (omp's own test: socket set, pane a block id). */
export function inTernPane(env: NodeJS.ProcessEnv): boolean {
	const socket = env.TERN_PANE_SOCKET?.trim();
	const pane = env.TERN_PANE?.trim();
	return Boolean(socket) && pane !== undefined && /^\d+$/.test(pane);
}

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

/** Pure: what to do, given Tern's loaded plugins and the package's files. */
export function planPluginAction(loaded: readonly ListedPlugin[], files: PluginFiles): PluginAction {
	const ours = loaded.find((plugin) => plugin.id === TERN_PLUGIN_ID);
	if (!ours) return { kind: "link" };
	if (ours.status === "ready" && ours.version === files.version && ours.css === files.css) return { kind: "current" };
	return { kind: "relink", loaded: ours.version || "unknown" };
}

/** The package's plugin files, read from its directory. */
export function readPluginFiles(dir: string = TERN_PLUGIN_DIR): PluginFiles {
	return {
		version: parsePluginVersion(readFileSync(`${dir}plugin.toml`, "utf8")),
		css: readFileSync(`${dir}terminals.css`, "utf8"),
	};
}

type CliResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string };

/** Run `tern plugin ARGS` and wait for Tern's answer. */
function ternPlugin(tern: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	execFile(tern, ["plugin", ...args], { env, timeout: CLI_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
		if (error) resolve({ ok: false, error: (stderr.trim() || error.message).split("\n")[0]! });
		else resolve({ ok: true, stdout });
	});
	return promise;
}

/**
 * Ask the Tern omp runs in for its plugins and link the package's plugin when
 * Tern lacks it or runs other files. `tern plugin link` refuses while an
 * installed copy of the plugin exists; that copy is removed and the link retried.
 */
export async function ensureTernPlugin(env: NodeJS.ProcessEnv, files: PluginFiles, dir: string = TERN_PLUGIN_DIR): Promise<InstallOutcome> {
	if (!inTernPane(env)) return { kind: "not-tern" };
	const tern = findOnPath("tern", env);
	if (!tern) return { kind: "failed", reason: "the `tern` command is not on PATH" };
	const listed = await ternPlugin(tern, ["list", "--json"], env);
	if (!listed.ok) return { kind: "failed", reason: `tern plugin list: ${listed.error}` };
	let plan: PluginAction;
	try {
		plan = planPluginAction(parsePluginList(listed.stdout), files);
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
	if (plan.kind === "current") return { kind: "current" };
	const replaced = plan.kind === "relink" ? plan.loaded : undefined;
	let linked = await ternPlugin(tern, ["link", dir, "--json"], env);
	if (!linked.ok && plan.kind === "relink") {
		const removed = await ternPlugin(tern, ["remove", TERN_PLUGIN_ID, "--json"], env);
		if (!removed.ok) return { kind: "failed", reason: `tern plugin link: ${linked.error}; remove: ${removed.error}` };
		linked = await ternPlugin(tern, ["link", dir, "--json"], env);
	}
	if (!linked.ok) return { kind: "failed", reason: `tern plugin link: ${linked.error}` };
	return { kind: "linked", version: files.version, replaced };
}

/** Pure: the notice for an outcome, or none when nothing changed. */
export function outcomeNotice(outcome: InstallOutcome): { readonly text: string; readonly level: "info" | "warning" } | undefined {
	switch (outcome.kind) {
		case "not-tern":
		case "current":
			return undefined;
		case "linked":
			return {
				level: "info",
				text:
					outcome.replaced === undefined
						? `unified-exec: installed its Tern plugin ${outcome.version}`
						: `unified-exec: updated its Tern plugin ${outcome.replaced} → ${outcome.version}`,
			};
		case "failed":
			return {
				level: "warning",
				text: `unified-exec: could not install its Tern plugin (${outcome.reason}); run \`tern plugin link ${TERN_PLUGIN_DIR}\``,
			};
	}
}

/**
 * On the first interactive omp session, make sure the Tern omp runs in has
 * the package's plugin, and report an install, update or failure.
 */
export function installTernPluginOnStart(pi: ExtensionAPI): void {
	let started = false;
	pi.on("session_start", async (_event, ctx) => {
		if (started || !ctx.hasUI) return;
		started = true;
		const notice = outcomeNotice(await ensureTernPlugin(process.env, readPluginFiles()));
		if (notice) ctx.ui.notify(notice.text, notice.level);
	});
}
