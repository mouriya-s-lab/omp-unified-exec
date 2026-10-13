/**
 * Opt-in real omp installer contract. No model/session or external registry is used.
 * EXPECT_TERN_INSTALL_CLI=1 OMP_TEST_BINARY=/absolute/path/to/omp npm test
 *
 * The package fixture awaits the current initializer (not a reimplementation).
 * Only Tern's owner API is substituted, with a stateful normal-copy installer.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
	readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../src/shell.ts";

const requested = process.env.EXPECT_TERN_INSTALL_CLI === "1";
const resolvedOmp = process.env.OMP_TEST_BINARY ?? findOnPath("omp");
const project = fileURLToPath(new URL("../", import.meta.url));
const bundle = ["plugin.toml", "terminals.css", "window.luau"] as const;
const packageName = "tern-install-cli-fixture";
const pluginId = "omp-unified-exec";

// Executed by the real initializer through PATH. The catalog is derived from
// the actual normal copy, so a reported success alone cannot satisfy the test.
const ternFixture = `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.TERN_FIXTURE_ROOT;
const id = "omp-unified-exec";
const destination = join(root, id);
const files = ["plugin.toml", "terminals.css", "window.luau"];
const version = dir => readFileSync(join(dir, "plugin.toml"), "utf8").match(/^version\\s*=\\s*"([^"]+)"/m)[1];
const reply = value => console.log(JSON.stringify(value));
const args = process.argv.slice(2);
if (args[0] !== "plugin") throw new Error("Unexpected Tern command");
switch (args[1]) {
  case "dir":
    if (args.length !== 3 || args[2] !== "--json") throw new Error("Unexpected dir arguments");
    reply({ dir: root });
    break;
  case "list":
    if (args.length !== 3 || args[2] !== "--json") throw new Error("Unexpected list arguments");
    reply({ plugins: existsSync(destination) ? [{ id, version: version(destination), status: "ready", css: readFileSync(join(destination, "terminals.css"), "utf8") }] : [] });
    break;
  case "install":
    if (args.length !== 5 || args[3] !== "--force" || args[4] !== "--json") throw new Error("Expected normal force copy, not developer link");
    if (process.env.TERN_FIXTURE_FAIL_INSTALL === "1") {
      console.error("fixture Tern owner refused normal copy");
      process.exit(23);
    }
    await mkdir(destination, { recursive: true });
    for (const file of files) await copyFile(join(args[2], file), join(destination, file));
    reply({ id, version: version(destination), dir: destination });
    break;
  default:
    throw new Error("Unexpected Tern operation: " + args[1]);
}
`;

function command(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const result = spawnSync(binary, args, {
		cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(result.error, undefined, `${binary}: ${String(result.error)}\n${result.stderr}\n${result.stdout}`);
	return result;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
	const result = command("git", args, cwd, env);
	assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
}

/** Include every installed package byte, mode, and symlink target in rollback checks. */
function snapshot(root: string): Map<string, string> {
	const entries = new Map<string, string>();
	function visit(path: string, relative: string): void {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) entries.set(relative, `link:${readlinkSync(path)}`);
		else if (stat.isDirectory()) {
			entries.set(relative, `directory:${stat.mode}`);
			for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
		} else {
			assert.ok(stat.isFile(), `Unexpected special file ${path}`);
			entries.set(relative, `${stat.mode}:${readFileSync(path).toString("base64")}`);
		}
	}
	visit(root, "");
	return entries;
}

function pluginMetadata(root: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const name of readdirSync(root).sort()) {
		if (name === "node_modules") continue;
		for (const [path, value] of snapshot(join(root, name))) entries.set(`${name}${path}`, value);
	}
	return entries;
}

function normalCopy(root: string, source: string): void {
	const destination = join(root, pluginId);
	assert.equal(existsSync(join(root, `${pluginId}.path`)), false, "No developer-link registration");
	assert.equal(lstatSync(destination).isSymbolicLink(), false);
	assert.ok(lstatSync(destination).isDirectory());
	assert.deepEqual(readdirSync(destination).sort(), [...bundle].sort());
	for (const file of bundle) {
		assert.ok(lstatSync(join(destination, file)).isFile());
		assert.deepEqual(readFileSync(join(destination, file)), readFileSync(join(source, file)), file);
	}
}

function copyIdentity(root: string): string[] {
	return bundle.map(file => {
		const stat = lstatSync(join(root, pluginId, file));
		return `${file}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
	});
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const closed = Promise.withResolvers<void>();
	server.close(error => error ? closed.reject(error) : closed.resolve());
	await closed.promise;
	return address.port;
}

async function waitForDaemon(daemon: ChildProcess, diagnostic: () => string): Promise<void> {
	assert.ok(daemon.stderr);
	const lines = createInterface({ input: daemon.stderr });
	const ready = Promise.withResolvers<void>();
	const deadline = AbortSignal.timeout(5000);
	const onTimeout = () => ready.reject(new Error(`Git daemon readiness timed out: ${diagnostic()}`));
	const onExit = () => ready.reject(new Error(`Git daemon exited before readiness: ${diagnostic()}`));
	const onError = (error: Error) => ready.reject(error);
	deadline.addEventListener("abort", onTimeout, { once: true });
	daemon.once("exit", onExit);
	daemon.once("error", onError);
	lines.on("line", line => { if (line.includes("Ready to rumble")) ready.resolve(); });
	try { await ready.promise; } finally {
		deadline.removeEventListener("abort", onTimeout);
		daemon.removeListener("exit", onExit);
		daemon.removeListener("error", onError);
		lines.close();
	}
}

async function stopDaemon(daemon: ChildProcess): Promise<void> {
	if (daemon.pid === undefined || daemon.exitCode !== null || daemon.signalCode !== null) return;
	const exited = once(daemon, "exit");
	daemon.kill("SIGTERM");
	await exited;
}

test("real omp force install awaits normal Tern copy and rolls back an owner failure", {
	skip: !requested,
	timeout: 240_000,
}, async () => {
	assert.ok(resolvedOmp && existsSync(resolvedOmp), "EXPECT_TERN_INSTALL_CLI=1 requires omp on PATH or OMP_TEST_BINARY pointing to a real omp host");
	const omp = resolvedOmp;
	assert.notEqual(process.platform, "win32", "This opt-in git daemon/executable fixture requires a POSIX host");
	const root = mkdtempSync("/tmp/tern-install-cli-");
	let daemon: ChildProcess | undefined;
	try {
		const home = join(root, "home");
		const temporary = join(root, "tmp");
		const cache = join(root, "bun-cache");
		const bin = join(root, "bin");
		const checkout = join(root, "checkout");
		const served = join(root, "served");
		const bare = join(served, "fixtures", "repo.git");
		const ternRoot = join(root, "tern-plugins");
		for (const dir of [home, temporary, cache, bin, checkout, bare, ternRoot]) mkdirSync(dir, { recursive: true });
		// Do not inherit config-root overrides, Tern sockets, model credentials,
		// or git operator configuration. The only remote is the loopback daemon.
		const env: NodeJS.ProcessEnv = {
			PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
			HOME: home, PI_CONFIG_DIR: ".omp", TMPDIR: temporary, TMP: temporary, TEMP: temporary,
			XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
			BUN_INSTALL_CACHE_DIR: cache, TERN_FIXTURE_ROOT: ternRoot,
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
			GIT_ALLOW_PROTOCOL: "file:git", npm_config_registry: "http://127.0.0.1:1",
			TERM: "dumb", NO_COLOR: "1", LANG: "en_US.UTF-8",
		};
		const tern = join(bin, "tern");
		writeFileSync(tern, ternFixture);
		chmodSync(tern, 0o755);
		const assets = join(checkout, "fork-features", "tern-plugin");
		mkdirSync(assets, { recursive: true });
		mkdirSync(join(checkout, "src"));
		for (const file of ["fork-features/tern-plugin-install.ts", "src/shell.ts", "src/output-safety.ts"]) {
			copyFileSync(join(project, file), join(checkout, file));
		}
		for (const file of bundle) copyFileSync(join(project, "fork-features", "tern-plugin", file), join(assets, file));
		writeFileSync(join(checkout, "package.json"), JSON.stringify({
			name: packageName, version: "1.0.0", type: "module", pi: { extensions: ["./index.ts"] },
		}));
		writeFileSync(join(checkout, "index.ts"),
			'import { initializeTernPlugin } from "./fork-features/tern-plugin-install.ts";\n' +
			'export default async function () { await initializeTernPlugin(); }\n');
		git(["init", "--bare", "--initial-branch=main"], bare, env);
		git(["init", "--initial-branch=main"], checkout, env);
		git(["config", "user.name", "CLI Fixture"], checkout, env);
		git(["config", "user.email", "cli-fixture@example.invalid"], checkout, env);
		git(["remote", "add", "origin", bare], checkout, env);
		function publish(message: string): void {
			git(["add", "."], checkout, env);
			git(["commit", "-m", message], checkout, env);
			git(["push", "origin", "main"], checkout, env);
		}
		publish("initial bundled assets");
		const port = await unusedPort();
		let daemonOutput = "";
		daemon = spawn("git", ["daemon", "--verbose", "--reuseaddr", "--export-all", "--listen=127.0.0.1",
			`--port=${port}`, `--base-path=${served}`, served], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
		daemon.stdout?.on("data", chunk => { daemonOutput += String(chunk); });
		daemon.stderr?.on("data", chunk => { daemonOutput += String(chunk); });
		const daemonError: Error[] = [];
		daemon.on("error", error => { daemonError.push(error); });
		await waitForDaemon(daemon, () => `${daemonOutput}\n${daemonError.join("\n")}`);
		const url = `git://127.0.0.1:${port}/fixtures/repo.git`;
		function success(): void {
			const result = command(omp, ["install", url, "--force"], root, env);
			assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
			normalCopy(ternRoot, assets);
		}
		success();
		const plugins = join(home, ".omp", "plugins");
		const installed = join(plugins, "node_modules", packageName);
		const installedAssets = join(installed, "fork-features", "tern-plugin");
		assert.ok(existsSync(join(plugins, "bun.lock")), "Real host must record a Bun lock");
		normalCopy(ternRoot, installedAssets);
		const originalManifest = readFileSync(join(assets, "plugin.toml"), "utf8");
		writeFileSync(join(assets, "terminals.css"), `${readFileSync(join(assets, "terminals.css"), "utf8")}\n/* same-version CLI update */\n`);
		writeFileSync(join(assets, "window.luau"), `${readFileSync(join(assets, "window.luau"), "utf8")}\n-- same-version CLI update\n`);
		publish("changed assets without changing version");
		success();
		assert.equal(readFileSync(join(installedAssets, "plugin.toml"), "utf8"), originalManifest);
		normalCopy(ternRoot, installedAssets);
		const currentCopy = snapshot(join(ternRoot, pluginId));
		const currentIdentity = copyIdentity(ternRoot);
		success();
		assert.deepEqual(snapshot(join(ternRoot, pluginId)), currentCopy);
		assert.deepEqual(copyIdentity(ternRoot), currentIdentity, "Already-current Tern copy must not be rewritten");

		const previousPackage = snapshot(installed);
		const previousMetadata = pluginMetadata(plugins);
		const previousLock = readFileSync(join(plugins, "bun.lock"));
		writeFileSync(join(assets, "terminals.css"), `${readFileSync(join(assets, "terminals.css"), "utf8")}\n/* rejected candidate */\n`);
		publish("candidate rejected by Tern owner");
		const failure = command(omp, ["install", url, "--force"], root,
			{ ...env, TERN_FIXTURE_FAIL_INSTALL: "1" });
		assert.notEqual(failure.status, 0, `${failure.stderr}\n${failure.stdout}`);
		assert.match(`${failure.stderr}\n${failure.stdout}`, /fixture Tern owner refused normal copy/,
			"Failure must originate in the present Tern owner, not dependency resolution");
		assert.deepEqual(snapshot(installed), previousPackage, "Rejected force update must restore installed package");
		assert.deepEqual(readFileSync(join(plugins, "bun.lock")), previousLock);
		assert.deepEqual(pluginMetadata(plugins), previousMetadata, "Rejected update must preserve plugin metadata");
		assert.deepEqual(snapshot(join(ternRoot, pluginId)), currentCopy);
		assert.deepEqual(copyIdentity(ternRoot), currentIdentity);
		assert.ok(![...snapshot(home).keys()].some(path => path.split("/").includes("sessions")),
			"All synchronization happens during installation, before any omp session exists");
	} finally {
		try {
			if (daemon) await stopDaemon(daemon);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
