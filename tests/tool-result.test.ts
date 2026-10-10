import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
} from "../src/tool-result.ts";
import type { TerminalObservation } from "../src/terminal-screen.ts";

const encoder = new TextEncoder();

function screenResult(observation: TerminalObservation) {
	return finalizeProcessResult({
		operation: "write_stdin",
		wallTimeSec: 0.1,
		collected: { kind: "screen", observation },
		sessionId: 5,
		exitCode: undefined,
		signal: null,
		failure: null,
		tty: true,
	});
}

describe("bounded tool results", () => {
	it("preserves the existing process response contract with explicit operation state", () => {
		const details = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 0.25,
			collected: { kind: "stream", bytes: encoder.encode("hello\nworld\n"), omittedBytes: 0 },
			totalBytes: 12,
			sessionId: 7,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: false,
			logPath: "/tmp/session.log",
			cwd: "/tmp",
			command: "printf hello",
			yieldTimeMs: 250,
		});

		assert.equal(details.operation, "exec_command");
		assert.equal(details.status, "running");
		assert.equal(details.running, true);
		assert.equal(details.session_id, 7);
		assert.equal(details.output, "hello\nworld\n");
		assert.match(renderProcessResultText(details), /^\[still running\]/);
	});

	it("bounds kill output and puts the recovery marker in model-visible text", () => {
		const raw = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, index) => `line-${index + 1}`).join("\n");
		const details = finalizeKillResult({
			wallTimeSec: 0.5,
			collected: { kind: "stream", bytes: encoder.encode(raw), omittedBytes: 0 },
			totalBytes: Buffer.byteLength(raw),
			sessionId: 42,
			pid: 1234,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: "SIGTERM",
			failure: null,
			tty: false,
			logPath: "/tmp/full.log",
			cwd: "/repo",
			command: "noisy-job",
			escalated: false,
			killed: true,
		});

		assert.equal(details.operation, "kill_session");
		assert.equal(details.status, "killed");
		assert.equal(details.running, false);
		assert.equal(details.killed, true);
		assert.ok(Buffer.byteLength(details.output, "utf8") <= DEFAULT_MAX_BYTES);
		assert.equal(details.truncation?.truncated, true);
		assert.equal(details.truncation?.outputLines, DEFAULT_MAX_LINES);
		assert.equal(Object.hasOwn(details, "final_output"), false);

		const text = renderKillResultText(details);
		assert.match(text, /^\[killed\]/);
		assert.match(text, /requested_signal: SIGTERM/);
		assert.match(text, /Showing lines/);
		assert.match(text, /Full output: \/tmp\/full\.log/);
		assert.ok(Buffer.byteLength(text, "utf8") < DEFAULT_MAX_BYTES + 4096, `text bytes=${Buffer.byteLength(text)}`);
	});

	it("bounds model-visible metadata outside the output body", () => {
		const huge = `bad\x1b]52;c;payload\x07${"x".repeat(100_000)}`;
		const details = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 0,
			collected: { kind: "stream", bytes: encoder.encode("small output"), omittedBytes: 0 },
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: huge,
			tty: false,
			cwd: huge,
		});
		const text = renderProcessResultText(details);

		assert.ok(Buffer.byteLength(text, "utf8") < 12_000, `text bytes=${Buffer.byteLength(text)}`);
		assert.doesNotMatch(text, /[\u001b\u009b]/);
		assert.match(text, /…/);
	});

	it("sanitizes stream-kind bytes even when tty is metadata", () => {
		const dangerous = "before\x1b]52;c;YXR0YWNrZXI=\x07after\x1b[?1049h";
		const details = finalizeProcessResult({
			operation: "write_stdin",
			wallTimeSec: 0.1,
			collected: { kind: "stream", bytes: encoder.encode(dangerous), omittedBytes: 0 },
			sessionId: 5,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: true,
		});

		assert.equal(details.output, "beforeafter");
		assert.equal(details.tty, true);
		assert.equal(details.terminal, undefined);
		assert.doesNotMatch(renderProcessResultText(details), /[\u001b\u009b]/);
	});

	it("projects a rendered tty screen with sanitized text and terminal header fields", () => {
		const details = screenResult({
			kind: "rendered",
			view: { screen: "alternate", cols: 80, rows: 24, cursor: { row: 3, col: 7 } },
			text: "before\x1b]52;c;YXR0YWNrZXI=\x07after",
			historyLines: 0,
			historyMayBeTruncated: false,
		});
		assert.equal(details.output, "beforeafter");
		assert.deepEqual(details.terminal, {
			screen: "alternate", cols: 80, rows: 24, cursor_row: 3, cursor_col: 7, screen_changed: true,
		});
		assert.equal(Object.hasOwn(details, "omitted_bytes"), false);
		const text = renderProcessResultText(details);
		assert.match(text, /^terminal: alternate screen 80x24, cursor row 3 col 7$/m);
		assert.doesNotMatch(text, /screen_changed: false|history_lines:|history_may_be_truncated:|omitted_bytes:|[\u001b\u009b]/);
	});

	it("projects unchanged tty screens as empty output with screen_changed false", () => {
		const details = screenResult({
			kind: "unchanged",
			view: { screen: "normal", cols: 40, rows: 5, cursor: { row: 2, col: 6 } },
		});
		assert.equal(details.output, "");
		assert.deepEqual(details.terminal, {
			screen: "normal", cols: 40, rows: 5, cursor_row: 2, cursor_col: 6, screen_changed: false,
		});
		assert.equal(Object.hasOwn(details, "omitted_bytes"), false);
		const text = renderProcessResultText(details);
		assert.match(text, /^terminal: normal screen 40x5, cursor row 2 col 6$/m);
		assert.match(text, /^screen_changed: false$/m);
		assert.doesNotMatch(text, /history_lines:|history_may_be_truncated:|omitted_bytes:/);
	});

	it("describes normal-screen history and its capacity warning in process and kill headers", () => {
		const observation: TerminalObservation = {
			kind: "rendered",
			view: { screen: "normal", cols: 80, rows: 24, cursor: { row: 24, col: 1 } },
			text: "old-1\nold-2\ncurrent",
			historyLines: 2,
			historyMayBeTruncated: true,
		};
		const process = screenResult(observation);
		const kill = finalizeKillResult({
			wallTimeSec: 0.1,
			collected: { kind: "screen", observation },
			sessionId: 5,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: "SIGTERM",
			failure: null,
			tty: true,
			escalated: false,
			killed: true,
		});
		for (const details of [process, kill]) {
			assert.equal(details.output, observation.text);
			assert.deepEqual(details.terminal, {
				screen: "normal", cols: 80, rows: 24, cursor_row: 24, cursor_col: 1, screen_changed: true,
				history_lines: 2, history_may_be_truncated: true,
			});
			assert.equal(Object.hasOwn(details, "omitted_bytes"), false);
		}
		for (const text of [renderProcessResultText(process), renderKillResultText(kill)]) {
			assert.match(text, /^terminal: normal screen 80x24, cursor row 24 col 1$/m);
			assert.match(text, /^history_lines: 2$/m);
			assert.match(text, /^history_may_be_truncated: true$/m);
			assert.doesNotMatch(text, /omitted_bytes:/);
		}
	});

	it("represents a failed kill as a live, retained session", () => {
		const details = finalizeKillResult({
			wallTimeSec: 2.5,
			collected: { kind: "stream", bytes: encoder.encode("last diagnostic\n"), omittedBytes: 0 },
			sessionId: 9,
			pid: 999,
			requestedSignal: "SIGTERM",
			exitCode: undefined,
			signal: null,
			failure: "process still running; session remains registered",
			tty: false,
			logPath: "/tmp/live.log",
			escalated: true,
			killed: false,
		});

		assert.equal(details.status, "kill_failed");
		assert.equal(details.running, true);
		assert.equal(details.killed, false);
		const text = renderKillResultText(details);
		assert.match(text, /^\[kill failed\]/);
		assert.match(text, /running: true/);
		assert.match(text, /session remains registered/);
	});
});
