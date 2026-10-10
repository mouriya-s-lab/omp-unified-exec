import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	describeTerminalHud,
	mountTerminalHud,
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

describe("terminal HUD description", () => {
	it("keeps the actionable pill but no overlay when closed", () => {
		const view = describeTerminalHud([entry(7, { kind: "running" })], false);
		const pill = pillOf(view);
		assert.equal(pill.k, "row");
		assert.equal(typeof pill.key, "string");
		assert.deepEqual(pill.p?.actions, { click: TOGGLE_ACTION });
		assert.equal(nodesOfKind(view, "overlay").length, 0);
		assert.equal(nodesOfKind(view, "card").length, 0);
	});

	it("anchors a non-modal overlay to the pill and preserves entry order and screens", () => {
		const entries = [entry(19, exited(0)), entry(3, { kind: "running" }), entry(11, exited(1))];
		const view = describeTerminalHud(entries, true);
		const pill = pillOf(view);
		const overlay = onlyNode(view, "overlay");
		assert.deepEqual(overlay.p?.anchor, { node: pill.key, side: "above" });
		assert.notEqual(overlay.p?.modal, true);
		const cards = nodesOfKind(overlay, "card");
		assert.deepEqual(cards.map((card) => card.key), ["s19", "s3", "s11"]);
		assert.deepEqual(cards.map((card) => card.p?.collapsible), [true, true, true]);
		assert.deepEqual(cards.map(ansiText), entries.map((value) => value.screen.text));
		assert.deepEqual(cards.map((card) => onlyNode(card, "ansi").p?.cols), [80, 80, 80]);
	});

	it("maps running, successful exits, nonzero exits, signals, and failures to card status", () => {
		const states: readonly TerminalState[] = [
			{ kind: "running" }, exited(0), exited(9), exited(null, "SIGTERM"),
			exited(0, "SIGINT"), exited(null, null, "spawn failed"), exited(0, null, "log failed"), exited(null),
		];
		const view = describeTerminalHud(states.map((state, index) => entry(index + 1, state)), true);
		assert.deepEqual(nodesOfKind(view, "card").map((card) => card.p?.status),
			["running", "done", "error", "error", "error", "error", "error", "error"]);
	});

	it("shows a spinner exactly while at least one entry is running", () => {
		for (const open of [false, true]) {
			const completed = [entry(1, exited(0)), entry(2, exited(1))];
			assert.equal(nodesOfKind(describeTerminalHud(completed, open), "spinner").length, 0);
			assert.equal(nodesOfKind(describeTerminalHud([...completed, entry(3, { kind: "running" })], open), "spinner").length, 1);
		}
	});
});

interface HudComponent {
	describe(): HudNode;
	handleNativeEvent(event: unknown): void;
	invalidate(): void;
	dispose(): void;
}

type WidgetFactory = (tui: { requestRender(): void }) => HudComponent;
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
	const ui = {
		setWidget(key: string, content: WidgetFactory | undefined, options?: { placement: string }) {
			calls.push({ key, content, options });
			// Widget replacement/removal disposes the old component, as the host does.
			component?.dispose();
			component = content?.({ requestRender: () => {
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
		spawn(tty: boolean, command = [process.execPath, "-e", "process.stdin.resume()"]) {
			const session = ExecSession.spawn(store.allocateId(), {
				command, cwd: process.cwd(), env: process.env, tty, cols: 80, rows: 24,
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
		assert.deepEqual(nodesOfKind(h.component.describe(), "card").map((card) => card.key), [`s${tty.id}`]);
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
		assert.equal(nodesOfKind(component.describe(), "overlay").length, 0);
		component.handleNativeEvent({ type: "action", act: "unrelated" });
		component.handleNativeEvent({ type: "other", act: TOGGLE_ACTION });
		assert.equal(nodesOfKind(component.describe(), "overlay").length, 0);
		const before = h.renders;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.ok(h.renders > before);
		assert.equal(nodesOfKind(component.describe(), "overlay").length, 1);
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.equal(nodesOfKind(component.describe(), "overlay").length, 0);
	});

	it("redescribes real cat output while open and preserves produced SGR styling", { skip: IS_WINDOWS }, async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(true, ["bash", "-c", "stty -echo; printf '\\033[31mHUD_COLOR\\033[0m\\n'; exec cat"]);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		await waitFor(() => ansiText(component.describe()).includes("HUD_COLOR"), h.onRender, "colored child output reaches the open panel");
		assert.match(ansiText(component.describe()), /\x1b\[[0-9;]*m/);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("HUD_CAT_ROUNDTRIP\r")), true);
		await waitFor(() => ansiText(component.describe()).includes("HUD_CAT_ROUNDTRIP"), h.onRender, "cat stdin round-trip reaches the panel");
		assert.ok(h.renders > before, "parsed new output requests a render without manual invalidation");
		assert.match(ansiText(component.describe()), /\x1b\[[0-9;]*m/);
	});

	it("refreshes running status and stops the spinner after a real child exits", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const session = h.spawn(true, [process.execPath, "-e", "process.stdin.once('data', () => process.exit(0))"]);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.equal(onlyNode(component.describe(), "card").p?.status, "running");
		assert.equal(nodesOfKind(component.describe(), "spinner").length, 1);
		const before = h.renders;
		assert.equal(session.write(Buffer.from("exit\r")), true);
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "real child exits on stdin");
		assert.ok(h.renders > before);
		assert.equal(onlyNode(component.describe(), "card").p?.status, "done");
		assert.equal(nodesOfKind(component.describe(), "spinner").length, 0);
	});

	it("never reads a released removed session when describing the remaining cards", async (t) => {
		const h = makeHarness(t, true);
		await h.emit("session_start");
		const removed = h.spawn(true);
		const remaining = h.spawn(true);
		const component = h.component;
		component.handleNativeEvent({ type: "action", act: TOGGLE_ACTION });
		assert.equal(nodesOfKind(component.describe(), "card").length, 2);
		h.store.remove(removed.id);
		await removed.release();
		const forbiddenRead = t.mock.method(removed, "styledScreen", () => { throw new Error("removed screen read after release"); });
		assert.deepEqual(nodesOfKind(component.describe(), "card").map((card) => card.key), [`s${remaining.id}`]);
		component.invalidate();
		assert.doesNotThrow(() => component.describe());
		assert.deepEqual(nodesOfKind(component.describe(), "card").map((card) => card.key), [`s${remaining.id}`]);
		assert.equal(forbiddenRead.mock.callCount(), 0);
	});
});
