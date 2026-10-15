import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { renderInvocation } from "../fork-features/brush/worktree.ts";
import { getPtyLoadError, isPtyAvailable, spawnChild, type SpawnOptions } from "../src/pty.ts";
import { buildShellCommand, findOnPath, IS_WINDOWS } from "../src/shell.ts";

const literalArgs = [
	"with spaces",
	'embedded"quote',
	"trailing\\",
	"space and trailing\\",
	"%PATH%",
	"!name!",
	"^",
	"&",
	"|",
	"<",
	">",
	"()",
	"apostrophe's",
	"Unicode 雪 café 𠮷",
	"--leading-dash",
];

interface ShellCase {
	readonly name: string;
	readonly syntax: "powershell" | "cmd";
	readonly bin: string | undefined;
	readonly required: boolean;
	readonly unavailable: string;
}

function windowsBuiltin(...parts: string[]): string | undefined {
	if (!IS_WINDOWS) return undefined;
	const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);
	return existsSync(candidate) ? candidate : undefined;
}

const shells: readonly ShellCase[] = [
	{
		name: "powershell",
		syntax: "powershell",
		bin: findOnPath("powershell", process.env, { exts: IS_WINDOWS ? [".exe", ""] : [""] })
			?? windowsBuiltin("WindowsPowerShell", "v1.0", "powershell.exe"),
		required: IS_WINDOWS,
		unavailable: "Windows PowerShell is unavailable on this platform",
	},
	{
		name: "pwsh",
		syntax: "powershell",
		bin: findOnPath("pwsh", process.env, { exts: IS_WINDOWS ? [".exe", ""] : [""] }),
		required: false,
		unavailable: "PowerShell Core (pwsh) is not installed",
	},
	{
		name: "cmd native executable (one escaping layer, no .cmd shim)",
		syntax: "cmd",
		bin: windowsBuiltin("cmd.exe"),
		required: IS_WINDOWS,
		unavailable: "cmd.exe requires Windows",
	},
];

interface ProcessResult {
	readonly output: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly failureMessage: string | undefined;
}

async function run(options: SpawnOptions): Promise<ProcessResult> {
	const child = spawnChild(options);
	const decoder = new TextDecoder();
	let output = "";
	try {
		return await new Promise<ProcessResult>((resolve, reject) => {
			// A real OS child can hang independently of JS time; this watchdog is
			// only a failure bound, not a sleep used to guess process readiness.
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`argv fixture timed out; output: ${JSON.stringify(output)}`));
			}, 30_000);
			child.onData((chunk) => { output += decoder.decode(chunk, { stream: true }); });
			child.onExit((exitCode, signal, failureMessage) => {
				clearTimeout(timer);
				output += decoder.decode();
				resolve({ output, exitCode, signal, failureMessage });
			});
		});
	} finally {
		child.kill("SIGKILL");
	}
}

function assertArgv(result: ProcessResult, expected: readonly string[]): void {
	assert.equal(result.failureMessage, undefined, result.output);
	assert.equal(result.signal, null, result.output);
	assert.equal(result.exitCode, 0, result.output);
	// PTYs may add terminal control sequences before/after the fixture's line.
	const payloads = [...result.output.matchAll(/WORKTREE_ARGV=(\[[^\r\n]*\])/g)];
	assert.equal(payloads.length, 1, result.output);
	const actual: unknown = JSON.parse(payloads[0][1]);
	assert.deepEqual(actual, expected, result.output);
}

describe("literal worktree invocation argv through real process backends", () => {
	let root: string;
	let executable: string;
	let script: string;
	before(() => {
		// Use a real native executable, not a .cmd shim that needs another escape pass.
		root = mkdtempSync(join(IS_WINDOWS ? tmpdir() : "/tmp", "worktree argv spaces "));
		executable = join(root, IS_WINDOWS ? "node fixture.exe" : "node fixture");
		script = join(root, "argv fixture.mjs");
		// Bun supplies its real Terminal backend, but the argv dumper must still run in Node.
		const node = "bun" in process.versions
			? execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim()
			: process.execPath;
		if (IS_WINDOWS) copyFileSync(node, executable);
		// Preserve loader-relative libraries for non-relocatable Unix Node builds.
		else symlinkSync(node, executable);
		copyFileSync(new URL("./fixtures/worktree-argv.mjs", import.meta.url), script);
	});
	after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

	for (const tty of [false, true]) {
		const backend = tty ? "PTY" : "Pipe";
		const missingPty = tty && !isPtyAvailable()
			? `optional PTY provider unavailable: ${getPtyLoadError() ?? "unknown reason"}`
			: false;

		for (const shell of shells) {
			const missingShell = !shell.bin && !shell.required ? shell.unavailable : false;
			it(`${backend}: ${shell.name} preserves exact literal argv`,
				{ skip: missingShell || (shell.bin ? missingPty : false) }, async () => {
					assert.ok(shell.bin, `required Windows shell ${shell.name} was not found`);
					const invocation = renderInvocation([executable, script, ...literalArgs], shell.syntax);
					const result = await run({
						...buildShellCommand(shell.bin, invocation),
						cwd: root,
						env: process.env,
						tty,
						cols: 240,
						rows: 40,
					});
					assertArgv(result, [script, ...literalArgs]);
				});
		}
	}
});
