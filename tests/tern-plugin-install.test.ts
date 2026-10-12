import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	ensureTernPlugin,
	inTernPane,
	outcomeNotice,
	parsePluginList,
	parsePluginVersion,
	planPluginAction,
	readPluginFiles,
	TERN_PLUGIN_DIR,
	TERN_PLUGIN_ID,
	type ListedPlugin,
	type PluginFiles,
} from "../fork-features/tern-plugin-install.ts";

function listedPlugin(files: PluginFiles, overrides: Partial<ListedPlugin> = {}): ListedPlugin {
	return { id: TERN_PLUGIN_ID, version: files.version, css: files.css, status: "ready", ...overrides };
}

function makeTern(t: TestContext, loaded: readonly ListedPlugin[] = [], failure: "none" | "list" | "first-link" = "none") {
	const dir = mkdtempSync(join("/tmp", "tern-plugin-install-"));
	t.after(() => { rmSync(dir, { recursive: true, force: true }); });
	const logPath = join(dir, "argv.log");
	const listPath = join(dir, "plugins.json");
	const firstLinkPath = join(dir, "first-link-refused");
	const emptyPath = join(dir, "empty-bin");
	mkdirSync(emptyPath);
	writeFileSync(logPath, "");
	writeFileSync(listPath, JSON.stringify({ plugins: loaded }));
	const executable = join(dir, "tern");
	writeFileSync(executable, `#!/bin/sh
first=1
for arg in "$@"; do
  if [ "$first" = 0 ]; then printf '\\t' >> "$TERN_TEST_LOG"; fi
  printf '%s' "$arg" >> "$TERN_TEST_LOG"
  first=0
done
printf '\\n' >> "$TERN_TEST_LOG"
case "$1:$2" in
  plugin:list)
    if [ "$TERN_TEST_FAILURE" = list ]; then
      printf 'list unavailable\\n' >&2
      exit 1
    fi
    /bin/cat "$TERN_TEST_LIST"
    ;;
  plugin:link)
    if [ "$TERN_TEST_FAILURE" = first-link ] && [ ! -f "$TERN_TEST_FIRST_LINK" ]; then
      : > "$TERN_TEST_FIRST_LINK"
      printf 'already installed\\n' >&2
      exit 1
    fi
    printf '{"ok":true}\\n'
    ;;
  plugin:remove)
    printf '{"ok":true}\\n'
    ;;
  *)
    printf 'unexpected fake tern command\\n' >&2
    exit 64
    ;;
esac
`);
	chmodSync(executable, 0o755);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		// No ambient executable is needed: the script uses shell builtins and /bin/cat.
		PATH: dir,
		TERN_PANE_SOCKET: "/x",
		TERN_PANE: "1",
		TERN_TEST_LOG: logPath,
		TERN_TEST_LIST: listPath,
		TERN_TEST_FIRST_LINK: firstLinkPath,
		TERN_TEST_FAILURE: failure,
	};
	return {
		env,
		emptyPath,
		get calls(): string[][] {
			return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "").map((line) => line.split("\t"));
		},
	};
}

describe("Tern pane detection", () => {
	it("accepts a nonempty socket and all-digit pane ids, including zero and leading zeros", () => {
		for (const pane of ["0", "1", "007", "123456789"]) {
			assert.equal(inTernPane({ TERN_PANE_SOCKET: "/x", TERN_PANE: pane }), true);
		}
		assert.equal(inTernPane({ TERN_PANE_SOCKET: " /x ", TERN_PANE: " 12 " }), true);
	});

	it("rejects missing or empty socket and pane values", () => {
		for (const env of [
			{}, { TERN_PANE: "1" }, { TERN_PANE_SOCKET: "/x" },
			{ TERN_PANE_SOCKET: "", TERN_PANE: "1" },
			{ TERN_PANE_SOCKET: "  ", TERN_PANE: "1" },
			{ TERN_PANE_SOCKET: "/x", TERN_PANE: "" },
			{ TERN_PANE_SOCKET: "/x", TERN_PANE: "  " },
		]) {
			assert.equal(inTernPane(env), false);
		}
	});

	it("rejects signed, fractional, whitespace-separated, and nonnumeric pane ids", () => {
		for (const pane of ["-1", "+1", "1.5", "1 2", "1e2", "pane-1"]) {
			assert.equal(inTernPane({ TERN_PANE_SOCKET: "/x", TERN_PANE: pane }), false);
		}
	});
});

describe("Tern plugin file and CLI parsers", () => {
	it("reads the quoted version from a multiline plugin manifest", () => {
		assert.equal(parsePluginVersion('schema = 1\nid = "plugin"\nversion = "test-version"\n'), "test-version");
		assert.equal(parsePluginVersion('  version  =  "release candidate"  \n'), "release candidate");
	});

	it("throws when a plugin manifest has no quoted version assignment", () => {
		for (const toml of ["", 'name = "plugin"', "version = 7", "version = 'test-version'"]) {
			assert.throws(() => parsePluginVersion(toml), /plugin\.toml has no version/);
		}
	});

	it("parses loaded plugin fields from the plugins array", () => {
		const plugin = listedPlugin({ version: "test-version", css: ".terminal {}" });
		assert.deepEqual(parsePluginList(JSON.stringify({ plugins: [plugin] })), [plugin]);
		assert.deepEqual(parsePluginList('{"plugins":[]}'), []);
	});

	it("throws for malformed JSON and roots without a plugins array", () => {
		assert.throws(() => parsePluginList("not JSON"), SyntaxError);
		for (const value of [null, 7, "plugins", [], {}, { plugins: null }, { plugins: {} }, { plugins: "[]" }]) {
			assert.throws(() => parsePluginList(JSON.stringify(value)), /no plugins array/);
		}
	});

	it("drops entries without a string id and defaults nonstring optional fields to empty strings", () => {
		assert.deepEqual(parsePluginList(JSON.stringify({ plugins: [
			null, 7, "plugin", {}, { id: 42 }, { id: "" },
			{ id: TERN_PLUGIN_ID, version: 7, css: false, status: null },
			{ id: "another-plugin" },
		] })), [
			{ id: TERN_PLUGIN_ID, version: "", css: "", status: "" },
			{ id: "another-plugin", version: "", css: "", status: "" },
		]);
	});

	it("reads the actual package manifest version and exact plugin stylesheet", () => {
		const files = readPluginFiles();
		const manifest = readFileSync(join(TERN_PLUGIN_DIR, "plugin.toml"), "utf8");
		assert.equal(manifest.split("\n").find((line) => line.startsWith("version = ")), `version = "${files.version}"`);
		assert.equal(files.css, readFileSync(join(TERN_PLUGIN_DIR, "terminals.css"), "utf8"));
		assert.ok(files.version.length > 0 && files.css.length > 0);
	});
});

describe("Tern plugin action planning", () => {
	const files: PluginFiles = { version: "package-version", css: ".terminal {}" };

	it("links when the package plugin is missing, even if other plugins are installed", () => {
		assert.deepEqual(planPluginAction([], files), { kind: "link" });
		assert.deepEqual(planPluginAction([listedPlugin(files, { id: "another-plugin" })], files), { kind: "link" });
	});

	it("keeps a ready plugin current only when its version and CSS both match", () => {
		assert.deepEqual(planPluginAction([listedPlugin(files)], files), { kind: "current" });
	});

	it("relinks a different version, different CSS, or non-ready status and reports the loaded version", () => {
		for (const plugin of [
			listedPlugin(files, { version: "old-version" }),
			listedPlugin(files, { css: ".old-terminal {}" }),
			listedPlugin(files, { status: "error" }),
		]) {
			assert.deepEqual(planPluginAction([plugin], files), { kind: "relink", loaded: plugin.version });
		}
	});

	it("reports an unknown loaded version when a stale plugin lacks one", () => {
		assert.deepEqual(planPluginAction([listedPlugin(files, { version: "" })], files), { kind: "relink", loaded: "unknown" });
	});
});

describe("Tern plugin installation through the CLI", () => {
	it("does nothing outside a Tern pane and never launches the executable", async (t) => {
		const h = makeTern(t);
		assert.deepEqual(await ensureTernPlugin({ ...h.env, TERN_PANE: "" }, readPluginFiles()), { kind: "not-tern" });
		assert.deepEqual(h.calls, []);
	});

	it("fails when no tern executable is on the supplied PATH", async (t) => {
		const h = makeTern(t);
		assert.deepEqual(await ensureTernPlugin({ ...h.env, PATH: h.emptyPath }, readPluginFiles()), {
			kind: "failed", reason: "the `tern` command is not on PATH",
		});
		assert.deepEqual(h.calls, []);
	});

	it("only lists a current ready plugin with matching package version and CSS", async (t) => {
		const files = readPluginFiles();
		const h = makeTern(t, [listedPlugin(files)]);
		assert.deepEqual(await ensureTernPlugin(h.env, files), { kind: "current" });
		assert.deepEqual(h.calls, [["plugin", "list", "--json"]]);
	});

	it("lists then links the real package directory when the plugin is missing", async (t) => {
		const files = readPluginFiles();
		const h = makeTern(t);
		assert.deepEqual(await ensureTernPlugin(h.env, files), { kind: "linked", version: files.version, replaced: undefined });
		assert.deepEqual(h.calls, [["plugin", "list", "--json"], ["plugin", "link", TERN_PLUGIN_DIR, "--json"]]);
	});

	for (const stale of ["version", "css", "status"] as const) {
		it(`relinks a stale ${stale} through the CLI and reports the replaced version`, async (t) => {
			const files = readPluginFiles();
			const plugin = listedPlugin(files, stale === "version" ? { version: "old-version" }
				: stale === "css" ? { css: `${files.css}\n/* stale */` } : { status: "error" });
			const h = makeTern(t, [plugin]);
			assert.deepEqual(await ensureTernPlugin(h.env, files), { kind: "linked", version: files.version, replaced: plugin.version });
			assert.deepEqual(h.calls, [["plugin", "list", "--json"], ["plugin", "link", TERN_PLUGIN_DIR, "--json"]]);
		});
	}

	it("removes an installed stale plugin and retries link only after the first link refuses", async (t) => {
		const files = readPluginFiles();
		const h = makeTern(t, [listedPlugin(files, { version: "old-version" })], "first-link");
		assert.deepEqual(await ensureTernPlugin(h.env, files), { kind: "linked", version: files.version, replaced: "old-version" });
		assert.deepEqual(h.calls, [
			["plugin", "list", "--json"],
			["plugin", "link", TERN_PLUGIN_DIR, "--json"],
			["plugin", "remove", TERN_PLUGIN_ID, "--json"],
			["plugin", "link", TERN_PLUGIN_DIR, "--json"],
		]);
	});

	it("reports the controlled list failure and does not attempt link or removal", async (t) => {
		const h = makeTern(t, [], "list");
		assert.deepEqual(await ensureTernPlugin(h.env, readPluginFiles()), { kind: "failed", reason: "tern plugin list: list unavailable" });
		assert.deepEqual(h.calls, [["plugin", "list", "--json"]]);
	});
});

describe("Tern plugin installation notices", () => {
	it("has no notice outside Tern or when the plugin is already current", () => {
		assert.equal(outcomeNotice({ kind: "not-tern" }), undefined);
		assert.equal(outcomeNotice({ kind: "current" }), undefined);
	});

	it("reports installs and replaced versions at info level", () => {
		assert.deepEqual(outcomeNotice({ kind: "linked", version: "new-version", replaced: undefined }), {
			level: "info", text: "unified-exec: installed its Tern plugin new-version",
		});
		assert.deepEqual(outcomeNotice({ kind: "linked", version: "new-version", replaced: "old-version" }), {
			level: "info", text: "unified-exec: updated its Tern plugin old-version → new-version",
		});
	});

	it("warns with the failure reason and the real manual link command", () => {
		assert.deepEqual(outcomeNotice({ kind: "failed", reason: "list unavailable" }), {
			level: "warning",
			text: `unified-exec: could not install its Tern plugin (list unavailable); run \`tern plugin link ${TERN_PLUGIN_DIR}\``,
		});
	});
});
