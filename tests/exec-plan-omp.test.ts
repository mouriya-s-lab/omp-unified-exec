import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findOnPath } from "../src/shell.ts";

const requested = process.env.EXPECT_OMP_EXEC_PLAN === "1";

test("registered URL cwd bypasses local stat and preserves the host-extracted command", {
	skip: !requested,
	timeout: 45_000,
}, () => {
	const omp = process.env.OMP_TEST_BINARY ?? findOnPath("omp");
	assert.ok(omp, "EXPECT_OMP_EXEC_PLAN=1 requires the real compiled omp host");
	const cwd = mkdtempSync("/tmp/exec-plan-omp-");
	try {
		// A one-shot, model-free RPC consumer: EOF is present from startup.
		const result = spawnSync(omp, [
			"--mode", "rpc", "--no-ui", "--no-extensions", "--no-session",
			"--no-skills", "--no-rules", "--no-lsp", "--no-title", "--cwd", cwd,
			"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
			"-e", fileURLToPath(new URL("./fixtures/exec-plan-url-probe.mjs", import.meta.url)),
		], { input: "", encoding: "utf8", timeout: 40_000, maxBuffer: 2 * 1024 * 1024 });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		const record = result.stderr.split("\n").find((line) => line.startsWith("UEXEC_PLAN_URL_RESULTS="));
		assert.ok(record, result.stderr);
		const plans: unknown = JSON.parse(record.slice("UEXEC_PLAN_URL_RESULTS=".length));
		assert.deepEqual(plans, [
			{ rawCommand: "cd local:// && pwd", command: "pwd", cwd: "local://" },
			{ rawCommand: "pwd", command: "pwd", cwd: "local://x" },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
