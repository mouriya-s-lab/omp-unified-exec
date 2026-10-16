/**
 * Session-local exec metadata (C8). Adapted from can1357/oh-my-pi@
 * c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * packages/coding-agent/src/prompts/tools/bash.md and tools/bash.ts:596-627.
 * Keep only conditions actually rendered by that template; exec_command has
 * workdir/tty, not bash's cwd/pty/service parameters.
 */
export type ExecMetadata =
	| { readonly kind: "unbound" }
	| {
		readonly kind: "bound";
		readonly asyncEnabled: boolean;
		readonly autoBackgroundEnabled: boolean;
		readonly autoBackgroundSeconds: number;
		readonly defaultTimeoutSeconds: number;
		readonly hasEval: boolean;
	};

const BASE_DESCRIPTION = [
	"Run a shell command; dependencies use &&. Use workdir instead of changing directories.",
	"On omp, omit shell with tty:false for the embedded Brush shell. Git Guard, internal URI paths and output minimization are Brush-only. A nonempty shell selects a real pipe process; tty:true selects a real PTY.",
	"Use tty:true for interactive programs (REPLs, ssh, sudo, password prompts). For long-lived noninteractive Brush commands and watchers, use timeout:0. Real processes have no default execution deadline; explicit timeout applies to every backend.",
	"Returning or cancelling an attachment does not kill its execution. Drive returned session_id values with write_stdin; tty output is rendered terminal state, not raw escape sequences.",
	"Brush results are bounded head/tail text with decoded terminal images. When available, artifact:// stores the complete native text before minimization; inline-only results explicitly say complete output was not saved. Real processes keep their existing log_path recovery.",
	"HostJob completions arrive automatically; do not poll them. on_exit:wake is only for Coordinator delivery and only when the human explicitly wants auto-resume; HostJob rejects wake. kill_session terminates the execution.",
].join("\n");

/** Deterministic projection of the bound session's current settings and active-tool set. */
export function execDescription(metadata: ExecMetadata): string {
	if (metadata.kind === "unbound") return BASE_DESCRIPTION;
	const lines = [BASE_DESCRIPTION,
		metadata.hasEval
			? "Scripts/heredocs/`$(…)`/complex pipelines → `eval`."
			: "Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.",
		`Brush's default execution deadline is ${metadata.defaultTimeoutSeconds}s, capped by tools.maxTimeout; timeout:0 disables it. Attachment waits are separate from execution deadlines.`,
	];
	if (metadata.asyncEnabled) {
		lines.push(`async:true immediately starts a finite Brush HostJob and retains its deadline (default ${metadata.defaultTimeoutSeconds}s); it requires an available host job slot. timeout:0 is for watchers and long jobs.`);
	}
	if (metadata.autoBackgroundEnabled) {
		lines.push(`Brush HostJobs still running after ${metadata.autoBackgroundSeconds}s (or 1s before timeout, if sooner) move to background and keep running to their deadline. The result arrives automatically as a follow-up. NEVER poll HostJobs. Without a host job slot, omitted yield_time_ms waits until completion or deadline instead.`);
	} else {
		lines.push("Automatic backgrounding is disabled. Omitted Brush yield_time_ms waits until completion or deadline; async:true still backgrounds immediately when enabled.");
	}
	lines.push("An explicit yield_time_ms uses the attachment-window bounds. Real processes default to a 10s attachment. A yielded Coordinator session can be polled with write_stdin; an empty poll's cancellation keeps the session alive and does not consume its pending output.");
	return lines.join("\n");
}
