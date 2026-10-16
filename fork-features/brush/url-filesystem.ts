/** Per-execution host URL capabilities (#27 C10). No ToolSession is manufactured. */
import { approveCommand } from "./approval.ts";
import type { NativeFilesystem } from "./native.ts";
import type { HostSettings } from "./omp-host.ts";
import type { EngineSelection } from "./runtime.ts";
import type { ExecPlan } from "./plan.ts";

/** Host-owned collections whose domain objects remain opaque to this adapter. */
export interface HostSkills extends ReadonlyArray<unknown> {}
export interface HostBranch extends ReadonlyArray<unknown> {}
export interface HostLocalOptions {
	readonly getArtifactsDir?: () => string | null;
	readonly getSessionId?: () => string | null;
}
export interface HostUrlContext {
	readonly cwd: string;
	readonly settings: HostSettings;
	readonly skills: HostSkills;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly getSessionBranch: () => HostBranch;
	readonly localProtocolOptions: HostLocalOptions;
	readonly experimentalContextManagement: boolean;
	readonly signal: AbortSignal | undefined;
}
export type HostApprovalTier = "read" | "write" | "exec";
export interface HostUrlStat {
	readonly type: "directory" | "file" | "other";
	readonly size: number;
	readonly mtimeMs: number;
}
export interface HostUrlFilesystem {
	stat(path: string): Promise<HostUrlStat>;
	nativeFilesystem(): NativeFilesystem;
}

function property(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null && name in value ? Reflect.get(value, name) : undefined;
}
function requiredFunction(value: unknown, name: string): (...args: unknown[]) => unknown {
	const fn = property(value, name);
	if (typeof fn !== "function") throw new Error(`omp-unified-exec: URL context lacks ${name}()`);
	return fn as (...args: unknown[]) => unknown;
}
function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || typeof value === "string") return value;
	throw new Error(`omp-unified-exec: URL context ${name} is not a string`);
}

/** Capture caller fields once; retain the real manager receiver for live branch reads. */
export function filesystemFactory(
	variant: Extract<EngineSelection, { readonly kind: "brush" }>,
	caller: unknown,
	rawCommand: string,
): (signal: AbortSignal | undefined) => HostUrlFilesystem {
	const { services } = variant.engine;
	const { session } = variant.binding;
	const cwd = property(caller, "cwd");
	if (typeof cwd !== "string") throw new Error("omp-unified-exec: URL context lacks cwd");
	const manager = property(caller, "sessionManager");
	const getFile = requiredFunction(manager, "getSessionFile");
	const getId = requiredFunction(manager, "getSessionId");
	const getBranch = requiredFunction(manager, "getBranch");
	const sessionId = getId.call(manager);
	if (typeof sessionId !== "string") throw new Error("omp-unified-exec: URL context lacks a session id");
	const options = property(caller, "localProtocolOptions");
	if (typeof options !== "object" || options === null) throw new Error("omp-unified-exec: URL context lacks localProtocolOptions");
	for (const key of ["getArtifactsDir", "getSessionId"]) {
		const getter = property(options, key);
		if (getter !== undefined && typeof getter !== "function") throw new Error(`omp-unified-exec: invalid localProtocolOptions.${key}`);
	}
	const skills = session.skills;
	if (!Array.isArray(skills)) throw new Error("omp-unified-exec: bound session lacks skills");
	const settings = session.settings;
	const approval = approveCommand(rawCommand, services.approvalRules(settings),
		services.allowCompoundCommands(settings) ? services.shellConfig(settings).shell : undefined, services.approval);
	const tier = typeof approval === "string" ? approval : approval.tier;
	const base = {
		cwd, settings, skills: skills as HostSkills,
		sessionFile: optionalString(getFile.call(manager), "sessionFile"), sessionId,
		getSessionBranch: (): HostBranch => {
			const branch = getBranch.call(manager);
			if (!Array.isArray(branch)) throw new Error("omp-unified-exec: session manager returned no branch");
			return branch as HostBranch;
		},
		localProtocolOptions: options as HostLocalOptions,
		experimentalContextManagement: services.experimentalContextManagement(settings),
	};
	// Deliberately omit session, rules and agentRegistry: they require a real ToolSession.
	return (signal) => services.createUrlFilesystem({ ...base, signal }, tier);
}

/** C4 URL stage, after host cache invalidation and before backend/id allocation. */
export async function resolveUrlCwd(plan: ExecPlan, signal: AbortSignal | undefined): Promise<ExecPlan> {
	const variant = plan.variant;
	if (variant.host === "pi" || !variant.engine.services.paths.canHandleInternalUrl(plan.cwd)) return plan;
	const services = variant.engine.services;
	const cwd = services.normalizeInternalUrl(plan.cwd);
	if (variant.kind !== "brush") {
		throw new Error(`url_cwd_requires_brush: Working directory ${cwd} exists only in the embedded shell; external processes need a host directory.`);
	}
	let info: HostUrlStat;
	try {
		info = await variant.filesystem(signal).stat(cwd);
	} catch (error) {
		if (services.isUrlFsMissing(error)) throw new Error(`Working directory does not exist: ${cwd}`);
		throw new Error(`Working directory ${cwd} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (info.type !== "directory") throw new Error(`Working directory is not a directory: ${cwd}`);
	return { ...plan, cwd };
}

/** Parse the host controller once without copying its native RPC protocol. */
export function parseHostUrlFilesystem(value: unknown): HostUrlFilesystem {
	const stat = requiredFunction(value, "stat");
	const shellFilesystem = requiredFunction(value, "shellFilesystem");
	return {
		stat: async (path) => {
			const result: unknown = await stat.call(value, path);
			const type = property(result, "type");
			const size = property(result, "size");
			const mtimeMs = property(result, "mtimeMs");
			if ((type !== "directory" && type !== "file" && type !== "other") ||
				typeof size !== "number" || typeof mtimeMs !== "number") {
				throw new Error("omp-unified-exec: URL filesystem returned invalid stat metadata");
			}
			return { type, size, mtimeMs };
		},
		nativeFilesystem: () => {
			const bridge: unknown = shellFilesystem.call(value);
			if (typeof property(bridge, "handler") !== "function" || property(bridge, "nativeLocalPaths") !== true) {
				throw new Error("omp-unified-exec: URL filesystem returned an invalid native bridge");
			}
			// The host owns every request, response and callback receiver.
			return bridge as NativeFilesystem;
		},
	};
}
