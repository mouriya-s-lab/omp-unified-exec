// Ambient script (no top-level import/export): the module exists only inside
// oh-my-pi, so its value is parsed at runtime by omp-presentation.ts.
declare module "@oh-my-pi/pi-tui/tools" {
	export const toolRenderers: Readonly<Record<string, unknown>>;
}
