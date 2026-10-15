/**
 * What the extension knows about its host when it activates
 * (fork-features/README.md, "Embedded brush shell"). Pi hosts get the
 * unchanged process engines; omp hosts also get the services and native addon
 * the Brush engine needs.
 */
import type { TerminalAppearance } from "../../src/terminal-screen.ts";
import type { ProcessShell } from "../../src/shell.ts";
import type { HostBindingState } from "./binding.ts";
import type { BrushShells } from "./execution.ts";
import type { NativeLoad } from "./native.ts";
import type { HostSettings, OmpHost } from "./omp-host.ts";

/** Mutable execution resources owned by one omp plugin activation. */
export interface OmpEngine {
	readonly kind: "omp";
	readonly services: OmpHost;
	readonly native: NativeLoad;
	readonly warn: (message: string) => void;
	binding: HostBindingState;
	shells: BrushShells | undefined;
}

export type EngineHost = { readonly kind: "pi" } | OmpEngine;

/** The bound inputs for one execution, including omp's process backends. */
interface OmpExecutionContext {
	readonly host: "omp";
	readonly engine: OmpEngine;
	readonly settings: HostSettings;
}

type ProcessHost = { readonly host: "pi" } | OmpExecutionContext;

/** C1-checked backend selection, before cwd validation and shell resolution. */
export type EngineSelection =
	| ({ readonly kind: "brush" } & OmpExecutionContext)
	| ({ readonly kind: "pipe-process" } & ProcessHost)
	| ({ readonly kind: "pty-process" } & ProcessHost);

export type EngineVariant =
	| Extract<EngineSelection, { readonly kind: "brush" } | { readonly host: "pi" }>
	| (Extract<EngineSelection, { readonly host: "omp"; readonly kind: "pipe-process" | "pty-process" }> &
		{ readonly shell: ProcessShell });

export type HostRuntime =
	| { readonly kind: "pi" }
	| {
			readonly kind: "omp";
			/** omp's light/dark appearance, which tty sessions answer to OSC 10/11. */
			readonly appearance: () => TerminalAppearance;
			readonly services: OmpHost;
			/** The platform's addon, loaded once at activation. */
			readonly native: NativeLoad;
			/** omp's extension logger (`pi.logger.warn`). */
			readonly warn: (message: string) => void;
	  };

/** `pi.logger.warn` of an omp extension API. */
export function ompWarn(host: unknown): (message: string) => void {
	const logger = typeof host === "object" && host !== null && "logger" in host ? host.logger : undefined;
	const warn = typeof logger === "object" && logger !== null && "warn" in logger ? logger.warn : undefined;
	if (typeof warn !== "function") throw new Error("omp-unified-exec: the omp extension API lacks logger.warn()");
	return (message) => warn.call(logger, message);
}
