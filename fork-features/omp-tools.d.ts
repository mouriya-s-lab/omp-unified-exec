// Ambient script (no top-level import/export): these modules exist only inside
// oh-my-pi, so their values are parsed at runtime by omp-presentation.ts and
// tern-terminal-hud.ts.
declare module "@oh-my-pi/pi-tui/tools" {
	export const toolRenderers: Readonly<Record<string, unknown>>;
}

declare module "@oh-my-pi/pi-tui/native/state" {
	export const isNativeRendering: unknown;
	export const onNativeRenderingChange: unknown;
}
