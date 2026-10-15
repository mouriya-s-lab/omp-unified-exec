import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../src/index.ts";

// This minimal fake API has no codemode surfaces; codemode-render tests cover them.
process.env.PI_UNIFIED_EXEC_COMPACT_CODEMODE = "0";

test("session_start never rewrites the active tool set", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
	// Static event-name keys, one entry each: a Record fits; a Map would be for
	// dynamic keys or insertion-order iteration.
	const registered: Record<string, Handler[]> = {};
	// Pi keeps every handler an extension registers for an event.
	const handlers = { has: (name: string) => name in registered, get: (name: string) => {
		const list = registered[name];
		return list && (async (event: unknown, ctx: ExtensionContext) => { for (const handler of list) await handler(event, ctx); });
	} };
	const lookups: string[] = [];
	let active = ["bash", "read", "exec_command", "write_stdin"];
	activate({
		registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
		on: (name: string, handler: Handler) => { registered[name] = [...(registered[name] ?? []), handler]; },
		getFlag: (name: string) => { lookups.push(name); return undefined; },
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI);
	let widgetReads = 0;
	const ctx = { mode: "print", hasUI: false, ui: {
		setStatus: () => {},
		get setWidget() { widgetReads++; return () => {}; },
	} } as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	// The `bash` alias shadows the built-in at registration time, so there is
	// never a second shell tool to drop — and dropping by name here would
	// delete the alias itself, since setActiveTools replaces the whole set.
	assert.equal(lookups.length, 0, "no flag lookups: the keep-builtin-bash choice is gone");
	assert.equal(widgetReads, 0, "no widget work or legacy capability probes with no sessions");
	assert.deepEqual(active, ["bash", "read", "exec_command", "write_stdin"]);
	assert.ok(handlers.has("agent_settled"));
	assert.equal(handlers.has("agent_end"), false);
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("a rejected settled registration fails activation rather than selecting a legacy fallback", () => {
	assert.throws(() => activate({
		registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
		on: (event: string) => { if (event === "agent_settled") throw new Error("registration rejected"); },
	} as unknown as ExtensionAPI), /registration rejected/);
});
