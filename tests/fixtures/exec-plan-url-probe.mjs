// Opt-in compiled-omp qualification for #30's URL cwd boundary.
// No model request, mock router, or backend execution is involved.
import assert from "node:assert/strict";
import { bindSession, bindingContext } from "../../fork-features/brush/binding.ts";
import { loadNativeShell } from "../../fork-features/brush/native.ts";
import { loadOmpHost } from "../../fork-features/brush/omp-host.ts";
import { createExecPlan } from "../../fork-features/brush/plan.ts";

export default function execPlanUrlProbe(pi) {
	let entered = false;
	pi.on("session_start", async (_event, ctx) => {
		if (entered) return;
		entered = true;
		const services = await loadOmpHost();
		const binding = bindSession(services, bindingContext(ctx));
		assert.equal(binding.kind, "bound");
		assert.equal(services.paths.canHandleInternalUrl("local://"), true);
		assert.equal(services.paths.canHandleInternalUrl("skill://"), true);
		const engine = {
			kind: "omp", services, binding, native: loadNativeShell(),
			warn: (message) => pi.logger.warn(message), shells: undefined,
		};
		const variant = { kind: "brush", host: "omp", engine, settings: binding.session.settings };
		const plans = [];
		for (const args of [{ cmd: "cd local:// && pwd" }, { cmd: "pwd", workdir: "local://x" }]) {
			const plan = await createExecPlan(args, ctx.cwd, variant);
			plans.push({ rawCommand: plan.rawCommand, command: plan.command, cwd: plan.cwd });
		}
		console.error(`UEXEC_PLAN_URL_RESULTS=${JSON.stringify(plans)}`);
	});
}
