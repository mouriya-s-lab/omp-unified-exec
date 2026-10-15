import { sanitizeOutputText } from "../src/output-safety.ts";
import { parseTerminalTarget, readTerminal, terminalRegistry, terminalText } from "./terminal-resource.ts";

interface TerminalUrlHandler {
	readonly scheme: "term";
	readonly spec: { readonly backing: "virtual"; readonly selectors: "lines"; readonly immutable: false };
	resolve(url: URL): Promise<{ url: string; content: string; contentType: "text/plain"; immutable: false }>;
}

interface TerminalUrlRouter {
	register(handler: TerminalUrlHandler): void;
}

/** Register against omp's process-level router, never a plugin-local SDK copy. */
export async function initializeTerminalUrls(): Promise<void> {
	// This host-only subpath does not exist in the Node/Pi development runtime.
	const module = await import("@oh-my-pi/pi-coding-agent/internal-urls");
	// Check after the import: concurrent activations may share that await.
	if (terminalRegistry.registration === "registered") return;
	const Router = module.InternalUrlRouter as { instance?: unknown } | undefined;
	if (!Router || typeof Router.instance !== "function") {
		throw new Error("omp-unified-exec: internal-urls lacks InternalUrlRouter.instance; requalify term:// integration");
	}
	const router: unknown = Router.instance();
	if (typeof router !== "object" || router === null || !("register" in router) || typeof router.register !== "function") {
		throw new Error("omp-unified-exec: InternalUrlRouter lacks register; requalify term:// integration");
	}
	const handler: TerminalUrlHandler = {
		scheme: "term",
		spec: { backing: "virtual", selectors: "lines", immutable: false },
		async resolve(url) {
			const projection = await readTerminal(url.hostname);
			const target = parseTerminalTarget(url.pathname);
			return { url: url.href, content: sanitizeOutputText(terminalText(projection, target)), contentType: "text/plain", immutable: false };
		},
	};
	(router as TerminalUrlRouter).register(handler);
	terminalRegistry.registration = "registered";
}
