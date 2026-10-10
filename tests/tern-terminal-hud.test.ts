import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLOSE_ACTION,
	describeTerminalChip,
	describeTerminalsSheet,
	LG_SCREEN_COLS,
	LG_SCREEN_LINES,
	LIST_KEY,
	mountTerminalHud,
	OPEN_ACTION,
	screenLineBudget,
	SHEET_INSET_COLS,
	sheetSize,
	type HudNode,
	type NativeRenderingState,
	type TerminalEntry,
	type TerminalState,
} from "../fork-features/tern-terminal-hud.ts";
import { getPtyLoadError, isPtyAvailable } from "../src/pty.ts";
import { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";

function nodesOfKind(node: HudNode, kind: string): HudNode[] {
	return [...(node.k === kind ? [node] : []), ...(node.c ?? []).flatMap((child) => nodesOfKind(child, kind))];
}

function onlyNode(node: HudNode, kind: string): HudNode {
	const matches = nodesOfKind(node, kind);
	assert.equal(matches.length, 1, `expected one ${kind} node`);
	return matches[0]!;
}

function entry(id: number, state: TerminalState): TerminalEntry {
	return {
		id,
		command: `command-${id}`,
		state,
		screen: {
			text: `screen-${id}`,
			view: { screen: "normal", cols: 80, rows: 24, cursor: { row: 1, col: 1 } },
		},
	};
}

function styledEntry(id: number, cols: number): TerminalEntry {
	const value = entry(id, { kind: "running" });
	const rows = [
		`\x1b[31m${"a".repeat(cols - 1)}|\x1b[0m`,
		`\x1b[1;34m${"b".repeat(cols - 1)}]\x1b[m`,
		`\x1b[38;2;12;34;56m${"c".repeat(cols - 1)}>\x1b[0m`,
	];
	return {
		...value,
		screen: {
			text: rows.join("\n"),
			view: { ...value.screen.view, cols, rows: rows.length },
		},
	};
}

function exited(exitCode: number | null): TerminalState {
	return { kind: "exited", exitCode, signal: null, failure: null };
}

function pillOf(node: HudNode): HudNode {
	const pills = nodesOfKind(node, "row").filter((child) => child.p?.role === "omp.hud.pill");
	assert.equal(pills.length, 1, "chip contains exactly one interactive pill");
	return pills[0]!;
}

function overlayOf(node: HudNode): HudNode {
	assert.equal(node.k, "col");
	const overlay = onlyNode(node, "overlay");
	assert.deepEqual(node.c, [overlay], "chip contributes no non-overlay dock child");
	return overlay;
}

function detailOf(node: HudNode): HudNode {
	const details = nodesOfKind(node, "col").filter((child) => child.p?.role === "unified-exec.terminals.detail");
	assert.equal(details.length, 1, "sheet shows only the selected session's detail");
	return details[0]!;
}

function ansiText(node: HudNode): string {
	const text = onlyNode(node, "ansi").p?.text;
	assert.ok(typeof text === "string");
	return text;
}

function labelText(node: HudNode): unknown {
	return nodesOfKind(node, "text").find((text) => text.key === "label")?.p?.text;
}

describe("terminal chip description", () => {
	it("keeps only the actionable pill overlay in the dock root", () => {
		const view = describeTerminalChip([entry(7, { kind: "running" })]);
		const overlay = overlayOf(view);
		const pill = pillOf(view);
		assert.equal(overlay.key, "chip");
		assert.equal(overlay.p?.anchor, "top");
		assert.equal(overlay.p?.size, "sm");
		assert.deepEqual(overlay.p?.max, { w: "22ch" });
		assert.deepEqual(overlay.c, [pill]);
		assert.deepEqual(pill.p?.actions, { click: OPEN_ACTION });
		assert.equal(nodesOfKind(view, "list").length, 0);
		assert.equal(nodesOfKind(view, "ansi").length, 0);
		assert.equal(nodesOfKind(view, "code").length, 0);
	});

	it("counts all stored terminals and spins only while at least one is running", () => {
		const completed = [entry(1, exited(0)), entry(2, exited(1))];
		for (const [entries, label, spinners] of [
			[[completed[0]!], "1 terminal", 0],
			[completed, "2 terminals", 0],
			[[...completed, entry(3, { kind: "running" })], "3 terminals", 1],
			[[entry(4, { kind: "running" }), entry(5, { kind: "running" })], "2 terminals", 1],
		] as const) {
			const view = describeTerminalChip(entries);
			overlayOf(view);
			assert.equal(labelText(view), label);
			assert.equal(nodesOfKind(view, "spinner").length, spinners);
		}
	});
});

describe("terminals sheet description", () => {
	it("lists every session, keys selected detail per session, and ends with the Close action", () => {
		const entries = [entry(19, exited(0)), entry(3, { kind: "running" }), entry(11, exited(1))];
		const pane = { cols: 120, rows: 50 };
		const keys: string[] = [];
		for (const selected of entries) {
			const view = describeTerminalsSheet(entries, selected, pane);
			assert.equal(view.k, "col");
			assert.equal(view.p?.gap, "md");
			assert.deepEqual(view.c?.map((child) => child.k), ["list", "col", "row"]);
			const list = onlyNode(view, "list");
			assert.equal(list.key, LIST_KEY);
			assert.deepEqual(list.c?.map((item) => [item.k, item.key]), [["item", "s19"], ["item", "s3"], ["item", "s11"]]);
			assert.equal(list.p?.selected, `s${selected.id}`);
			const detail = detailOf(view);
			assert.equal(detail.key, `detail-s${selected.id}`);
			keys.push(detail.key!);
			assert.equal(detail.c?.[0]?.k, "text");
			assert.equal(detail.c?.[0]?.key, "status");
			assert.equal(ansiText(detail), selected.screen.text);
			const actions = view.c?.at(-1);
			assert.equal(actions?.c?.[0]?.k, "spacer");
			const close = actions?.c?.[1];
			assert.equal(close?.k, "row");
			assert.equal(close?.key, CLOSE_ACTION);
			assert.deepEqual(close?.p?.actions, { click: CLOSE_ACTION });
		}
		assert.equal(new Set(keys).size, entries.length, "switching sessions remounts the detail instead of retaining its scroll offset");
	});

	it("has a list with no selection and a Close action when no session is selected", () => {
		for (const entries of [[], [entry(1, { kind: "running" })]]) {
			const view = describeTerminalsSheet(entries, undefined, { cols: 120, rows: 50 });
			assert.deepEqual(view.c?.map((child) => child.k), ["list", "row"]);
			assert.equal(onlyNode(view, "list").p?.selected, null);
			assert.equal(nodesOfKind(view, "ansi").length, 0);
			assert.equal(nodesOfKind(view, "code").length, 0);
			assert.deepEqual(view.c?.at(-1)?.c?.[1]?.p?.actions, { click: CLOSE_ACTION });
		}
	});

	it("uses ansi exactly when the selected grid plus inset fits the sheet width", () => {
		for (const size of ["lg", "full"] as const) {
			const pane = { cols: 120, rows: 50 };
			const sheetCols = size === "lg" ? LG_SCREEN_COLS : pane.cols;
			for (const extraCols of [-1, 0, 1]) {
				const selected = styledEntry(1, sheetCols - SHEET_INSET_COLS + extraCols);
				const entries = size === "lg" ? [selected] : [selected, styledEntry(2, LG_SCREEN_COLS + 1)];
				assert.equal(sheetSize(entries), size);
				const view = describeTerminalsSheet(entries, selected, pane);
				const fits = extraCols <= 0;
				assert.equal(nodesOfKind(view, fits ? "ansi" : "code").length, 1);
				assert.equal(nodesOfKind(view, fits ? "code" : "ansi").length, 0);
				if (fits) {
					const screen = onlyNode(view, "ansi");
					assert.equal(screen.p?.cols, selected.screen.view.cols);
					assert.equal(screen.p?.text, selected.screen.text, "fitting grids retain SGR and every row");
					assert.equal(screen.p?.follow, true);
					assert.deepEqual(screen.p?.max, { h: `${screenLineBudget(size, pane, entries.length)}lines` });
				} else {
					const screen = onlyNode(view, "code");
					assert.equal(screen.p?.lang, "text");
					assert.equal(screen.p?.text, selected.screen.text.replace(/\x1b\[[0-9;]*m/g, ""));
				}
			}
		}
	});

	it("bounds fitting ansi by the current sheet and list budget without dropping rows", () => {
		for (const cols of [80, 100]) {
			for (const rows of [1, 50, 100]) {
				for (const count of [1, 6, 8]) {
					const value = styledEntry(1, cols);
					const selected = { ...value, screen: { ...value.screen, text: Array.from({ length: 100 }, (_, row) => `row-${row}`).join("\n"), view: { ...value.screen.view, rows: 100 } } };
					const entries = [selected, ...Array.from({ length: count - 1 }, (_, index) => entry(index + 2, exited(0)))];
					const pane = { cols: 120, rows };
					const view = describeTerminalsSheet(entries, selected, pane);
					assert.equal(ansiText(view), selected.screen.text);
					assert.deepEqual(onlyNode(view, "ansi").p?.max, { h: `${screenLineBudget(sheetSize(entries), pane, count)}lines` });
				}
			}
		}
	});

	it("crops code grids to their newest budgeted rows and notes only rows actually hidden", () => {
		for (const size of ["lg", "full"] as const) {
			for (const listRows of [1, 6, 8]) {
				const pane = { cols: 120, rows: 50 };
				const budget = screenLineBudget(size, pane, listRows) - 3;
				for (const count of [budget - 1, budget, budget + 1, budget * 3]) {
					const value = styledEntry(1, size === "lg" ? LG_SCREEN_COLS : pane.cols);
					const rows = Array.from({ length: count }, (_, row) => `row-${String(row).padStart(3, "0")}:${"x".repeat(value.screen.view.cols - 8)}`);
					const selected = { ...value, screen: { text: rows.map((row) => `\x1b[31m${row}\x1b[0m`).join("\n"), view: { ...value.screen.view, rows: count } } };
					const entries = [selected, ...Array.from({ length: listRows - 1 }, (_, index) => entry(index + 2, exited(0)))];
					assert.equal(sheetSize(entries), size);
					const view = describeTerminalsSheet(entries, selected, pane);
					const detail = detailOf(view);
					const screen = onlyNode(detail, "code");
					assert.equal(screen.p?.text, rows.slice(-budget).join("\n"));
					assert.equal(nodesOfKind(view, "ansi").length, 0);
					const hidden = Math.max(0, count - budget);
					const note = detail.c?.find((child) => child.key === "hidden");
					if (hidden > 0) {
						assert.equal(note?.k, "text");
						const spans = note?.p?.spans;
						assert.ok(Array.isArray(spans));
						const span: unknown = spans[0];
						assert.ok(typeof span === "object" && span !== null && "t" in span && typeof span.t === "string");
						assert.ok(span.t.startsWith(`${hidden} rows above hidden`));
						assert.equal(detail.c?.at(-2), note);
					} else {
						assert.equal(note, undefined);
					}
					assert.equal(detail.c?.at(-1), screen);
				}
			}
		}
	});
});

describe("terminal sheet sizing", () => {
	it("chooses one size for every entry, including a wider unselected session", () => {
		assert.equal(sheetSize([]), "lg");
		const narrow = styledEntry(1, LG_SCREEN_COLS - 1);
		const boundary = styledEntry(2, LG_SCREEN_COLS);
		const wide = styledEntry(3, LG_SCREEN_COLS + 1);
		assert.equal(sheetSize([narrow, boundary]), "lg");
		for (const entries of [[wide], [narrow, boundary, wide], [wide, boundary, narrow]]) {
			assert.equal(sheetSize(entries), "full");
		}
	});

	it("keeps lg line budgets independent of pane dimensions and list length", () => {
		for (const rows of [1, 50, 1000]) {
			for (const cols of [1, 120, 1000]) {
				for (const listRows of [0, 1, 6, 20]) {
					assert.equal(screenLineBudget("lg", { cols, rows }, listRows), LG_SCREEN_LINES);
				}
			}
		}
	});

	it("uses pane height for full sheets, rounds list height, caps visible list rows, and keeps the lg minimum", () => {
		const pane = { cols: 120, rows: 100 };
		const withoutList = screenLineBudget("full", pane, 0);
		assert.ok(withoutList > LG_SCREEN_LINES);
		for (const [listRows, listLines] of [[1, 2], [2, 3], [3, 5], [4, 6], [5, 7], [6, 9], [20, 9]] as const) {
			const budget = screenLineBudget("full", pane, listRows);
			assert.equal(budget, withoutList - listLines);
			assert.equal(screenLineBudget("full", { ...pane, rows: pane.rows + 10 }, listRows), budget + 10);
			assert.equal(screenLineBudget("full", { ...pane, cols: 1 }, listRows), budget);
			assert.equal(screenLineBudget("full", { ...pane, rows: 1 }, listRows), LG_SCREEN_LINES);
		}
	});
});

interface HudComponent {
	describe(): HudNode;
	handleNativeEvent(event: unknown): void;
	invalidate(): void;
	dispose(): void;
}

type WidgetFactory = (tui: { terminal: { rows: number }; requestRender(): void }) => HudComponent;
type WidgetCall = {
	readonly key: string;
	readonly content: WidgetFactory | undefined;
	readonly options: { readonly placement: string } | undefined;
};
type CustomCall = {
	readonly factory: unknown;
	readonly options: {
		readonly overlay: boolean;
		readonly overlayOptions: { readonly anchor: string; readonly width: string; readonly maxHeight: string };
	};
};
type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

function waitFor(
	condition: () => boolean,
	subscribe: (listener: () => void) => () => void,
	message: string,
): Promise<void> {
	if (condition()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		// Real PTY IO cannot use fake time; this deadline only bounds a missing event.
		const timeout = AbortSignal.timeout(8000);
		const failed = () => {
			unsubscribe();
			reject(new Error(message));
		};
		const changed = () => {
			if (!condition()) return;
			unsubscribe();
			timeout.removeEventListener("abort", failed);
			resolve();
		};
		const unsubscribe = subscribe(changed);
		timeout.addEventListener("abort", failed, { once: true });
		changed();
	});
}

function makeHarness(t: TestContext, initiallyNative = false) {
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const handlers = new Map<string, Handler[]>();
	const calls: WidgetCall[] = [];
	const customCalls: CustomCall[] = [];
	const sessions: ExecSession[] = [];
	const nativeListeners = new Set<(on: boolean) => void>();
	let nativeOn = initiallyNative;
	let component: HudComponent | undefined;
	let renders = 0;
	const ui = {
		setWidget(key: string, content: WidgetFactory | undefined, options?: { placement: string }) {
			calls.push({ key, content, options });
			// Widget replacement/removal disposes the old component, as the host does.
			component?.dispose();
			component = content?.({ terminal: { rows: 50 }, requestRender: () => { renders++; } });
		},
		custom(factory: unknown, options: CustomCall["options"]): Promise<void> {
			customCalls.push({ factory, options });
			return Promise.resolve();
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const native: NativeRenderingState = {
		isNativeRendering: () => nativeOn,
		onNativeRenderingChange(listener) {
			nativeListeners.add(listener);
			return () => { nativeListeners.delete(listener); };
		},
	};
	mountTerminalHud(pi, store, native);

	async function emit(event: string, hasUI = true): Promise<void> {
		const context = { hasUI, ui } as unknown as ExtensionContext;
		const registered = handlers.get(event);
		assert.ok(registered?.length, `${event} handler registered`);
		for (const handler of registered) await handler({}, context);
	}

	t.after(async () => {
		await emit("session_shutdown");
		// Keep removed sessions in this list: removing ownership does not kill the child.
		for (const session of sessions) session.terminate("SIGKILL");
		store.terminateAll();
		await Promise.all(sessions.map((session) => waitFor(
			() => session.hasExited, (listener) => session.onExit(listener), "all HUD test children exited",
		)));
		// TerminalScreen.release is idempotent, including after store.remove/terminateAll.
		await Promise.all(sessions.map((session) => session.release()));
	});

	return {
		store,
		calls,
		customCalls,
		emit,
		get renders() { return renders; },
		get component() {
			assert.ok(component, "terminal chip is mounted");
			return component;
		},
		get mounted() { return component !== undefined; },
		setNative(on: boolean) {
			nativeOn = on;
			for (const listener of nativeListeners) listener(on);
		},
		spawn(tty: boolean, command = [process.execPath, "-e", "process.stdin.resume()"], cols = 80) {
			const session = ExecSession.spawn(store.allocateId(), {
				command, cwd: process.cwd(), env: process.env, tty, cols, rows: 24,
			});
			sessions.push(session);
			assert.equal(session.failureMessage, null, "child spawn succeeds");
			store.insert(session);
			return session;
		},
	};
}

it("requires a PTY provider when EXPECT_PTY=1", { skip: process.env.EXPECT_PTY !== "1" }, () => {
	assert.equal(isPtyAvailable(), true, `PTY module failed to load: ${getPtyLoadError()}`);
});

describe("terminal HUD lifecycle with real sessions", { skip: !isPtyAvailable() }, () => {
	it("mounts only after UI, native rendering, and a tty session are all present", async (t) => {
		const h = makeHarness(t);
		h.spawn(false);
		assert.equal(h.calls.length, 0);
		await h.emit("session_start");
		h.setNative(true);
		assert.equal(h.calls.length, 0, "pipe-only store does not mount");
		h.setNative(false);
		h.spawn(true);
		assert.equal(h.calls.length, 0, "TTY alone does not mount without native rendering");
		h.setNative(true);
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0]?.key, "unified-exec-terminals");
		assert.equal(typeof h.calls[0]?.content, "function");
		assert.deepEqual(h.calls[0]?.options, { placement: "belowEditor" });
		const view = h.component.describe();
		assert.equal(overlayOf(view).key, "chip");
		assert.equal(labelText(view), "1 terminal", "pipe sessions are excluded from the chip");
		assert.deepEqual(pillOf(view).p?.actions, { click: OPEN_ACTION });
	});

	it("waits for an interactive session_start even when native rendering and a tty already exist", async (t) => {
		const h = makeHarness(t, true);
		h.spawn(true);
		assert.equal(h.calls.length, 0);
		await h.emit("session_start", false);
		assert.equal(h.calls.length, 0, "headless session has no widget");
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("unmounts when the last tty is removed even if a pipe session remains", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(false);
		const tty = h.spawn(true);
		assert.equal(h.mounted, true);
		h.store.remove(tty.id);
		assert.equal(h.store.size, 1);
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		assert.equal(h.calls.at(-1)?.key, "unified-exec-terminals");
	});

	it("unmounts when native rendering stops and remounts when it resumes", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(true);
		const first = h.component;
		h.setNative(false);
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		h.setNative(true);
		assert.equal(h.mounted, true);
		assert.notEqual(h.component, first);
	});

	it("unmounts on session_shutdown and stays unmounted until another session starts", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(true);
		await h.emit("session_shutdown");
		assert.equal(h.mounted, false);
		assert.equal(h.calls.at(-1)?.content, undefined);
		const callCount = h.calls.length;
		h.setNative(false);
		h.setNative(true);
		h.spawn(true);
		assert.equal(h.calls.length, callCount);
		await h.emit("session_start");
		assert.equal(h.mounted, true);
	});

	it("opens a custom overlay only for the mounted chip's native click action", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(true);
		const component = h.component;
		const view = component.describe();
		assert.equal(overlayOf(view).key, "chip");
		for (const event of [null, {}, { type: "action", act: "unrelated" }, { type: "other", act: OPEN_ACTION }, { type: "select", item: "s1" }]) {
			component.handleNativeEvent(event);
		}
		assert.equal(h.customCalls.length, 0);
		const actions = pillOf(view).p?.actions;
		assert.ok(typeof actions === "object" && actions !== null && "click" in actions);
		assert.equal(actions.click, OPEN_ACTION);
		component.handleNativeEvent({ type: "action", act: actions.click });
		assert.equal(h.customCalls.length, 1);
		assert.equal(typeof h.customCalls[0]?.factory, "function");
		assert.deepEqual(h.customCalls[0]?.options, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" },
		});
		assert.strictEqual(component.describe(), view, "opening the sheet does not turn the dock chip into a panel");
	});

	it("refreshes the chip's count when tty store membership changes", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn(true);
		const component = h.component;
		const initial = component.describe();
		assert.equal(labelText(initial), "1 terminal");
		assert.strictEqual(component.describe(), initial);
		h.spawn(true);
		assert.strictEqual(h.component, component);
		assert.equal(labelText(component.describe()), "2 terminals");
		h.store.remove(first.id);
		assert.strictEqual(h.component, component);
		assert.equal(labelText(component.describe()), "1 terminal");
	});

	it("stops the spinner after a real child exits but keeps its stored terminal mounted", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(true, [process.execPath, "-e", "process.stdin.once('data', () => process.exit(0))"]);
		const component = h.component;
		assert.equal(nodesOfKind(component.describe(), "spinner").length, 1);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("exit\r")), true);
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "real child exits on stdin");
		assert.ok(h.renders > before);
		assert.equal(nodesOfKind(component.describe(), "spinner").length, 0);
		assert.equal(h.mounted, true);
		assert.equal(labelText(component.describe()), "1 terminal");
	});

	it("never reads a released removed session when describing the remaining chip", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const removed = h.spawn(true);
		h.spawn(true);
		const component = h.component;
		assert.equal(labelText(component.describe()), "2 terminals");
		h.store.remove(removed.id);
		await removed.release();
		const forbiddenRead = t.mock.method(removed, "styledScreen", () => { throw new Error("removed screen read after release"); });
		assert.equal(labelText(component.describe()), "1 terminal");
		component.invalidate();
		assert.doesNotThrow(() => component.describe());
		assert.equal(labelText(component.describe()), "1 terminal");
		assert.equal(forbiddenRead.mock.callCount(), 0);
	});
});
