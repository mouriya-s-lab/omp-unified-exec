/** C5 deadline policy. Notice text is copied from can1357/oh-my-pi@c2cb79e
 * packages/coding-agent/src/tools/bash.ts:formatTimeoutClampNotice.
 * The host owns timeout defaults and clamping; process defaults deliberately remain unlimited.
 */
import type { HostSettings, OmpHost } from "./omp-host.ts";

export type CommandDeadline =
	| { readonly kind: "unlimited" }
	| { readonly kind: "deadline"; readonly seconds: number; readonly milliseconds: number; readonly notice: string | undefined };

export function commandDeadline(
	services: OmpHost, settings: HostSettings, brush: boolean, requested: number | undefined,
): CommandDeadline {
	if (requested === 0 || (requested === undefined && !brush)) return { kind: "unlimited" };
	const limits = services.bashTimeoutLimits;
	const raw = requested ?? limits.default;
	const max = services.maxTimeout(settings);
	const seconds = services.clampBashTimeout(raw, max);
	let notice: string | undefined;
	if (raw !== seconds) {
		const cappedByGlobal = max > 0 && seconds === max && max < limits.max;
		const limit = cappedByGlobal ? `global tools.maxTimeout ceiling ${max}s` : `allowed range ${limits.min}-${limits.max}s`;
		notice = `Timeout clamped to ${seconds}s (requested ${raw}s; ${limit}).`;
	}
	return { kind: "deadline", seconds, milliseconds: seconds * 1000, notice };
}
