/**
 * Tern terminal HUD (fork): live view of every tty session for omp's native
 * (Tern Surface Protocol) frontend.
 *
 * A chip at the pane's top-left counts the stored tty sessions. Clicking it
 * opens the Terminals sheet, built the way omp's own Background jobs sheet is
 * (omp `packages/tui/src/overlays/jobs-panel.ts`): a centred glass sheet with
 * a selectable list of sessions, the selected session's current screen, and
 * a Close button mirroring Esc. The chip adds no row to omp's dock. The sheet
 * is read-only; input still goes through write_stdin.
 *
 * Authority: each session's TerminalScreen (src/terminal-screen.ts) and the
 * SessionStore. Neither the chip nor the sheet keeps a copy of either: every
 * description re-reads them, and subscriptions only ask omp to describe again.
 *
 * omp hoists an `overlay` node found in a component's description into the
 * surface `layer` (omp `packages/tui/src/native/reconcile.ts`), so the chip
 * floats without a dock row. The sheet is an extension custom overlay
 * (`ctx.ui.custom(..., { overlay: true })`), which omp focuses and draws
 * from the component's `nativeOverlay`, like every omp sheet.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";

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

/** The sheet frame omp reads from an overlay component (omp `Component.nativeOverlay`). */
export interface SheetFrame {
	readonly role: string;
	readonly size: "lg" | "full";
	readonly anchor: "center";
	readonly head: string;
}

/** The action the chip's click sends to the chip component (not a Tern built-in action name). */
export const OPEN_ACTION = "unified-exec.terminals.open";
/** The action of the sheet's Close button; Esc runs the same path. */
export const CLOSE_ACTION = "close";
/** Key of the sheet's session list; its `select`/`activate` events pick the shown session. */
export const LIST_KEY = "terminals";
const WIDGET_KEY = "unified-exec-terminals";
const COMMAND_MAX = 120;
/** Width of the chip, in cells (icon, spinner and "N terminals"). */
const CHIP_COLS = 22;
/** Cells the sheet body adds around the shown screen. */
export const SHEET_INSET_COLS = 4;
/** Widest screen, in cells, a `lg` sheet (720px) shows unwrapped; wider screens get a `full` sheet, like omp's Console. */
export const LG_SCREEN_COLS = 88;
/** Screen lines a `lg` sheet shows before the screen scrolls inside itself (omp's jobs output uses the same). */
export const LG_SCREEN_LINES = 16;
/**
 * Measured Tern geometry of a `full` sheet, in text lines of 16px: the
 * sheet's offset, title and body padding above the list plus the status row
 * and the action bar below it come to 7 lines; each list row is 22px.
 */
const FULL_CHROME_LINES = 7;
const LIST_ROW_PX = 22;
const LINE_PX = 16;
/** Lines a `code` grid spends besides its rows: its padding and the hidden-rows note. */
const CODE_CHROME_LINES = 3;
/** Session rows the list shows before it scrolls (omp's jobs list uses the same). */
const LIST_LINES = 6;
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

/** The pane the sheet spans, in cells (omp's terminal size). */
export interface PaneSize {
	readonly cols: number;
	readonly rows: number;
}

type Span = { readonly t: string; readonly s?: string; readonly fx?: string };

/** Status dot, as omp's jobs sheet draws it. */
function stateDot(state: TerminalState): Span {
	if (state.kind === "running") return { t: "●", s: "accent", fx: "pulse" };
	return { t: "●", s: exitSucceeded(state) ? "success" : "error" };
}

function stateSpan(state: TerminalState): Span {
	if (state.kind === "running") return { t: "running", s: "accent" };
	return { t: exitNote(state), s: exitSucceeded(state) ? "muted" : "error" };
}

/** Item key of a session in the list; `select` events report it back. */
function itemKey(id: number): string {
	return `s${id}`;
}

/**
 * The sheet size the listed screens need: `lg` unless one is wider than a
 * `lg` sheet shows unwrapped, then `full`, as omp's Console sheet. One size
 * for every session, so selecting another never resizes the sheet.
 */
export function sheetSize(entries: readonly TerminalEntry[]): SheetFrame["size"] {
	return entries.every((entry) => entry.screen.view.cols <= LG_SCREEN_COLS) ? "lg" : "full";
}

/** Lines the shown screen takes before it scrolls inside itself (`lg`) or fills the sheet (`full`). */
export function screenLineBudget(size: SheetFrame["size"], pane: PaneSize, listRows: number): number {
	if (size === "lg") return LG_SCREEN_LINES;
	const listLines = Math.ceil((Math.min(listRows, LIST_LINES) * LIST_ROW_PX) / LINE_PX);
	return Math.max(LG_SCREEN_LINES, pane.rows - FULL_CHROME_LINES - listLines);
}

/**
 * A terminal screen is a fixed grid; Tern's `ansi` reflows at the block width,
 * which breaks box lines and full-width backgrounds. A screen that fits the
 * sheet draws as `ansi` (colors kept, never wrapped), bounded to the line
 * budget so it scrolls vertically inside itself and follows the newest row.
 * A wider one draws as an unwrapped `code` block of the same rows, which
 * scrolls sideways. Tern's `code` has no vertical scroll of its own, so a
 * wider screen keeps its newest `budget` rows (where a terminal's cursor and
 * prompt live) and says how many rows above are hidden.
 */
function describeScreen(screen: StyledScreen, fits: boolean, budget: number): HudNode[] {
	if (fits) {
		return [{ k: "ansi", p: { text: screen.text, cols: screen.view.cols, follow: true, max: { h: `${budget}lines` } } }];
	}
	const rows = screen.text.replace(SGR, "").split("\n");
	const hidden = Math.max(0, rows.length - budget);
	const grid: HudNode = { k: "code", key: "grid", p: { text: rows.slice(hidden).join("\n"), lang: "text" } };
	if (hidden === 0) return [grid];
	return [
		{
			k: "text",
			key: "hidden",
			p: { wrap: "none", spans: [{ t: `${hidden} rows above hidden — widen the window to see the whole screen`, s: "muted" }] },
		},
		grid,
	];
}

/**
 * Pure: the chip for the given tty sessions (ascending id). Empty `entries`
 * never reach here: the widget is unmounted instead. The widget's root holds
 * only the chip's overlay, which omp hoists into the TSP `layer`, so it adds
 * no row to omp's dock and never moves the activity line, todo HUD, meter or
 * composer. `max.w` narrows the `sm` sheet, which also pins it left.
 */
export function describeTerminalChip(entries: readonly TerminalEntry[]): HudNode {
	const running = entries.some((entry) => entry.state.kind === "running");
	const pill: HudNode = {
		k: "row",
		key: "pill",
		p: {
			role: "omp.hud.pill",
			gap: "xs",
			align: "center",
			basis: "content",
			title: "Show terminals",
			actions: { click: OPEN_ACTION },
		},
		c: [
			{ k: "icon", key: "icon", p: { name: "terminal" } },
			...(running ? [{ k: "spinner", key: "spinner", p: { style: "dots", tone: "accent" } }] : []),
			{
				k: "text",
				key: "label",
				p: { text: `${entries.length} ${entries.length === 1 ? "terminal" : "terminals"}`, wrap: "none" },
			},
		],
	};
	return {
		k: "col",
		p: { role: "unified-exec.terminals" },
		c: [{ k: "overlay", key: "chip", p: { anchor: "top", size: "sm", max: { w: `${CHIP_COLS}ch` }, head: "" }, c: [pill] }],
	};
}

/**
 * Pure: the Terminals sheet body, shaped like omp's Background jobs sheet:
 * the session list, the selected session's status and screen, and the action
 * bar. The detail is keyed per session, so switching sessions mounts a fresh
 * screen that starts at its newest row instead of inheriting the previous
 * session's scroll offset.
 */
export function describeTerminalsSheet(entries: readonly TerminalEntry[], selected: TerminalEntry | undefined, pane: PaneSize): HudNode {
	const list: HudNode = {
		k: "list",
		key: LIST_KEY,
		p: {
			selected: selected ? itemKey(selected.id) : null,
			empty: "No terminals",
			max: { lines: LIST_LINES },
			actions: { click: "select", dblclick: "activate" },
		},
		c: entries.map((entry) => ({
			k: "item",
			key: itemKey(entry.id),
			p: {
				label: [stateDot(entry.state), { t: " " }, { t: entry.command }],
				value: [{ t: `#${entry.id}`, s: "dim" }],
				title: `#${entry.id} · ${entry.command}`,
			},
		})),
	};
	const close: HudNode = {
		k: "row",
		key: CLOSE_ACTION,
		p: { role: "omp.btn", gap: "xs", align: "center", actions: { click: CLOSE_ACTION }, title: "Close  Esc" },
		c: [
			{ k: "text", p: { text: "Close" } },
			{ k: "kbd", p: { keys: ["escape"] } },
		],
	};
	const actions: HudNode = {
		k: "row",
		key: "actions",
		p: { role: "omp.actions", gap: "sm", align: "center" },
		c: [{ k: "spacer", p: { grow: 1 } }, close],
	};
	const children: HudNode[] = [list];
	if (selected) {
		const size = sheetSize(entries);
		const view = selected.screen.view;
		const sheetCols = size === "lg" ? LG_SCREEN_COLS : pane.cols;
		const fits = view.cols + SHEET_INSET_COLS <= sheetCols;
		const budget = screenLineBudget(size, pane, entries.length) - (fits ? 0 : CODE_CHROME_LINES);
		const status: HudNode = {
			k: "text",
			key: "status",
			p: {
				wrap: "none",
				truncate: "end",
				spans: [
					stateDot(selected.state),
					{ t: " " },
					{ ...stateSpan(selected.state), s: "strong" },
					{ t: ` · #${selected.id} · ${view.cols}×${view.rows}`, s: "muted" },
				],
			},
		};
		children.push({
			k: "col",
			key: `detail-${itemKey(selected.id)}`,
			p: { gap: "sm", role: "unified-exec.terminals.detail" },
			c: [status, ...describeScreen(selected.screen, fits, budget)],
		});
	}
	children.push(actions);
	return { k: "col", p: { gap: "md" }, c: children };
}

// ---------------- components ----------------

/** A user event from omp's native events, parsed at the boundary. */
type ChipEvent = { readonly kind: "open" };
type SheetEvent = { readonly kind: "close" } | { readonly kind: "select"; readonly id: number };

function parseChipEvent(event: unknown): ChipEvent | undefined {
	if (typeof event !== "object" || event === null || !("type" in event) || !("act" in event)) return undefined;
	if (event.type === "action" && event.act === OPEN_ACTION) return { kind: "open" };
	return undefined;
}

function parseSheetEvent(event: unknown): SheetEvent | undefined {
	if (typeof event !== "object" || event === null || !("type" in event)) return undefined;
	if (event.type === "action" && "act" in event && event.act === CLOSE_ACTION) return { kind: "close" };
	if ((event.type === "select" || event.type === "activate") && "item" in event && typeof event.item === "string") {
		const id = /^s\d+$/.test(event.item) ? Number(event.item.slice(1)) : NaN;
		if (Number.isSafeInteger(id)) return { kind: "select", id };
	}
	return undefined;
}

function ttySessions(store: SessionStore): ExecSession[] {
	return store
		.values()
		.filter((session) => session.tty)
		.sort((a, b) => a.id - b.id);
}

function terminalEntries(store: SessionStore): TerminalEntry[] {
	return ttySessions(store).flatMap((session) => {
		const screen = session.styledScreen();
		return screen ? [terminalEntry(session, screen)] : [];
	});
}

/**
 * The dock widget: only the chip. omp calls `describe` instead of `render`
 * while Tern renders natively; it is only mounted then, so `render` draws nothing.
 */
class TerminalChip implements Component {
	private described: HudNode | undefined;
	/** Per tty session: exit, which changes the chip's spinner. */
	private readonly exits = new Map<number, () => void>();

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
		private readonly open: () => void,
	) {
		this.syncWatches();
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private syncWatches(): void {
		const live = new Set<number>();
		for (const session of ttySessions(this.store)) {
			live.add(session.id);
			if (!this.exits.has(session.id)) this.exits.set(session.id, session.onExit(this.changed));
		}
		for (const [id, stop] of this.exits) {
			if (live.has(id)) continue;
			stop();
			this.exits.delete(id);
		}
	}

	/** The stored sessions changed. */
	membershipChanged(): void {
		this.syncWatches();
		this.changed();
	}

	describe(): HudNode {
		this.described ??= describeTerminalChip(terminalEntries(this.store));
		return this.described;
	}

	handleNativeEvent(event: unknown): void {
		if (parseChipEvent(event)) this.open();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		for (const stop of this.exits.values()) stop();
		this.exits.clear();
	}
}

/**
 * The Terminals sheet, an extension custom overlay. omp focuses it, routes
 * keys to `handleInput` and native events to `handleNativeEvent`, and draws
 * its frame from `nativeOverlay`. `render` is the ANSI fallback omp needs
 * from every overlay; the sheet is only opened while Tern renders natively.
 */
class TerminalsSheet implements Component {
	private selectedId: number | undefined;
	private described: { readonly cols: number; readonly rows: number; readonly node: HudNode } | undefined;
	private readonly unsubscribe: () => void;
	private screenWatch: { readonly id: number; readonly stop: () => void } | undefined;
	private readonly exits = new Map<number, () => void>();

	constructor(
		private readonly store: SessionStore,
		private readonly pane: () => PaneSize,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {
		this.unsubscribe = store.subscribe(this.changed);
		this.syncWatches();
	}

	private changed = (): void => {
		this.syncWatches();
		this.described = undefined;
		this.requestRender();
	};

	/** The listed entries and the selected one (the first when the selection left). */
	private current(): { entries: TerminalEntry[]; selected: TerminalEntry | undefined } {
		const entries = terminalEntries(this.store);
		const selected = entries.find((entry) => entry.id === this.selectedId) ?? entries[0];
		this.selectedId = selected?.id;
		return { entries, selected };
	}

	/** Watch every session's exit (list dots) and only the selected session's screen. */
	private syncWatches(): void {
		const sessions = ttySessions(this.store);
		const live = new Set(sessions.map((session) => session.id));
		for (const session of sessions) {
			if (!this.exits.has(session.id)) this.exits.set(session.id, session.onExit(this.changed));
		}
		for (const [id, stop] of this.exits) {
			if (live.has(id)) continue;
			stop();
			this.exits.delete(id);
		}
		const shown = sessions.find((session) => session.id === this.selectedId) ?? sessions[0];
		if (this.screenWatch?.id === shown?.id) return;
		this.screenWatch?.stop();
		this.screenWatch = shown ? { id: shown.id, stop: shown.onScreenChange(this.changed) } : undefined;
	}

	get nativeOverlay(): SheetFrame {
		const { selected } = this.current();
		return {
			role: "unified-exec.overlay.terminals",
			size: sheetSize(this.current().entries),
			anchor: "center",
			head: "Terminals",
		};
	}

	describe(): HudNode {
		const pane = this.pane();
		if (this.described?.cols !== pane.cols || this.described.rows !== pane.rows) {
			const { entries, selected } = this.current();
			this.described = { ...pane, node: describeTerminalsSheet(entries, selected, pane) };
		}
		return this.described.node;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.close();
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseSheetEvent(event);
		if (!parsed) return;
		switch (parsed.kind) {
			case "close":
				this.close();
				return;
			case "select":
				this.select(parsed.id);
				return;
		}
	}

	private move(delta: number): void {
		const { entries, selected } = this.current();
		if (!selected) return;
		const index = Math.max(0, Math.min(entries.length - 1, entries.indexOf(selected) + delta));
		this.select(entries[index]!.id);
	}

	private select(id: number): void {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.changed();
	}

	render(width: number): string[] {
		const { entries, selected } = this.current();
		const lines = entries.map((entry) => `${entry === selected ? ">" : " "} #${entry.id} ${entry.command}`);
		return [" Terminals", ...lines].map((line) => line.slice(0, width));
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		this.unsubscribe();
		this.screenWatch?.stop();
		this.screenWatch = undefined;
		for (const stop of this.exits.values()) stop();
		this.exits.clear();
	}
}

// ---------------- mounting ----------------

/** Load omp's native rendering flag; fails when omp no longer provides it. */
export async function loadNativeRenderingState(): Promise<NativeRenderingState> {
	// Dynamic: this module exists only inside omp, so a static import would break Pi hosts.
	return parseNativeRenderingState(await import("@oh-my-pi/pi-tui/native/state"));
}

/**
 * Keep the chip mounted in omp's dock exactly while omp renders natively and
 * the store holds a tty session; the ANSI TUI never gets a widget (and so no
 * spacer row). The chip opens the Terminals sheet; one sheet at a time.
 */
export function mountTerminalHud(pi: ExtensionAPI, store: SessionStore, native: NativeRenderingState): void {
	let ui: ExtensionContext["ui"] | undefined;
	let chip: TerminalChip | undefined;
	let sheetOpen = false;

	const openSheet = (): void => {
		if (!ui || sheetOpen) return;
		sheetOpen = true;
		void ui
			.custom<void>(
				(tui, _theme, _keybindings, done) =>
					new TerminalsSheet(
						store,
						() => ({ cols: tui.terminal.columns, rows: tui.terminal.rows }),
						() => tui.requestRender(),
						() => done(undefined),
					),
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
			)
			.finally(() => {
				sheetOpen = false;
			});
	};

	const unmount = (): void => {
		if (!chip) return;
		chip = undefined;
		// omp disposes the removed widget component.
		ui?.setWidget(WIDGET_KEY, undefined);
	};

	const sync = (): void => {
		const wanted = ui !== undefined && native.isNativeRendering() && store.values().some((session) => session.tty);
		if (!wanted) {
			unmount();
			return;
		}
		if (chip) {
			chip.membershipChanged();
			return;
		}
		ui?.setWidget(
			WIDGET_KEY,
			(tui) => {
				chip = new TerminalChip(store, () => tui.requestRender(), openSheet);
				return chip;
			},
			// `belowEditor`: omp adds no spacer for it, and a root holding only
			// overlays takes no height, so the dock keeps its native layout.
			{ placement: "belowEditor" },
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
