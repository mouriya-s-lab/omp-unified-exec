import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import type { HostSettings } from "../fork-features/brush/omp-host.ts";
import {
	BrushOutput,
	type ArtifactAllocation,
	type OutputArtifactOwner,
	type OutputServices,
} from "../fork-features/brush/output.ts";

interface FixtureHooks {
	readonly beforeGraphics?: () => void;
	readonly onReplace?: () => void;
}

interface Fixture {
	readonly root: string;
	readonly path: string;
	readonly output: BrushOutput;
}

// These services only drive BrushOutput's public callbacks. Their text/graphics
// projections are not the subject of assertions; the real artifact is.
function services(hooks: FixtureHooks): OutputServices {
	return {
		asyncInlineMaxChars: 12_000,
		budgets: () => ({ spillThreshold: 1024, headBytes: 256, maxColumns: 80 }),
		createSink: (_budgets, onChunk) => {
			let output = "";
			return {
				push(text) { output += text; onChunk(text); },
				replace(text) { hooks.onReplace?.(); output = text; },
				async dump() {
					const bytes = Buffer.byteLength(output);
					const lines = output === "" ? 0 : output.split("\n").length;
					return { output, truncated: false, totalLines: lines, totalBytes: bytes, outputLines: lines, outputBytes: bytes };
				},
				async dispose() {},
			};
		},
		createGraphicsDecoder: () => ({
			push(text) { hooks.beforeGraphics?.(); return text; },
			finish: () => "",
			images: async () => [],
		}),
		enforceInlineByteCap: async (text) => text,
		formatArtifactErrorNotice: (error) => `Artifact ${error} failed`,
	};
}

const artifactId = "brush-output-regression";
const inlineOnly = { kind: "inline-only", reason: "artifact-unavailable" };
const allocated = (path: string): OutputArtifactOwner => ({
	allocateArtifactPath: async () => ({ id: artifactId, path }),
});

async function withOutput(
	owner: (path: string, root: string) => OutputArtifactOwner | undefined,
	run: (fixture: Fixture) => Promise<void>,
	hooks: FixtureHooks = {},
): Promise<void> {
	const root = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "brush-output-") : "/tmp/brush-output-");
	const path = join(root, "raw-output");
	// HostSettings is opaque. This fixture never reads settings; budgets are fixed.
	const settings = {} as HostSettings;
	const output = new BrushOutput(services(hooks), settings, owner(path, root), () => {});
	try {
		await run({ root, path, output });
	} finally {
		try { await output.dispose(); }
		finally { rmSync(root, { recursive: true, force: true }); }
	}
}

function assertInlineOnly(output: BrushOutput): void {
	assert.equal(output.authority.kind, "inline-only");
	assert.equal(output.logPath, undefined);
}


// Builtin patches below exist only across a synchronous push/close invocation,
// never across an await. Each restores both default and ESM exports in finally.
describe("BrushOutput real artifact authority and lifecycle", { concurrency: false }, () => {
	it("archives exact native UTF-8 bytes before graphics and publishes a link only after successful close", async () => {
		const chunks = ["雪 café 𠮷 🐚\n", "progress 1\rprogress 2\0tail\n", "\x1b[31mred\x1b[0m\x1b_Ga=T,f=100;AAAA\x1b\\\n"];
		let expected = Buffer.alloc(0);
		let artifactPath = "";
		await withOutput(allocated, async ({ path, output }) => {
			artifactPath = path;
			assertInlineOnly(output);
			await output.prepare(new AbortController().signal);
			assert.ok(statSync(path).isFile());
			assertInlineOnly(output);
			for (const chunk of chunks) {
				expected = Buffer.concat([expected, Buffer.from(chunk, "utf8")]);
				output.push(chunk);
				assertInlineOnly(output);
			}
			await output.close(false);
			assert.deepEqual(readFileSync(path), Buffer.from(chunks.join(""), "utf8"));
			assert.deepEqual(output.authority, { kind: "artifact-backed", artifactId });
			assert.equal(output.logPath, `artifact://${artifactId}`);
			assert.deepEqual((await output.finalize(undefined)).authority, output.authority);
		}, {
			// This read is downstream of the archive write, not a fake decoder assertion.
			beforeGraphics: () => { assert.deepEqual(readFileSync(artifactPath), expected); },
		});
	});

	it("successfully closes an allocated empty real artifact", async () => {
		await withOutput(allocated, async ({ path, root, output }) => {
			await output.prepare(new AbortController().signal);
			assertInlineOnly(output);
			await output.close(false);
			assert.ok(statSync(path).isFile());
			assert.deepEqual(readFileSync(path), Buffer.alloc(0));
			assert.deepEqual(readdirSync(root), ["raw-output"]);
			assert.deepEqual(output.authority, { kind: "artifact-backed", artifactId });
			assert.equal(output.logPath, `artifact://${artifactId}`);
		});
	});

	const unavailableOwners: readonly {
		readonly name: string;
		readonly owner: OutputArtifactOwner | undefined;
		readonly error?: "open";
	}[] = [
		{ name: "absent allocator", owner: undefined },
		{ name: "allocator without an allocation", owner: { allocateArtifactPath: async () => ({}) } },
		{ name: "rejecting allocator", owner: { allocateArtifactPath: async () => { throw new Error("allocation unavailable"); } }, error: "open" },
	];
	for (const { name, owner, error } of unavailableOwners) {
		it(`keeps ${name} inline-only without creating an alternate artifact or reference`, async () => {
			await withOutput(() => owner, async ({ root, output }) => {
				await output.prepare(new AbortController().signal);
				output.push("native text without artifact storage\n");
				const projection = await output.finalize(undefined);
				const expected = error ? { ...inlineOnly, artifactError: error } : inlineOnly;
				assert.deepEqual(output.authority, expected);
				assert.deepEqual(projection.authority, expected);
				assertInlineOnly(output);
				assert.deepEqual(readdirSync(root), []);
			});
		});
	}

	it("keeps an invalid directory allocation inline-only after subsequent output and finalization", async () => {
		await withOutput((_path, root) => allocated(root), async ({ root, output }) => {
			await output.prepare(new AbortController().signal);
			assert.deepEqual(output.authority, { ...inlineOnly, artifactError: "open" });
			output.push("text remains observable after open fails\n");
			await output.finalize(undefined);
			assert.deepEqual(output.authority, { ...inlineOnly, artifactError: "open" });
			assertInlineOnly(output);
			assert.ok(statSync(root).isDirectory());
			assert.deepEqual(readdirSync(root), []);
		});
	});

	it("cancellation physically closes its descriptor without claiming a completed artifact", async (t) => {
		await withOutput(allocated, async ({ path, output }) => {
			await output.prepare(new AbortController().signal);
			const text = "abandoned native text\n";
			output.push(text);
			const artifact = statSync(path);
			const realClose = fs.closeSync;
			const descriptors: number[] = [];
			const close = t.mock.method(fs, "closeSync", (fd: number) => {
				const file = fstatSync(fd);
				if (file.dev === artifact.dev && file.ino === artifact.ino) descriptors.push(fd);
				realClose(fd);
			});
			let closing: Promise<void>;
			try {
				syncBuiltinESMExports();
				closing = output.dispose();
			} finally {
				close.mock.restore();
				syncBuiltinESMExports();
			}
			assert.equal(descriptors.length, 1);
			assert.throws(() => fstatSync(descriptors[0]), { code: "EBADF" });
			await closing;
			assert.deepEqual(output.authority, inlineOnly);
			assertInlineOnly(output);
			output.push("late text must not reopen the closed archive\n");
			await output.close(false);
			assert.deepEqual(readFileSync(path), Buffer.from(text));
			assert.deepEqual(output.authority, inlineOnly);
			assertInlineOnly(output);
		});
	});

	for (const cancellation of ["abort signal", "dispose"] as const) {
		it(`does not open a deferred allocation's late path after ${cancellation}`, async () => {
			const allocation = Promise.withResolvers<ArtifactAllocation>();
			await withOutput(() => ({ allocateArtifactPath: () => allocation.promise }), async ({ path, root, output }) => {
				const controller = new AbortController();
				const preparing = output.prepare(controller.signal);
				if (cancellation === "abort signal") controller.abort();
				else await output.dispose();
				allocation.resolve({ id: artifactId, path });
				await preparing;
				assert.equal(existsSync(path), false);
				assert.deepEqual(readdirSync(root), []);
				assert.deepEqual(output.authority, inlineOnly);
				assertInlineOnly(output);
			});
		});
	}

	it("first-write failure closes the real artifact, creates no alternate, and forbids minimizer replacement", async (t) => {
		let replacements = 0;
		await withOutput(allocated, async ({ path, root, output }) => {
			await output.prepare(new AbortController().signal);
			const text = "brush-output-first-write-failure: 雪\0\r\x1b[31m\n";
			const payload = Buffer.from(text);
			const artifact = statSync(path);
			const realWrite = fs.writeSync;
			const failedDescriptors: number[] = [];
			function failWrite(
				fd: number, data: NodeJS.ArrayBufferView | string,
				offsetOrPosition?: number | null, lengthOrEncoding?: number | BufferEncoding | null, position?: number | null,
			): number {
				if (typeof data === "string") {
					return realWrite(fd, data, offsetOrPosition, typeof lengthOrEncoding === "number" ? undefined : lengthOrEncoding);
				}
				const offset = offsetOrPosition ?? 0;
				const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.byteLength - offset;
				const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(offset, offset + length);
				const file = fstatSync(fd);
				if (file.dev === artifact.dev && file.ino === artifact.ino && bytes.equals(payload)) {
					failedDescriptors.push(fd);
					throw new Error("injected first native artifact write failure");
				}
				return realWrite(fd, data, offsetOrPosition ?? undefined, typeof lengthOrEncoding === "number" ? lengthOrEncoding : undefined, position);
			}
			const write = t.mock.method(fs, "writeSync", failWrite);
			try {
				syncBuiltinESMExports();
				output.push(text);
			} finally {
				write.mock.restore();
				syncBuiltinESMExports();
			}
			assert.equal(failedDescriptors.length, 1, "the scoped injection must intercept the artifact's first write");
			assert.throws(() => fstatSync(failedDescriptors[0]), { code: "EBADF" });
			assert.deepEqual(output.authority, { ...inlineOnly, artifactError: "write" });
			assertInlineOnly(output);
			output.push("subsequent native text must not reopen or replace the failed artifact\n");
			const projection = await output.finalize("MINIMIZED: this must not replace unsaved native text");
			assert.deepEqual(projection.authority, { ...inlineOnly, artifactError: "write" });
			assertInlineOnly(output);
			assert.equal(replacements, 0, "an unsaved raw stream cannot authorize minimizer replacement");
			assert.deepEqual(readFileSync(path), Buffer.alloc(0));
			assert.deepEqual(readdirSync(root), ["raw-output"]);
		}, { onReplace: () => { replacements++; } });
	});
});
