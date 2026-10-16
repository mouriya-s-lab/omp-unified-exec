/**
 * Execution-plan cwd stage (#27 C4, #30).
 * Behavior follows can1357/oh-my-pi@c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * packages/coding-agent/src/tools/bash.ts (leading cd and local cwd checks).
 * The exported host tokenizer/path resolver and shared URL router are imported
 * by the adapter, not copied. URL normalization/stat follows in its own C4 stage.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { processShellPath, selectProcessShell, shellSyntax } from "../../src/shell.ts";
import type { EngineSelection, EngineVariant } from "./runtime.ts";
import { rewriteForShell } from "./worktree.ts";
import { filesystemFactory } from "./url-filesystem.ts";

export interface CwdServices {
	readonly extractLeadingCdTarget: (command: string) => { readonly path: string; readonly rest: string } | null;
	readonly resolveToCwd: (path: string, cwd: string) => string;
	readonly canHandleInternalUrl: (path: string) => boolean;
}

interface CommandPlan {
	readonly rawCommand: string;
	readonly command: string;
	readonly cwd: string;
}

/** Cwd is validated before any process-shell lookup. */
export interface CwdPlan extends CommandPlan {
	readonly variant: EngineSelection;
}

export interface ExecPlan extends CommandPlan {
	readonly variant: EngineVariant;
}

interface CommandInput {
	readonly cmd: string;
	readonly workdir?: string;
}

/** Construct an omp call's plan before allocating a session or starting a backend. */
export async function createExecPlan(
	args: CommandInput,
	sessionCwd: string,
	variant: EngineSelection & { readonly host: "omp" },
): Promise<CwdPlan> {

	const paths = variant.engine.services.paths;
	let command = args.cmd;
	let directory = args.workdir;
	if (!directory) {
		const cd = paths.extractLeadingCdTarget(command);
		if (cd) {
			directory = cd.path;
			command = cd.rest;
		}
	}
	if (directory && paths.canHandleInternalUrl(directory)) {
		return { rawCommand: args.cmd, command, cwd: directory, variant };
	}
	const cwd = directory ? paths.resolveToCwd(directory, sessionCwd) : sessionCwd;
	let info: Stats;
	try {
		info = await stat(cwd);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new Error(`Working directory does not exist: ${cwd}`);
		}
		throw error;
	}
	if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
	return { rawCommand: args.cmd, command, cwd, variant };
}

/** Resolve once after cwd validation; dispatch and rewriting share this selection. */
export function resolveExecutionPlan(plan: CwdPlan, shell: string | undefined, caller?: unknown): ExecPlan {
	const variant = plan.variant;
	if (variant.host === "pi") return { ...plan, variant };
	if (variant.kind === "brush") {
		return { ...plan, variant: { ...variant, filesystem: filesystemFactory(variant, caller, plan.rawCommand) } };
	}
	return { ...plan, variant: { ...variant, shell: selectProcessShell(shell) } };
}

/** The host owns both the recognized syntax and the bound session's clone policy. */
export async function rewriteWorktreePlan(plan: ExecPlan): Promise<ExecPlan> {
	const variant = plan.variant;
	if (variant.host === "pi") return plan;
	const services = variant.engine.services;
	if (!services.worktreeClone(variant.binding.session.settings)) return plan;
	const cli = await services.resolveCliEntryCmd();
	const syntax = variant.kind === "brush" ? "command-c" : shellSyntax(processShellPath(variant.shell));
	return { ...plan, command: rewriteForShell(plan.command, cli, syntax, services) };
}
