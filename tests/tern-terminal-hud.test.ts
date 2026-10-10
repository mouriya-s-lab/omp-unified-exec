import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	describeTerminalHud,
	mountTerminalHud,
	PANEL_INSET_COLS,
	PANEL_MAX_HEIGHT,
	screenLineBudget,
	TABS_KEY,
	TOGGLE_ACTION,
	type HudNode,
	type NativeRenderingState,
	type TerminalEntry,
	type TerminalState,
} from "../fork-features/tern-terminal-hud.ts";
import { getPtyLoadError, isPtyAvailable } from "../src/pty.ts";
import { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";
import { IS_WINDOWS } from "../src/shell.ts";

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

function exited(exitCode: number | null, signal: string | null = null, failure: string | null = null): TerminalState {
	return { kind: "exited", exitCode, signal, failure };
}

function pillOf(node: HudNode): HudNode {
	const pill = node.c?.find((child) => child.p?.role === "omp.hud.pill");
	assert.ok(pill, "HUD contains its interactive pill");
	return pill;
}

function ansiText(node: HudNode): string {
	const text = onlyNode(node, "ansi").p?.text;
	assert.ok(typeof text === "string");
	return text;
}

function tabIds(node: HudNode): string[] {
	const tabs = onlyNode(node, "tabs");
	assert.equal(tabs.key, TABS_KEY);
	const items = tabs.p?.items;
	assert.ok(Array.isArray(items));
	return items.map((item: unknown) => {
		assert.ok(typeof item === "object" && item !== null && "id" in item && "label" in item);
		assert.ok(typeof item.id === "string");
		assert.ok(Array.isArray(item.label) && item.label.length > 0);
		return item.id;
	});
}

function statusTone(node: HudNode): string {
	const status = nodesOfKind(node, "text").find((text) => text.key === "status");
	assert.ok(status);
	const spans = status.p?.spans;
	assert.ok(Array.isArray(spans));
	const state: unknown = spans.at(-1);
	assert.ok(typeof state === "object" && state !== null && "s" in state && typeof state.s === "string");
	return state.s;
}

describe("terminal HUD description", () => {
	it("keeps only the actionable pill when closed", () => {
		const view = describeTerminalHud([entry(7, { kind: "running" })], false, { cols: 120, rows: 50 });
		const pill = pillOf(view);
		assert.equal(view.k, "row");
		assert.deepEqual(view.c, [pill]);
		assert.equal(pill.k, "row");
		assert.equal(typeof pill.key, "string");
		assert.deepEqual(pill.p?.actions, { click: TOGGLE_ACTION });
		assert.equal(nodesOfKind(view, "overlay").length, 0);
		assert.equal(nodesOfKind(view, "tabs").length, 0);
		assert.equal(nodesOfKind(view, "ansi").length, 0);
		assert.equal(nodesOfKind(view, "code").length, 0);
	});

	it("uses a full-width height-bounded non-modal overlay with ordered tabs and only the first screen", () => {
		const entries = [entry(19, exited(0)), entry(3, { kind: "running" }), entry(11, exited(1))];
		const view = describeTerminalHud(entries, true, { cols: 120, rows: 50 });
		const overlay = onlyNode(view, "overlay");
		assert.deepEqual(view.c, [pillOf(view), overlay]);
		assert.equal(overlay.p?.anchor, "top");
		assert.equal(overlay.p?.size, "full");
		assert.deepEqual(overlay.p?.max, { h: PANEL_MAX_HEIGHT });
		assert.equal(PANEL_MAX_HEIGHT, 0.6);
		assert.notEqual(overlay.p?.modal, true);
		assert.equal(overlay.c?.length, 1);
		const body = overlay.c?.[0];
		assert.equal(body?.k, "col");
		assert.deepEqual(body?.c?.map((child) => child.k), ["tabs", "text", "ansi"]);
		assert.equal(body?.c?.[1]?.key, "status");
		assert.deepEqual(tabIds(view), ["s19", "s3", "s11"]);
		assert.equal(onlyNode(view, "tabs").p?.active, "s19");
		assert.equal(ansiText(view), entries[0]!.screen.text);
		assert.equal(onlyNode(view, "ansi").p?.cols, 80);
		assert.equal(nodesOfKind(view, "code").length, 0);
		assert.equal(nodesOfKind(view, "card").length, 0);
	});

	it("selects activeId and falls back to the first entry when the active session is gone", () => {
		const entries = [entry(19, exited(0)), entry(3, { kind: "running" }), entry(11, exited(1))];
		const pane = { cols: 120, rows: 50 };
		const selected = describeTerminalHud(entries, true, pane, 3);
		assert.deepEqual(tabIds(selected), ["s19", "s3", "s11"]);
		assert.equal(onlyNode(selected, "tabs").p?.active, "s3");
		assert.equal(ansiText(selected), entries[1]!.screen.text);
		const remaining = [entries[0]!, entries[2]!];
		const fallback = describeTerminalHud(remaining, true, pane, 3);
		assert.deepEqual(tabIds(fallback), ["s19", "s11"]);
		assert.equal(onlyNode(fallback, "tabs").p?.active, "s19");
		assert.equal(ansiText(fallback), remaining[0]!.screen.text);
	});

	it("keeps SGR and the grid width when a screen exactly fits the panel", () => {
		const pane = { cols: 120, rows: 50 };
		const value = styledEntry(1, pane.cols - PANEL_INSET_COLS);
		const view = describeTerminalHud([value], true, pane);
		const screen = onlyNode(view, "ansi");
		assert.equal(screen.p?.cols, value.screen.view.cols);
		assert.equal(screen.p?.text, value.screen.text);
		assert.match(ansiText(view), /\x1b\[[0-9;]*m/);
		assert.equal(nodesOfKind(view, "code").length, 0);
	});

	it("bounds fitting screens to the pane line budget and follows output, with a four-line minimum", () => {
		for (const [rows, budget] of [[60, 28], [49, 21], [21, 4], [1, 4]] as const) {
			const pane = { cols: 120, rows };
			assert.equal(screenLineBudget(pane), budget);
			const screen = onlyNode(describeTerminalHud([entry(1, { kind: "running" })], true, pane), "ansi");
			assert.equal(screen.p?.follow, true);
			assert.deepEqual(screen.p?.max, { h: `${budget}lines` });
		}
	});

	it("preserves every complete row without ESC when a screen is one column too wide", () => {
		const pane = { cols: 120, rows: 50 };
		const value = styledEntry(1, pane.cols - PANEL_INSET_COLS + 1);
		const view = describeTerminalHud([value], true, pane);
		const screen = onlyNode(view, "code");
		assert.equal(screen.p?.lang, "text");
		const text = screen.p?.text;
		assert.ok(typeof text === "string");
		assert.equal(text, value.screen.text.replace(/\x1b\[[0-9;]*m/g, ""));
		assert.ok(!text.includes("\x1b"));
		const rows = text.split("\n");
		assert.equal(rows.length, value.screen.text.split("\n").length);
		assert.deepEqual(rows.map((row) => row.length), Array(3).fill(value.screen.view.cols));
		assert.deepEqual(rows.map((row) => row.at(-1)), ["|", "]", ">"]);
		assert.equal(nodesOfKind(view, "ansi").length, 0);
	});

	it("renders only the selected screen with its own fitting or wide representation", () => {
		const pane = { cols: 120, rows: 50 };
		const entries = [
			styledEntry(1, pane.cols - PANEL_INSET_COLS),
			styledEntry(2, pane.cols - PANEL_INSET_COLS + 1),
			styledEntry(3, 80),
		];
		for (const value of entries) {
			const view = describeTerminalHud(entries, true, pane, value.id);
			assert.deepEqual(tabIds(view), ["s1", "s2", "s3"]);
			assert.equal(onlyNode(view, "tabs").p?.active, `s${value.id}`);
			if (value.screen.view.cols <= pane.cols - PANEL_INSET_COLS) {
				assert.equal(ansiText(view), value.screen.text);
				assert.equal(onlyNode(view, "ansi").p?.cols, value.screen.view.cols);
				assert.equal(nodesOfKind(view, "code").length, 0);
			} else {
				assert.equal(onlyNode(view, "code").p?.text, value.screen.text.replace(/\x1b\[[0-9;]*m/g, ""));
				assert.equal(nodesOfKind(view, "ansi").length, 0);
			}
		}
	});

	it("maps running, successful exits, nonzero exits, signals, and failures to active status tones", () => {
		const states: readonly TerminalState[] = [
			{ kind: "running" }, exited(0), exited(9), exited(null, "SIGTERM"),
			exited(0, "SIGINT"), exited(null, null, "spawn failed"), exited(0, null, "log failed"), exited(null),
		];
		const entries = states.map((state, index) => entry(index + 1, state));
		const tones = entries.map((value) => {
			const view = describeTerminalHud(entries, true, { cols: 120, rows: 50 }, value.id);
			assert.equal(ansiText(view), value.screen.text);
			return statusTone(view);
		});
		assert.deepEqual(tones, ["accent", "muted", "error", "error", "error", "error", "error", "error"]);
	});

	it("shows a spinner exactly while at least one entry is running", () => {
		for (const open of [false, true]) {
			const completed = [entry(1, exited(0)), entry(2, exited(1))];
			const pane = { cols: 120, rows: 50 };
			assert.equal(nodesOfKind(describeTerminalHud(completed, open, pane), "spinner").length, 0);
			assert.equal(nodesOfKind(describeTerminalHud([...completed, entry(3, { kind: "running" })], open, pane), "spinner").length, 1);
		}
	});
});

interface HudComponent {
	describe(cx: { readonly cols: number }): HudNode;
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
	const sessions: ExecSession[] = [];
	const nativeListeners = new Set<(on: boolean) => void>();
	const renderListeners = new Set<() => void>();
	let nativeOn = initiallyNative;
	let component: HudComponent | undefined;
	let renders = 0;
	const terminal = { rows: 50 };
	const ui = {
		setWidget(key: string, content: WidgetFactory | undefined, options?: { placement: string }) {
			calls.push({ key, content, options });
			// Widget replacement/removal disposes the old component, as the host does.
			component?.dispose();
			component = content?.({ terminal, requestRender: () => {
				renders++;
				for (const listener of renderListeners) listener();
			} });
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
		emit,
		terminal,
		onRender(listener: () => void) {
			renderListeners.add(listener);
			return () => { renderListeners.delete(listener); };
		},
		get renders() { return renders; },
		get component() {
			assert.ok(component, "terminal HUD is mounted");
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
		const tty = h.spawn(true);
		assert.equal(h.calls.length, 0, "TTY alone does not mount without native rendering");
		h.setNative(true);
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0]?.key, "unified-exec-terminals");
		assert.equal(typeof h.calls[0]?.content, "function");
		assert.deepEqual(h.calls[0]?.options, { placement: "aboveEditor" });
		h.component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		const view = h.component.describe({ cols: 120 });
		assert.deepEqual(tabIds(view), [`s${tty.id}`]);
		assert.equal(onlyNode(view, "tabs").p?.active, `s${tty.id}`);
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

	it("toggles the overlay only for the pill's native click action", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(true);
		const component = h.component;
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "overlay").length, 0);
		component.handleNativeEvent({ type: "action", act: "unrelated" });
		component.handleNativeEvent({ type: "other", act: TOGGLE_ACTION });
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "overlay").length, 0);
		const before = h.renders;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.ok(h.renders > before);
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "overlay").length, 1);
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "overlay").length, 0);
	});

	it("redescribes a wide real tty at changed surface widths and reuses descriptions at the same width", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const ttyCols = 140;
		h.spawn(true, [process.execPath, "-e", "process.stdout.write('HUD_WIDE_READY\\n'); process.stdin.resume()"], ttyCols);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		const wideCols = ttyCols + PANEL_INSET_COLS;
		const narrowCols = wideCols - 1;
		await waitFor(
			() => ansiText(component.describe({ cols: wideCols })).includes("HUD_WIDE_READY"),
			h.onRender,
			"wide tty startup output reaches the panel",
		);

		const wide = component.describe({ cols: wideCols });
		assert.equal(onlyNode(wide, "ansi").p?.cols, ttyCols);
		assert.equal(nodesOfKind(wide, "code").length, 0);
		assert.strictEqual(component.describe({ cols: wideCols }), wide);

		const narrow = component.describe({ cols: narrowCols });
		assert.notStrictEqual(narrow, wide);
		assert.equal(nodesOfKind(narrow, "ansi").length, 0);
		assert.equal(onlyNode(narrow, "code").p?.lang, "text");
		assert.equal(onlyNode(narrow, "code").p?.text, ansiText(wide).replace(/\x1b\[[0-9;]*m/g, ""));
		assert.strictEqual(component.describe({ cols: narrowCols }), narrow);

		const widened = component.describe({ cols: wideCols });
		assert.notStrictEqual(widened, narrow);
		assert.equal(onlyNode(widened, "ansi").p?.cols, ttyCols);
		assert.strictEqual(component.describe({ cols: wideCols }), widened);
	});

	it("redescribes at changed pane rows and reuses descriptions at unchanged dimensions", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		h.spawn(true);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		const original = component.describe({ cols: 120 });
		assert.deepEqual(onlyNode(original, "ansi").p?.max, { h: "22lines" });
		assert.strictEqual(component.describe({ cols: 120 }), original);

		h.terminal.rows = 49;
		const shorter = component.describe({ cols: 120 });
		assert.notStrictEqual(shorter, original);
		assert.deepEqual(onlyNode(shorter, "ansi").p?.max, { h: "21lines" });
		assert.strictEqual(component.describe({ cols: 120 }), shorter);

		h.terminal.rows = 1;
		const tiny = component.describe({ cols: 120 });
		assert.notStrictEqual(tiny, shorter);
		assert.deepEqual(onlyNode(tiny, "ansi").p?.max, { h: "4lines" });
		assert.strictEqual(component.describe({ cols: 120 }), tiny);

		h.terminal.rows = 50;
		const restored = component.describe({ cols: 120 });
		assert.notStrictEqual(restored, tiny);
		assert.deepEqual(onlyNode(restored, "ansi").p?.max, { h: "22lines" });
		assert.strictEqual(component.describe({ cols: 120 }), restored);
	});

	it("switches the shown session through tabs and renders only its parsed PTY output", { skip: IS_WINDOWS }, async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const first = h.spawn(true, ["bash", "-c", "stty -echo; printf 'HUD_FIRST_READY\\n'; exec cat"]);
		const second = h.spawn(true, ["bash", "-c", "stty -echo; printf 'HUD_SECOND_READY\\n'; exec cat"]);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		await Promise.all([first, second].map((session, index) => waitFor(
			() => session.styledScreen()?.text.includes(index === 0 ? "HUD_FIRST_READY" : "HUD_SECOND_READY") === true,
			(listener) => session.onScreenChange(listener),
			"both PTY children have parsed their readiness output",
		)));
		const initial = component.describe({ cols: 120 });
		assert.deepEqual(tabIds(initial), [`s${first.id}`, `s${second.id}`]);
		assert.equal(onlyNode(initial, "tabs").p?.active, `s${first.id}`);
		assert.ok(ansiText(initial).includes("HUD_FIRST_READY"));
		assert.ok(!ansiText(initial).includes("HUD_SECOND_READY"));

		const beforeHidden = h.renders;
		const hiddenParsed = waitFor(
			() => second.styledScreen()?.text.includes("HUD_SECOND_HIDDEN") === true,
			(listener) => second.onScreenChange(listener),
			"non-shown PTY output is parsed independently of HUD renders",
		);
		assert.equal(second.write(Buffer.from("HUD_SECOND_HIDDEN\r")), true);
		await hiddenParsed;
		assert.equal(h.renders, beforeHidden, "non-shown parsed output does not request a render");
		assert.strictEqual(component.describe({ cols: 120 }), initial);

		component.handleNativeEvent({ type: "select", key: `unified-exec-terminals/body/${TABS_KEY}`, item: `s${second.id}` });
		assert.ok(h.renders > beforeHidden, "selecting a tab requests a render");
		const selected = component.describe({ cols: 120 });
		assert.notStrictEqual(selected, initial);
		assert.equal(onlyNode(selected, "tabs").p?.active, `s${second.id}`);
		assert.ok(ansiText(selected).includes("HUD_SECOND_READY"));
		assert.ok(ansiText(selected).includes("HUD_SECOND_HIDDEN"));
		assert.ok(!ansiText(selected).includes("HUD_FIRST_READY"));

		const beforeFormerlyShown = h.renders;
		const formerlyShownParsed = waitFor(
			() => first.styledScreen()?.text.includes("HUD_FIRST_NOW_HIDDEN") === true,
			(listener) => first.onScreenChange(listener),
			"formerly shown PTY output is parsed after tab selection",
		);
		assert.equal(first.write(Buffer.from("HUD_FIRST_NOW_HIDDEN\r")), true);
		await formerlyShownParsed;
		assert.equal(h.renders, beforeFormerlyShown, "selection unsubscribes the formerly shown screen");
		assert.strictEqual(component.describe({ cols: 120 }), selected);

		const beforeShown = h.renders;
		const shownRendered = waitFor(
			() => ansiText(component.describe({ cols: 120 })).includes("HUD_SECOND_SHOWN"),
			h.onRender,
			"shown PTY output reaches the selected screen",
		);
		assert.equal(second.write(Buffer.from("HUD_SECOND_SHOWN\r")), true);
		await shownRendered;
		assert.ok(h.renders > beforeShown, "shown parsed output requests a render");
		assert.equal(onlyNode(component.describe({ cols: 120 }), "tabs").p?.active, `s${second.id}`);
	});

	it("redescribes real cat output while open and preserves produced SGR styling", { skip: IS_WINDOWS }, async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(true, ["bash", "-c", "stty -echo; printf '\\033[31mHUD_COLOR\\033[0m\\n'; exec cat"]);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		await waitFor(() => ansiText(component.describe({ cols: 120 })).includes("HUD_COLOR"), h.onRender, "colored child output reaches the open panel");
		assert.match(ansiText(component.describe({ cols: 120 })), /\x1b\[[0-9;]*m/);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("HUD_CAT_ROUNDTRIP\r")), true);
		await waitFor(() => ansiText(component.describe({ cols: 120 })).includes("HUD_CAT_ROUNDTRIP"), h.onRender, "cat stdin round-trip reaches the panel");
		assert.ok(h.renders > before, "parsed new output requests a render without manual invalidation");
		assert.match(ansiText(component.describe({ cols: 120 })), /\x1b\[[0-9;]*m/);
	});

	it("refreshes running status and stops the spinner after a real child exits", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(true, [process.execPath, "-e", "process.stdin.once('data', () => process.exit(0))"]);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.equal(statusTone(component.describe({ cols: 120 })), "accent");
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "spinner").length, 1);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("exit\r")), true);
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "real child exits on stdin");
		assert.ok(h.renders > before);
		assert.equal(statusTone(component.describe({ cols: 120 })), "muted");
		assert.equal(nodesOfKind(component.describe({ cols: 120 }), "spinner").length, 0);
	});

	it("never reads a released removed session when describing the remaining tabs", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const removed = h.spawn(true);
		const remaining = h.spawn(true);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.deepEqual(tabIds(component.describe({ cols: 120 })), [`s${removed.id}`, `s${remaining.id}`]);
		assert.equal(onlyNode(component.describe({ cols: 120 }), "tabs").p?.active, `s${removed.id}`);
		component.handleNativeEvent({ type: "select", key: TABS_KEY, item: `s${removed.id}` });
		h.store.remove(removed.id);
		await removed.release();
		const forbiddenRead = t.mock.method(removed, "styledScreen", () => { throw new Error("removed screen read after release"); });
		const view = component.describe({ cols: 120 });
		assert.deepEqual(tabIds(view), [`s${remaining.id}`]);
		assert.equal(onlyNode(view, "tabs").p?.active, `s${remaining.id}`);
		component.invalidate();
		assert.doesNotThrow(() => component.describe({ cols: 120 }));
		assert.deepEqual(tabIds(component.describe({ cols: 120 })), [`s${remaining.id}`]);
		assert.equal(forbiddenRead.mock.callCount(), 0);
	});
});
