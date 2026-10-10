import { strict as assert } from "node:assert";
import { describe, it, type TestContext } from "node:test";
import xtermHeadless from "@xterm/headless";

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

// Public xterm cells are an independent semantic oracle for SGR serialization.
// Normalize only empty default glyphs: trimmed blanks and explicit spaces draw alike.
async function cellRows(t: TestContext, text: string, cols: number, rows: number) {
	const emulator = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
	t.after(() => emulator.dispose());
	await new Promise<void>((resolve) => emulator.write(text, resolve));
	const buffer = emulator.buffer.active;
	return Array.from({ length: rows }, (_, row) => {
		const line = buffer.getLine(buffer.baseY + row);
		assert.ok(line);
		return Array.from({ length: cols }, (_, col) => {
			const cell = line.getCell(col);
			assert.ok(cell);
			return {
				chars: cell.getChars() || (cell.getWidth() === 0 ? "" : " "),
				width: cell.getWidth(),
				foreground: { mode: cell.getFgColorMode(), value: cell.getFgColor() },
				background: { mode: cell.getBgColorMode(), value: cell.getBgColor() },
				bold: Boolean(cell.isBold()),
				italic: Boolean(cell.isItalic()),
				underline: Boolean(cell.isUnderline()),
				inverse: Boolean(cell.isInverse()),
			};
		});
	});
}

async function styledRoundTrip(t: TestContext, input: string, cols = 32, rows = 3): Promise<void> {
	const source = terminal(t, cols, rows);
	fragmented(source, input);
	await source.observe();
	const styled = source.styledScreen();
	const expected = await cellRows(t, input, cols, rows);
	const replayBytes = styled.text.replaceAll("\n", "\r\n");
	assert.deepEqual(await cellRows(t, replayBytes, cols, rows), expected);

	const replay = terminal(t, cols, rows);
	fragmented(replay, replayBytes);
	await replay.observe();
	assert.deepEqual(await cellRows(t, replay.styledScreen().text.replaceAll("\n", "\r\n"), cols, rows), expected);
}

function withoutSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
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

describe("TerminalScreen styled display", () => {
	for (const [name, base] of [
		["foreground palette", 30],
		["bright foreground palette", 90],
		["background palette", 40],
		["bright background palette", 100],
	] as const) {
		it(`round-trips all eight ${name} colors and returns to defaults`, async (t) => {
			const colors = Array.from({ length: 8 }, (_, index) => `\x1b[${base + index}m${index}`).join("");
			await styledRoundTrip(t, `default ${colors}\x1b[0m end`);
		});
	}

	it("round-trips 256-color foreground and background at low, middle and high indices", async (t) => {
		await styledRoundTrip(t, "\x1b[38;5;16;48;5;255mA\x1b[38;5;87;48;5;123mB\x1b[38;5;255;48;5;16mC\x1b[0mD");
	});

	it("round-trips truecolor foreground and background including zero and maximum channels", async (t) => {
		await styledRoundTrip(t, "\x1b[38;2;0;17;255;48;2;255;0;93mA\x1b[38;2;255;128;0;48;2;0;255;255mB\x1b[0mC");
	});

	it("round-trips bold, italic, underline and inverse across individual and combined transitions", async (t) => {
		await styledRoundTrip(t, "\x1b[1mB\x1b[22;3mI\x1b[23;4mU\x1b[24;7mV\x1b[1;3;4;31;44mX\x1b[22;23;24;27mC\x1b[0mD");
	});

	it("emits wide CJK glyphs once and trims default trailing spaces and blank rows", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "\x1b[31m完成\x1b[0m   \r\n\r\n");
		await screen.observe();
		assert.equal(withoutSgr(screen.styledScreen().text), "完成");
		await styledRoundTrip(t, "\x1b[31m完成\x1b[0m   \r\n\r\n");
	});

	it("keeps a trailing colored-background run, including a row containing only styled blanks", async (t) => {
		const input = "X\x1b[44m   \x1b[0m  \r\n\x1b[48;2;12;34;56m  \x1b[0m";
		const screen = terminal(t);
		fragmented(screen, input);
		await screen.observe();
		assert.equal(withoutSgr(screen.styledScreen().text), "X   \n  ");
		await styledRoundTrip(t, input);
	});

	it("shows the active alternate screen and restores the normal screen on exit", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "\x1b[31mnormal\x1b[0m\x1b[?1049h\x1b[H\x1b[44malternate\x1b[0m");
		await screen.observe();
		const alternate = screen.styledScreen();
		assert.equal(alternate.view.screen, "alternate");
		assert.equal(withoutSgr(alternate.text), "alternate");
		assert.deepEqual(
			await cellRows(t, alternate.text, 20, 3),
			await cellRows(t, "\x1b[44malternate\x1b[0m", 20, 3),
		);
		fragmented(screen, "\x1b[?1049l");
		await screen.observe();
		const normal = screen.styledScreen();
		assert.equal(normal.view.screen, "normal");
		assert.equal(withoutSgr(normal.text), "normal");
	});

	it("reconstructs only SGR rather than leaking child OSC, movement, erase or mode-switch controls", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "obsolete\x1b[2J\x1b[H\x1b]0;secret-title\x07\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[H\x1b[2;3H\x1b[32m完成\x1b[0m");
		await screen.observe();
		const text = screen.styledScreen().text;
		assert.equal(withoutSgr(text), "\n  完成");
		assert.ok(text.includes("\x1b["), "fixture must retain styling to exercise the SGR allowlist");
		assert.ok(!withoutSgr(text).includes("\x1b"), "every escape must be an SGR sequence");
		assert.ok(!withoutSgr(text).includes("\x07"), "OSC terminators must not survive");
	});

	it("does not consume pending rendered content or its unseen history", async (t) => {
		let resolveReply!: (bytes: Uint8Array) => void;
		const reply = new Promise<Uint8Array>((resolve) => { resolveReply = resolve; });
		const screen = terminal(t, 20, 3, resolveReply);
		fragmented(screen, "1\r\n2\r\n3\r\n\x1b[31m4\x1b[0m\x1b[6n");
		assert.equal(decoder.decode(await reply), "\x1b[3;2R");
		const styled = screen.styledScreen();
		assert.equal(withoutSgr(styled.text), "2\n3\n4");
		const observation = rendered(await screen.observe(), "1\n2\n3\n4", 1);
		assert.deepEqual(styled.view, observation.view);
		assert.deepEqual(await screen.observe(), { kind: "unchanged", view: observation.view });
	});
});

describe("TerminalScreen parsed change subscriptions", () => {
	it("notifies only after later child writes are parsed, with no historical replay or internal erase event", async (t) => {
		const screen = terminal(t);
		fragmented(screen, "before");
		await screen.observe();
		const seen: string[] = [];
		screen.onChange(() => seen.push(withoutSgr(screen.styledScreen().text)));
		assert.deepEqual(seen, []);

		// One complete child write makes the callback boundary unambiguous.
		screen.write(encoder.encode("\r\x1b[2K\x1b[31mafter\x1b[0m"));
		assert.deepEqual(seen, [], "notification must wait for the parse callback");
		rendered(await screen.observe(), "after");
		assert.deepEqual(seen, ["after"]);
		await screen.observe();
		assert.deepEqual(seen, ["after"], "observe's internal ED3 must not notify");
	});

	it("stops notifying immediately after unsubscribe, including a queued child write", async (t) => {
		const screen = terminal(t);
		let calls = 0;
		const unsubscribe = screen.onChange(() => { calls++; });
		screen.write(encoder.encode("first"));
		await screen.observe();
		assert.equal(calls, 1);
		screen.write(encoder.encode(" queued"));
		unsubscribe();
		unsubscribe();
		await screen.observe();
		fragmented(screen, " later");
		await screen.observe();
		assert.equal(calls, 1);
		assert.equal(screen.snapshot().text, "first queued later");
	});

	it("clears subscribers on release before pending writes parse and ignores subsequent writes", async (t) => {
		const replies: string[] = [];
		const screen = terminal(t, 20, 3, (bytes) => replies.push(decoder.decode(bytes)));
		let calls = 0;
		screen.onChange(() => { calls++; });
		screen.write(encoder.encode("first"));
		await screen.observe();
		assert.equal(calls, 1);
		screen.write(encoder.encode(" queued\x1b[6n"));
		await screen.release();
		assert.deepEqual(replies, ["\x1b[1;13R"], "release must still parse pending child output");
		assert.equal(calls, 1);
		screen.write(encoder.encode("ignored\x1b[6n"));
		await screen.release();
		assert.equal(calls, 1);
		assert.deepEqual(replies, ["\x1b[1;13R"]);
	});
});
