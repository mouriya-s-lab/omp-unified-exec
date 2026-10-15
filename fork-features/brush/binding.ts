/**
 * Host session binding (#27 contract C1; fork-features/README.md,
 * "Embedded brush shell").
 *
 * Each plugin activation serves one omp session. Its first `session_start`
 * looks the session up once in omp's global `AgentRegistry` by
 * `ctx.agent.id` and checks that the registered `AgentSession` is the one
 * whose session manager this context carries. `session_switch` and
 * `session_branch` (omp's `/new`, resume, fork, `/branch`, btw) keep the same
 * `AgentSession` and only re-check that identity: the registry entry may since
 * have been replaced by a same-id helper session.
 *
 * Consumers read only `settings`, `skills`, `asyncJobManager` and `agentId`.
 * This is omp's internal session object, not public extension API.
 */
import type { HostSettings, OmpHost } from "./omp-host.ts";

/** The bound `AgentSession`, as far as consumers may read it. */
export interface BoundSession {
	readonly settings: HostSettings;
	readonly skills: unknown;
	readonly asyncJobManager: unknown;
	/** The host owns this identity and may replace exposed values during a session. */
	readonly sessionManager: unknown;
}

export type UnboundReason = "no-registry-entry" | "identity-mismatch";

export type HostBinding =
	| {
			readonly kind: "bound";
			readonly session: BoundSession;
			readonly agentId: string;
	  }
	| { readonly kind: "unbound"; readonly reason: UnboundReason };

/** Before the first `session_start`: no session has been looked up yet. */
export type HostBindingState = { readonly kind: "pending" } | HostBinding;

/** The fields of an omp event context the binding reads. */
export interface BindingContext {
	readonly agentId: string | undefined;
	readonly sessionManager: unknown;
}

/** `ctx.agent.id` and `ctx.sessionManager` of an omp extension context. */
export function bindingContext(ctx: unknown): BindingContext {
	const agent = typeof ctx === "object" && ctx !== null && "agent" in ctx ? ctx.agent : undefined;
	const id = typeof agent === "object" && agent !== null && "id" in agent ? agent.id : undefined;
	const sessionManager = typeof ctx === "object" && ctx !== null && "sessionManager" in ctx ? ctx.sessionManager : undefined;
	return { agentId: typeof id === "string" ? id : undefined, sessionManager };
}

function parseSession(session: unknown): BoundSession | undefined {
	if (typeof session !== "object" || session === null) return undefined;
	if (!("settings" in session) || typeof session.settings !== "object" || session.settings === null) return undefined;
	// Keep the actual AgentSession, not a record of its current property values:
	// settings, skills and the job manager remain owned and maintained by the host.
	return session as BoundSession;
}

/** The first `session_start` of an activation: one registry lookup. */
export function bindSession(host: OmpHost, ctx: BindingContext): HostBinding {
	const registered = ctx.agentId === undefined ? undefined : host.registeredSession(ctx.agentId);
	const session = registered === undefined ? undefined : parseSession(registered.session);
	if (ctx.agentId === undefined || session === undefined) return { kind: "unbound", reason: "no-registry-entry" };
	if (session.sessionManager !== ctx.sessionManager) return { kind: "unbound", reason: "identity-mismatch" };
	return { kind: "bound", session, agentId: ctx.agentId };
}

/** `session_switch` / `session_branch`: re-check identity without a lookup. */
export function recheckBinding(binding: HostBindingState, ctx: BindingContext): HostBindingState {
	switch (binding.kind) {
		case "pending":
		case "unbound":
			return binding;
		case "bound":
			return binding.session.sessionManager === ctx.sessionManager ? binding : { kind: "unbound", reason: "identity-mismatch" };
	}
}
