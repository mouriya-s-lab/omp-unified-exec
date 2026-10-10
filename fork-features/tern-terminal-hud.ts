/**
 * Tern terminal HUD (fork): live view of every tty session for omp's native
 * (Tern Surface Protocol) frontend.
 *
 * A pill in omp's dock counts the stored tty sessions, like omp's own
 * agents/jobs pills. Clicking it toggles a non-modal panel floating above the
 * pill: one collapsible card per tty session with its current screen in color.
 * The panel is read-only; input still goes through write_stdin.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. The HUD keeps no copy of either: every description re-reads
 * them, and subscriptions only ask omp to describe again.
 *
 * omp hoists an `overlay` node found in a component's description into the
 * surface `layer` and resolves `anchor.node` against the component's own
 * keypaths (omp `packages/tui/src/native/reconcile.ts`), so the panel needs no
 * omp overlay (those take focus and render modal).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { sanitizeOutputText } from "../src/output-safety.ts";
import type { ExecSession } from "../src/session.ts";
import type { SessionStore } from "../src/session-store.ts";
import type { StyledScreen } from "../src/terminal-screen.ts";

// ---------------- omp native contract ----------------

/** omp's process-wide "a TSP surface is live" flag. */
export interface NativeRenderingState {
	isNativeRendering(): boolean;
	onNativeRenderingChange(listener: (on: boolean) => void): () => void;
}

function parseNativeRenderingState(value: { readonly [K in keyof NativeRenderingState]?: unknown }): NativeRenderingState {
	const { isNativeRendering, onNativeRenderingChange } = value;
	if (typeof isNativeRendering !== "function" || typeof onNativeRenderingChange !== "function") {
		throw new Error(
			"omp-unified-exec: @oh-my-pi/pi-tui/native/state no longer provides isNativeRendering/onNativeRenderingChange; requalify fork-features/tern-terminal-hud.ts for this omp version",
		);
	}
	return {
		isNativeRendering: () => isNativeRendering() === true,
		onNativeRenderingChange: (listener) => onNativeRenderingChange(listener) as () => void,
	};
}

/** A described node in omp's native view format (TSP node without its wire id). */
export interface HudNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly HudNode[];
	readonly key?: string;
}

/** The action a pill click sends to the HUD component. */
export const TOGGLE_ACTION = "unified-exec.terminals.toggle";
/** Keypath of the pill inside the HUD description; the panel anchors to it. */
const PILL_KEY = "pill";
const WIDGET_KEY = "unified-exec-terminals";
const COMMAND_MAX = 120;

// ---------------- view model ----------------

export type TerminalState =
	| { readonly kind: "running" }
	| {
			readonly kind: "exited";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly failure: string | null;
	  };

export interface TerminalEntry {
	readonly id: number;
	readonly command: string;
	readonly state: TerminalState;
	readonly screen: StyledScreen;
}

function oneLine(command: string): string {
	const line = sanitizeOutputText(command).replace(/\s+/g, " ").trim();
	return line.length <= COMMAND_MAX ? line : `${line.slice(0, COMMAND_MAX - 1)}…`;
}

function terminalEntry(session: ExecSession, screen: StyledScreen): TerminalEntry {
	const state: TerminalState = session.hasExited
		? { kind: "exited", exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage }
		: { kind: "running" };
	return { id: session.id, command: oneLine(session.displayCommand), state, screen };
}

function exitSucceeded(state: Extract<TerminalState, { kind: "exited" }>): boolean {
	return state.exitCode === 0 && state.signal === null && state.failure === null;
}

function exitNote(state: Extract<TerminalState, { kind: "exited" }>): string {
	if (state.failure !== null) return `failed: ${oneLine(state.failure)}`;
	if (state.signal !== null) return state.signal;
	return state.exitCode === null ? "exited" : `exit ${state.exitCode}`;
}

function describeCard(entry: TerminalEntry): HudNode {
	const { state } = entry;
	const head = [
		{ t: `#${entry.id} `, s: "muted" },
		{ t: entry.command, s: "mono" },
		...(state.kind === "exited" ? [{ t: `  ${exitNote(state)}`, s: exitSucceeded(state) ? "muted" : "error" }] : []),
	];
	const status = state.kind === "running" ? "running" : exitSucceeded(state) ? "done" : "error";
	return {
		k: "card",
		key: `s${entry.id}`,
		p: {
			// The `bash` role segment picks Tern's terminal icon.
			role: "unified-exec.bash",
			head,
			status,
			...(status === "error" ? { tone: "error" } : {}),
			collapsible: true,
		},
		c: [{ k: "ansi", key: "screen", p: { text: entry.screen.text, cols: entry.screen.view.cols } }],
	};
}

/**
 * Pure: the HUD for the given tty sessions (ascending id). The pill always
 * shows; the panel only while `open`. Empty `entries` never reach here: the
 * widget is unmounted instead.
 */
export function describeTerminalHud(entries: readonly TerminalEntry[], open: boolean): HudNode {
	const running = entries.filter((entry) => entry.state.kind === "running").length;
	const pill: HudNode = {
		k: "row",
		key: PILL_KEY,
		p: {
			role: "omp.hud.pill",
			gap: "xs",
			align: "center",
			title: open ? "Hide terminals" : "Show terminals",
			actions: { click: TOGGLE_ACTION },
		},
		c: [
			{ k: "icon", key: "icon", p: { name: "terminal" } },
			...(running > 0 ? [{ k: "spinner", key: "spinner", p: { style: "dots", tone: "accent" } }] : []),
			{
				k: "text",
				key: "label",
				p: { text: `${entries.length} ${entries.length === 1 ? "terminal" : "terminals"}`, wrap: "none" },
			},
		],
	};
	const panel: HudNode = {
		k: "overlay",
		key: "panel",
		p: { anchor: { node: PILL_KEY, side: "above" }, size: "lg", head: "Terminals" },
		c: [{ k: "col", key: "cards", p: { gap: "sm" }, c: entries.map(describeCard) }],
	};
	return {
		k: "row",
		p: { role: "unified-exec.terminals", justify: "end" },
		c: open ? [pill, panel] : [pill],
	};
}

// ---------------- component ----------------

function isToggle(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		event.type === "action" &&
		"act" in event &&
		event.act === TOGGLE_ACTION
	);
}

/**
 * The dock widget. omp calls `describe` instead of `render` while Tern renders
 * natively; it is only mounted then, so `render` draws nothing.
 */
class TerminalHud implements Component {
	private open = false;
	private described: HudNode | undefined;
	/** Per tty session: exit always (the pill's spinner), screen changes while the panel is open. */
	private readonly watches = new Map<number, { readonly exit: () => void; screen: (() => void) | undefined }>();

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
	) {
		this.syncWatches();
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private ttySessions(): ExecSession[] {
		return this.store
			.values()
			.filter((session) => session.tty)
			.sort((a, b) => a.id - b.id);
	}

	/** Watch exactly the stored tty sessions; drop watches of removed ones. */
	private syncWatches(): void {
		const live = new Set<number>();
		for (const session of this.ttySessions()) {
			live.add(session.id);
			let watch = this.watches.get(session.id);
			if (!watch) {
				watch = { exit: session.onExit(this.changed), screen: undefined };
				this.watches.set(session.id, watch);
			}
			if (this.open && !watch.screen) watch.screen = session.onScreenChange(this.changed);
			if (!this.open && watch.screen) {
				watch.screen();
				watch.screen = undefined;
			}
		}
		for (const [id, watch] of this.watches) {
			if (live.has(id)) continue;
			watch.exit();
			watch.screen?.();
			this.watches.delete(id);
		}
	}

	/** The stored sessions changed. */
	membershipChanged(): void {
		this.syncWatches();
		this.changed();
	}

	describe(): HudNode {
		this.described ??= describeTerminalHud(
			this.ttySessions().flatMap((session) => {
				const screen = session.styledScreen();
				return screen ? [terminalEntry(session, screen)] : [];
			}),
			this.open,
		);
		return this.described;
	}

	handleNativeEvent(event: unknown): void {
		if (!isToggle(event)) return;
		this.open = !this.open;
		this.syncWatches();
		this.changed();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		this.open = false;
		for (const watch of this.watches.values()) {
			watch.exit();
			watch.screen?.();
		}
		this.watches.clear();
	}
}

// ---------------- mounting ----------------

/** Load omp's native rendering flag; fails when omp no longer provides it. */
export async function loadNativeRenderingState(): Promise<NativeRenderingState> {
	// Dynamic: this module exists only inside omp, so a static import would break Pi hosts.
	return parseNativeRenderingState(await import("@oh-my-pi/pi-tui/native/state"));
}

/**
 * Keep the HUD mounted in omp's dock exactly while omp renders natively and
 * the store holds a tty session; the ANSI TUI never gets a widget (and so no
 * spacer row).
 */
export function mountTerminalHud(pi: ExtensionAPI, store: SessionStore, native: NativeRenderingState): void {
	let ui: ExtensionContext["ui"] | undefined;
	let hud: TerminalHud | undefined;

	const unmount = (): void => {
		if (!hud) return;
		hud = undefined;
		// omp disposes the removed widget component.
		ui?.setWidget(WIDGET_KEY, undefined);
	};

	const sync = (): void => {
		const wanted = ui !== undefined && native.isNativeRendering() && store.values().some((session) => session.tty);
		if (!wanted) {
			unmount();
			return;
		}
		if (hud) {
			hud.membershipChanged();
			return;
		}
		ui?.setWidget(
			WIDGET_KEY,
			(tui) => {
				hud = new TerminalHud(store, () => tui.requestRender());
				return hud;
			},
			{ placement: "aboveEditor" },
		);
	};

	store.subscribe(sync);
	native.onNativeRenderingChange(sync);
	pi.on("session_start", async (_event, eventCtx) => {
		unmount();
		ui = eventCtx.hasUI ? eventCtx.ui : undefined;
		sync();
	});
	pi.on("session_shutdown", async () => {
		unmount();
		ui = undefined;
	});
}
