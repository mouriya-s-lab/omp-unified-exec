import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TextDecoder } from "node:util";

import { OutputTextSanitizer, sanitizeOutputText } from "../src/output-safety.ts";

describe("sanitizeOutputText", () => {
	it("strips SGR and terminal-mode CSI sequences while retaining text", () => {
		assert.equal(
			sanitizeOutputText("before\x1b[31mred\x1b[0m\x1b[?1049h\x1b[>7uafter"),
			"beforeredafter",
		);
	});

	it("strips OSC clipboard/title strings with BEL or ST terminators", () => {
		assert.equal(
			sanitizeOutputText("a\x1b]52;c;YXR0YWNrZXI=\x07b\x1b]0;title\x1b\\c"),
			"abc",
		);
	});

	it("strips DCS, 8-bit CSI, and remaining C0/C1 controls", () => {
		assert.equal(sanitizeOutputText("a\x1bPpayload\x1b\\b\x9b2Jc\x00\x07\x7fd"), "abcd");
	});

	it("keeps tabs and newlines but removes carriage returns", () => {
		assert.equal(sanitizeOutputText("a\tb\rprogress\nc"), "a\tbprogress\nc");
	});

	it("preserves valid Unicode while removing lone surrogates and unsafe format controls", () => {
		assert.equal(sanitizeOutputText("a🎉\ud800b\udc00c\ufff9d"), "a🎉bcd");
	});

	it("swallows an unterminated terminal string instead of leaking its payload", () => {
		assert.equal(sanitizeOutputText("safe\x1b]52;c;secret"), "safe");
	});
});

describe("streaming output sanitation", () => {
	it("preserves the control grammar across every UTF-8 byte split", () => {
		const corpus: Array<readonly [string, string]> = [
			["\x1b[31m".repeat(220) + "KEYWORD\n", "KEYWORD\n"],
			["a\x1b]0;hidden\nKEYWORD\x07visible\n", "avisible\n"],
			["a\x1b]0;hidden\x1b\x1b\\b", "ab"],
			["a\x1b]0;hidden\x1b!\x07b", "ab"],
			["a\x1bPhidden\x07still hidden\x1b\\b", "ab"],
			["a\x1bXhidden\x1b\\b\x1b^hidden\x1b\\c\x1b_hidden\x1b\\d", "abcd"],
			["a\x9dhidden\n\x9cb\x90hidden\x9cc\x9b31md", "abcd"],
			["a\x1b[12\nb\x1b[ \x18c\x1b[1\x1ad", "a\nbcd"],
			["a\x1b(Bb\x1b\nc\r\t\n", "abc\t\n"],
			["中文\x1b[31mKEY\x1b[0mWORD🎉\n", "中文KEYWORD🎉\n"],
			["visible\x1b]unterminated\nKEYWORD", "visible"],
			["visible\x1bPunterminated\nKEYWORD", "visible"],
			["visible\x1b[12", "visible"],
		];
		const encoder = new TextEncoder();
		for (const [input, expected] of corpus) {
			assert.equal(sanitizeOutputText(input), expected);
			const bytes = encoder.encode(input);
			for (let cut = 0; cut <= bytes.length; cut++) {
				const decoder = new TextDecoder("utf-8", { fatal: false });
				let actual = "";
				const sanitizer = new OutputTextSanitizer((text, start, end) => { actual += text.slice(start, end); });
				sanitizer.write(decoder.decode(bytes.subarray(0, cut), { stream: true }));
				sanitizer.write(decoder.decode(bytes.subarray(cut), { stream: true }));
				sanitizer.write(decoder.decode());
				assert.equal(actual, expected, `byte split ${cut} of ${JSON.stringify(input)}`);
			}
			const decoder = new TextDecoder("utf-8", { fatal: false });
			let actual = "";
			const sanitizer = new OutputTextSanitizer((text, start, end) => { actual += text.slice(start, end); });
			for (let i = 0; i < bytes.length; i++) sanitizer.write(decoder.decode(bytes.subarray(i, i + 1), { stream: true }));
			sanitizer.write(decoder.decode());
			assert.equal(actual, expected, "one-byte partitions");
		}
	});
});
