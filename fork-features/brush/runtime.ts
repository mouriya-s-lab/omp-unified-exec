/**
 * What the extension knows about its host when it activates
 * (fork-features/README.md, "Embedded brush shell"). Pi hosts get the
 * unchanged process engines; omp hosts also get the services and native addon
 * the Brush engine needs.
 */
import type { TerminalAppearance } from "../../src/terminal-screen.ts";
import type { NativeLoad } from "./native.ts";
import type { OmpHost } from "./omp-host.ts";

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
