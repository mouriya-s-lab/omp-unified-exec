/**
 * Tern terminal HUD (fork): live view of every tty session for omp's native
 * (Tern Surface Protocol) frontend.
 *
 * A pill in omp's dock counts the stored tty sessions, like omp's own
 * agents/jobs pills. Clicking it toggles a non-modal, full-width panel along
 * the top of the pane, short enough to leave the pill and composer uncovered:
 * one tab per tty session and the shown session's current screen as a grid.
 * A screen that fits scrolls vertically inside itself, following the newest
 * row, so the panel itself never scrolls; a wider one scrolls sideways.
 * The panel is read-only; input still goes through write_stdin.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. The HUD keeps no copy of either: every description re-reads
 * them, and subscriptions only ask omp to describe again.
 *
 * omp hoists an `overlay` node found in a component's description into the
 * surface `layer` (omp `packages/tui/src/native/reconcile.ts`), so the panel
 * needs no omp overlay (those take focus and render modal).
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
/** Key of the session tab strip; its `select` events pick the shown session. */
export const TABS_KEY = "tabs";
/** Key of the pill inside the HUD description. */
const PILL_KEY = "pill";
const WIDGET_KEY = "unified-exec-terminals";
const COMMAND_MAX = 120;
const TAB_COMMAND_MAX = 32;
/**
 * Cells the full-width panel loses to its inset and padding; a screen at most
 * `pane cols - this` wide draws unwrapped.
 */
export const PANEL_INSET_COLS = 6;
/** Panel height as a fraction of the pane, leaving the pill and composer clear below it. */
export const PANEL_MAX_HEIGHT = 0.6;
/** Lines of the panel not available to the screen: sheet head, tabs, status line, paddings. */
export const PANEL_CHROME_LINES = 8;
const MIN_SCREEN_LINES = 4;
const SGR = /\x1b\[[0-9;]*m/g;

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

/** The pane the panel spans, in cells (omp's terminal size). */
export interface PaneSize {
	readonly cols: number;
	readonly rows: number;
}

/** Lines the shown screen may take so the panel never scrolls as a whole. */
export function screenLineBudget(pane: PaneSize): number {
	return Math.max(MIN_SCREEN_LINES, Math.floor(pane.rows * PANEL_MAX_HEIGHT) - PANEL_CHROME_LINES);
}

/**
 * A terminal screen is a fixed grid; Tern's `ansi` reflows at the block width,
 * which breaks box lines and full-width backgrounds. A screen that fits the
 * panel draws as `ansi` (colors kept, never wrapped), bounded to the panel's
 * line budget so it scrolls vertically inside itself and follows the newest
 * row. A wider one draws as an unwrapped `code` block of the same rows, which
 * scrolls sideways; Tern's `code` has no own vertical scroll (bounding it only
 * clips), so a wider screen taller than the budget scrolls with the panel.
 */
function describeScreen(screen: StyledScreen, pane: PaneSize): HudNode {
	if (screen.view.cols <= pane.cols - PANEL_INSET_COLS) {
		return {
			k: "ansi",
			key: "screen",
			p: { text: screen.text, cols: screen.view.cols, follow: true, max: { h: `${screenLineBudget(pane)}lines` } },
		};
	}
	return { k: "code", key: "grid", p: { text: screen.text.replace(SGR, ""), lang: "text" } };
}

function stateSpan(state: TerminalState): { t: string; s: string } {
	if (state.kind === "running") return { t: "running", s: "accent" };
	return { t: exitNote(state), s: exitSucceeded(state) ? "muted" : "error" };
}

function shortCommand(command: string): string {
	return command.length <= TAB_COMMAND_MAX ? command : `${command.slice(0, TAB_COMMAND_MAX - 1)}…`;
}

/**
 * Pure: the HUD for the given tty sessions (ascending id). The pill always
 * shows; the panel only while `open`, with one tab per session and the screen
 * of the active one (`activeId`, else the first). Empty `entries` never reach
 * here: the widget is unmounted instead.
 */
export function describeTerminalHud(
	entries: readonly TerminalEntry[],
	open: boolean,
	pane: PaneSize,
	activeId?: number,
): HudNode {
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
	if (!open) return { k: "row", p: { role: "unified-exec.terminals", justify: "end" }, c: [pill] };

	const active = entries.find((entry) => entry.id === activeId) ?? entries[0]!;
	const tabs: HudNode = {
		k: "tabs",
		key: TABS_KEY,
		p: {
			active: `s${active.id}`,
			items: entries.map((entry) => ({
				id: `s${entry.id}`,
				label: [
					{ t: `#${entry.id} `, s: "muted" },
					{ t: shortCommand(entry.command) },
					...(entry.state.kind === "exited" ? [{ t: " " }, stateSpan(entry.state)] : []),
				],
			})),
		},
	};
	const status: HudNode = {
		k: "text",
		key: "status",
		p: {
			wrap: "none",
			truncate: "end",
			spans: [{ t: `#${active.id} `, s: "muted" }, { t: active.command, s: "mono" }, { t: "  " }, stateSpan(active.state)],
		},
	};
	// Full width so typical screens fit unwrapped; bounded height so the pill
	// (to close it) and the composer stay uncovered below.
	const panel: HudNode = {
		k: "overlay",
		key: "panel",
		p: { anchor: "top", size: "full", max: { h: PANEL_MAX_HEIGHT }, head: "Terminals" },
		c: [{ k: "col", key: "body", p: { gap: "sm" }, c: [tabs, status, describeScreen(active.screen, pane)] }],
	};
	return { k: "row", p: { role: "unified-exec.terminals", justify: "end" }, c: [pill, panel] };
}

// ---------------- component ----------------

/** The HUD's own user events, parsed from omp's native events. */
type HudEvent = { readonly kind: "toggle" } | { readonly kind: "select"; readonly id: number };

function parseHudEvent(event: unknown): HudEvent | undefined {
	if (typeof event !== "object" || event === null || !("type" in event)) return undefined;
	if (event.type === "action" && "act" in event && event.act === TOGGLE_ACTION) return { kind: "toggle" };
	if (event.type === "select" && "key" in event && typeof event.key === "string" && "item" in event) {
		const id = typeof event.item === "string" && /^s\d+$/.test(event.item) ? Number(event.item.slice(1)) : NaN;
		// omp reports the node's keypath; the tab strip is the only `select` source here.
		if (event.key.endsWith(TABS_KEY) && Number.isSafeInteger(id)) return { kind: "select", id };
	}
	return undefined;
}

/**
 * The dock widget. omp calls `describe` instead of `render` while Tern renders
 * natively; it is only mounted then, so `render` draws nothing.
 */
class TerminalHud implements Component {
	private open = false;
	/** Session shown in the panel; falls back to the first when it is gone. */
	private activeId: number | undefined;
	private described: { readonly cols: number; readonly rows: number; readonly node: HudNode } | undefined;
	/** Per tty session: exit always (pill spinner, tab state); screen changes only for the shown one while open. */
	private readonly watches = new Map<number, { readonly exit: () => void; screen: (() => void) | undefined }>();

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
		private readonly paneRows: () => number,
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
		const sessions = this.ttySessions();
		const shown = sessions.find((session) => session.id === this.activeId) ?? sessions[0];
		const live = new Set<number>();
		for (const session of sessions) {
			live.add(session.id);
			let watch = this.watches.get(session.id);
			if (!watch) {
				watch = { exit: session.onExit(this.changed), screen: undefined };
				this.watches.set(session.id, watch);
			}
			const wantScreen = this.open && session === shown;
			if (wantScreen && !watch.screen) watch.screen = session.onScreenChange(this.changed);
			if (!wantScreen && watch.screen) {
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

	/** omp passes its describe context; only the surface width is read, the height comes from omp's terminal. */
	describe(cx: { readonly cols: number }): HudNode {
		const rows = this.paneRows();
		if (this.described?.cols !== cx.cols || this.described.rows !== rows) {
			const entries = this.ttySessions().flatMap((session) => {
				const screen = session.styledScreen();
				return screen ? [terminalEntry(session, screen)] : [];
			});
			const node = describeTerminalHud(entries, this.open, { cols: cx.cols, rows }, this.activeId);
			this.described = { cols: cx.cols, rows, node };
		}
		return this.described.node;
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (!parsed) return;
		switch (parsed.kind) {
			case "toggle":
				this.open = !this.open;
				break;
			case "select":
				this.activeId = parsed.id;
				break;
		}
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
				hud = new TerminalHud(store, () => tui.requestRender(), () => tui.terminal.rows);
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
