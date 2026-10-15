#!/usr/bin/env node
// Model-free Brush probe (#28 acceptance row 19): load the native addon and
// check the embedded shell's builtins, Git Guard and stdin.
//
//   node fork-features/native/smoke.mjs <path/to/addon.node>   # a build
//   node fork-features/native/smoke.mjs --installed            # the leaf package
//                                                              # the plugin loads
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

async function loadAddon(arg) {
	if (arg !== "--installed") return createRequire(import.meta.url)(resolve(arg));
	const { loadNativeShell } = await import("../brush/native.ts");
	const load = loadNativeShell();
	if (load.kind !== "loaded") throw new Error(`native shell unavailable: ${load.reason}`);
	return load.module;
}

async function run(native, shell, command, input) {
	const stdin = new native.ShellStdin();
	let output = "";
	const result = shell.run({ command, cwd: process.cwd() }, stdin, (error, chunk) => {
		if (!error) output += chunk;
	});
	if (input !== undefined) await stdin.write(new TextEncoder().encode(input));
	const settled = await result;
	return { output, exitCode: settled.exitCode };
}

const native = await loadAddon(process.argv[2]);
const shell = new native.Shell({ sessionEnv: { PI_GIT_GUARD: "1" } });
try {
	const types = await run(native, shell, "type cat; type git");
	console.log(JSON.stringify(types));
	assert.match(types.output, /cat is a shell builtin/);
	assert.match(types.output, /git is a shell builtin/);
	const head = await run(native, shell, "head -1", "brush-stdin-line\nsecond\n");
	console.log(JSON.stringify(head));
	assert.equal(head.output.replace(/\r\n/g, "\n"), "brush-stdin-line\n");
	assert.equal(head.exitCode, 0);

	// A cancelled write must release backpressure without closing stdin or
	// leaving a detached write that later delivers the rest of the payload.
	const stdin = new native.ShellStdin();
	const cancellation = new AbortController();
	const payload = Buffer.alloc(4 * 1024 * 1024, 120);
	const marker = "\nbrush-after-cancel\n";
	let ended = false;
	let outputBytes = 0;
	let outputTail = "";
	const reading = shell.run({ command: "sleep 1; cat", cwd: process.cwd() }, stdin, (error, chunk) => {
		if (error) throw error;
		outputBytes += Buffer.byteLength(chunk);
		outputTail = (outputTail + chunk).slice(-64);
	}).then((result) => {
		ended = true;
		return result;
	});
	const writing = stdin.write(payload, cancellation.signal);
	const timer = setTimeout(() => cancellation.abort(), 50);
	try {
		await assert.rejects(writing, /stdin_write_cancelled/);
	} finally {
		clearTimeout(timer);
	}
	assert.equal(ended, false, "cancelling a write does not cancel the command");
	await stdin.write(Buffer.from(marker));
	stdin.close();
	const afterCancel = await reading;
	assert.equal(afterCancel.exitCode, 0);
	assert.equal(afterCancel.cancelled, false);
	assert.ok(outputTail.endsWith(marker), "the same stdin still accepts the next write");
	assert.ok(outputBytes < payload.length + Buffer.byteLength(marker), "the cancelled remainder was not delivered later");
	console.log(JSON.stringify({ writeCancelled: true, resumed: true, outputBytes, exitCode: afterCancel.exitCode }));

	// A successful large write is acknowledged only after the pipe accepts
	// it, and EOF must deliver every byte in order before the command exits.
	const accepted = new native.ShellStdin();
	let acceptedBytes = 0;
	const complete = shell.run({ command: "sleep 0.2; cat", cwd: process.cwd() }, accepted, (error, chunk) => {
		if (error) throw error;
		const bytes = Buffer.from(chunk);
		assert.ok(bytes.equals(payload.subarray(acceptedBytes, acceptedBytes + bytes.length)));
		acceptedBytes += bytes.length;
	});
	let acknowledged = false;
	const largeWrite = accepted.write(payload).then(() => { acknowledged = true; });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(acknowledged, false, "a non-reading command does not acknowledge a heap-buffered write");
	await largeWrite;
	accepted.close();
	assert.equal((await complete).exitCode, 0);
	assert.equal(acceptedBytes, payload.length);
	console.log(JSON.stringify({ largeWriteBytes: acceptedBytes, ordered: true, eof: true }));

	const closing = new native.ShellStdin();
	const closeRun = shell.run({ command: "sleep 0.2; cat", cwd: process.cwd() }, closing, (error) => {
		if (error) throw error;
	});
	const closeWrite = closing.write(payload);
	closing.close();
	await assert.rejects(closeWrite, /stdin_closed/);
	assert.equal((await closeRun).exitCode, 0);

	const preaborted = new native.ShellStdin();
	const beforeSubmission = new AbortController();
	beforeSubmission.abort();
	await assert.rejects(async () => preaborted.write(payload, beforeSubmission.signal), /stdin_write_cancelled/);
	preaborted.close();
	console.log(JSON.stringify({ closedPendingWrite: true, cancelledBeforeSubmission: true }));
} finally {
	await shell.dispose();
}
console.log("brush smoke ok");
