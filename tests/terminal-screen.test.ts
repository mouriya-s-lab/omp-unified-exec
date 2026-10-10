import { strict as assert } from "node:assert";
import { describe, it, type TestContext } from "node:test";

import { TERMINAL_HISTORY_CELLS, TerminalScreen, type TerminalObservation } from "../src/terminal-screen.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function terminal(t: TestContext, cols = 20, rows = 3, reply: (bytes: Uint8Array) => void = () => {}) {
	const screen = new TerminalScreen(cols, rows, reply);
	t.after(() => screen.release());
	return screen;
}

// One-byte writes deliberately split CSI commands and every multibyte UTF-8 character.
function fragmented(screen: TerminalScreen, text: string): void {
	for (const byte of encoder.encode(text)) screen.write(Uint8Array.of(byte));
}

function rendered(observation: TerminalObservation, text: string, historyLines = 0, historyMayBeTruncated = false) {
	assert.equal(observation.kind, "rendered");
	if (observation.kind !== "rendered") throw new Error("expected rendered observation");
	assert.equal(observation.text, text);
	assert.equal(observation.historyLines, historyLines);
	assert.equal(observation.historyMayBeTruncated, historyMayBeTruncated);
	return observation;
}

describe("TerminalScreen observable terminal state", () => {
	it("collapses carriage-return progress to its final state", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "progress 10%\rprogress 90%\rprogress 99%");
		rendered(await screen.observe(), "progress 99%");
	});

	it("parses fragmented CSI and split UTF-8 CJK without losing character width", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "old text\r\x1b[2K完成");
		const observation = rendered(await screen.observe(), "完成");
		assert.deepEqual(observation.view, { screen: "normal", cols: 20, rows: 3, cursor: { row: 1, col: 5 } });
	});

	it("reports initial history and screen, then unseen history and the full screen, then unchanged", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "1\r\n2\r\n3\r\n4\r\n5\r\n6");
		rendered(await screen.observe(), "1\n2\n3\n4\n5\n6", 3);
		fragmented(screen, "\r\n7\r\n8\r\n9\r\n10");
		const observation = rendered(await screen.observe(), "7\n8\n9\n10", 1);
		assert.deepEqual(await screen.observe(), { kind: "unchanged", view: observation.view });
	});

	it("replaces rows on a cursor-up redraw rather than appending the redraw", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "first\r\nsecond");
		rendered(await screen.observe(), "first\nsecond");
		fragmented(screen, "\x1b[1A\r\x1b[2Knew first\x1b[1B\r\x1b[2Knew second");
		rendered(await screen.observe(), "new first\nnew second");
	});

	it("rewrites the screen without turning already reported history into unseen history", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "A\r\nB\r\nC");
		rendered(await screen.observe(), "A\nB\nC");
		fragmented(screen, "\r\nD\r\nE\x1b[1;1H\x1b[2KX");
		rendered(await screen.observe(), "X\nD\nE");
	});

	it("joins a wrapped logical line across the history/screen boundary", async (t) => {
		const screen = terminal(t, 4, 3);
		fragmented(screen, "abcdefghij\r\nK\r\nL");
		rendered(await screen.observe(), "abcdefghij\nK\nL", 1);
	});

	it("never resumes output in the middle of an already observed wrapped logical line", async (t) => {
		const screen = terminal(t, 4, 3);
		fragmented(screen, "abcdefghij");
		rendered(await screen.observe(), "abcdefghij");
		fragmented(screen, "\r\nK\r\nL");
		rendered(await screen.observe(), "abcdefghij\nK\nL", 1);
	});

	it("renders alternate-screen entry, leaves idle alternate state unchanged, and renders normal return", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "normal");
		const normal = rendered(await screen.observe(), "normal");
		fragmented(screen, "\x1b[?1049h\x1b[Halternate");
		const alternate = rendered(await screen.observe(), "alternate");
		assert.equal(alternate.view.screen, "alternate");
		assert.deepEqual(await screen.observe(), { kind: "unchanged", view: alternate.view });
		fragmented(screen, "\x1b[?1049l");
		assert.deepEqual(rendered(await screen.observe(), "normal").view, normal.view);
	});

	it("recognizes a new alternate-screen entry even when its rows and cursor match", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "\x1b[?1049h\x1b[Hx");
		const first = rendered(await screen.observe(), "x");
		fragmented(screen, "\x1b[?1049l\x1b[?1049h\x1b[Hx");
		assert.deepEqual(rendered(await screen.observe(), "x").view, first.view);
	});

	it("scrolls only the DECSTBM region without adding region rows to history", async (t) => {
		const screen = terminal(t, 20, 5);
		fragmented(screen, "A\r\nB\r\nC\r\nD\r\nE");
		rendered(await screen.observe(), "A\nB\nC\nD\nE");
		fragmented(screen, "\x1b[2;4r\x1b[4;1H\r\nX");
		rendered(await screen.observe(), "A\nC\nD\nX\nE");
	});

	it("honors child-issued ED3 without erasing the visible screen", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "1\r\n2\r\n3\r\n4\r\n5\r\n6\x1b[3J");
		rendered(await screen.observe(), "4\n5\n6");
	});

	it("honors child-issued RIS by clearing history and resetting the visible screen and cursor", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "1\r\n2\r\n3\r\n4\r\n5\r\n6\x1bcreset");
		const observation = rendered(await screen.observe(), "reset");
		assert.deepEqual(observation.view.cursor, { row: 1, col: 6 });
	});

	it("flags history beyond the cell cap and starts a fresh history boundary after observation", async (t) => {
		const cols = 240;
		const rows = 3;
		const cap = Math.max(rows, Math.floor(TERMINAL_HISTORY_CELLS / cols));
		const screen = terminal(t, cols, rows);
		const lines = Array.from({ length: cap + rows + 2 }, (_, index) => `line-${index}`);
		screen.write(encoder.encode(lines.join("\r\n")));
		rendered(await screen.observe(), lines.slice(2).join("\n"), cap, true);
		fragmented(screen, "\r\nnext");
		rendered(await screen.observe(), [...lines.slice(-2), "next"].join("\n"));
	});

	for (const kind of ["normal", "alternate"] as const) {
		it(`renders a cursor-only move on the ${kind} screen`, async (t) => {
			const screen = terminal(t);
			fragmented(screen, `${kind === "alternate" ? "\x1b[?1049h\x1b[H" : ""}text`);
			rendered(await screen.observe(), "text");
			fragmented(screen, "\x1b[2;3H");
			const observation = rendered(await screen.observe(), "text");
			assert.deepEqual(observation.view.cursor, { row: 2, col: 3 });
			assert.deepEqual(await screen.observe(), { kind: "unchanged", view: observation.view });
		});
	}

	it("answers fragmented DSR with the current 1-based cursor position", async (t) => {
		const replies: string[] = [];
		const screen = terminal(t, 20, 3, (bytes) => replies.push(decoder.decode(bytes)));
		fragmented(screen, "\x1b[2;4H\x1b[6n");
		await screen.observe();
		assert.deepEqual(replies, ["\x1b[2;4R"]);
	});

	it("keeps OSC title, clipboard and hyperlink payloads out of rendered text", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "\x1b]0;secret-title\x07before\x1b]52;c;c2VjcmV0\x1b\\\x1b]8;;https://secret.example/\x1b\\link\x1b]8;;\x1b\\after");
		rendered(await screen.observe(), "beforelinkafter");
	});

	it("serializes concurrent consuming observations at distinct history boundaries", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "1\r\n2\r\n3\r\n4");
		const [first, second] = await Promise.all([screen.observe(), screen.observe()]);
		const observation = rendered(first, "1\n2\n3\n4", 1);
		assert.deepEqual(second, { kind: "unchanged", view: observation.view });
	});

	it("takes a non-consuming snapshot after a protocol reply confirms parsing", async (t) => {
		let resolveReply!: (bytes: Uint8Array) => void;
		const reply = new Promise<Uint8Array>((resolve) => { resolveReply = resolve; });
		const screen = terminal(t, 20, 3, resolveReply);
		fragmented(screen, "1\r\n2\r\n3\r\n4\x1b[6n");
		assert.equal(decoder.decode(await reply), "\x1b[3;2R");
		const snapshot = screen.snapshot();
		assert.equal(snapshot.text, "2\n3\n4");
		const observation = rendered(await screen.observe(), "1\n2\n3\n4", 1);
		assert.deepEqual(snapshot.view, observation.view);
	});

	it("release waits for pending writes, is idempotent, ignores later writes and rejects observation", async (t) => {
		const replies: string[] = [];
		const screen = terminal(t, 20, 3, (bytes) => replies.push(decoder.decode(bytes)));
		fragmented(screen, "\x1b[2;4H\x1b[6n");
		await Promise.all([screen.release(), screen.release()]);
		assert.deepEqual(replies, ["\x1b[2;4R"]);
		fragmented(screen, "ignored\x1b[6n");
		await screen.release();
		assert.deepEqual(replies, ["\x1b[2;4R"]);
		await assert.rejects(screen.observe(), /terminal screen observed after release/);
	});
});
