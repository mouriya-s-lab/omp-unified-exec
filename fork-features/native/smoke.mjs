#!/usr/bin/env node
// Model-free Brush probe (#28 acceptance row 19): load the native addon and
// check the embedded shell's builtins, Git Guard and stdin.
//
//   node fork-features/native/smoke.mjs <path/to/addon.node>   # a build
//   node fork-features/native/smoke.mjs --installed            # the leaf package
//                                                              # the plugin loads
import assert from "node:assert/strict";
import { createRequire } from "node:module";

async function loadAddon(arg) {
	if (arg !== "--installed") return createRequire(import.meta.url)(arg);
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
} finally {
	await shell.dispose();
}
console.log("brush smoke ok");
