/**
 * Execution-plan cwd stage (#27 C4, #30).
 * Behavior follows can1357/oh-my-pi@c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * packages/coding-agent/src/tools/bash.ts (leading cd and local cwd checks).
 * The exported host tokenizer/path resolver and shared URL router are imported
 * by the adapter, not copied. URL normalization/stat belongs to #33.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { EngineVariant } from "./runtime.ts";

export interface CwdServices {
	readonly extractLeadingCdTarget: (command: string) => { readonly path: string; readonly rest: string } | null;
	readonly resolveToCwd: (path: string, cwd: string) => string;
	readonly canHandleInternalUrl: (path: string) => boolean;
}

export interface ExecPlan {
	readonly rawCommand: string;
	readonly command: string;
	readonly cwd: string;
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
	variant: EngineVariant & { readonly host: "omp" },
): Promise<ExecPlan> {

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
