# IV-0001 — Long waits, execution deadlines, and completion ownership

**Status:** implemented; macOS compiled-omp runtime qualified, with the host/platform boundaries below.
**Related:** [output lifecycle and rendering](IV-0002-output-lifecycle-and-rendering.md), [workspace doctrine](DC-0001-agentic-workspace.md), [Changelog](../Changelog.md).

## Intent and compatibility boundary

An attachment wait is not a command deadline. Returning from or cancelling a tool call does not, by itself, terminate its execution. A completed execution has exactly one completion owner: the plugin's `CompletionCoordinator` or omp's bound `AsyncJobManager`.

Pi retains its process backends, parameter surface, default waits, and wake policy. On omp, explicit `shell` selects a real pipe process, `tty: true` selects a real PTY process, and omitted `shell` with `tty: false` selects Brush. Brush has no terminal HUD; that HUD remains tty-only.

On omp, `exec_command` and `write_stdin` declare the public `loadMode: "essential"` extension field. These tools replace essential bash and must remain directly callable: an outer `write xd://…` transport owns a different cancellation lifecycle and can discard an inner background-start result on Esc. Pi definitions do not receive this field.

The omp-specific contracts are defined by [the deadline and HostJob issue](https://github.com/oh-my-omp/omp-unified-exec/issues/34), consuming the binding and execution contracts of [the umbrella](https://github.com/oh-my-omp/omp-unified-exec/issues/27). Implementation differences from built-in bash are recorded in [the fork customization table](../fork-features/README.md).

## Attachment waits

### Starting an execution

| Execution and completion owner | Omitted `yield_time_ms` | Explicit `yield_time_ms` |
|---|---|---|
| Pi process; omp PipeProcess/PtyProcess | 10 seconds | Clamp to 250–30000 ms |
| omp Brush, Coordinator | Wait until completion or execution deadline | Clamp to 250–30000 ms |
| omp Brush, HostJob, auto-background enabled | Bound session's `bash.autoBackground.thresholdMs`, capped at execution deadline minus one second | Clamp to 250–30000 ms |
| omp Brush, HostJob, auto-background disabled | Wait until completion or execution deadline | Clamp to 250–30000 ms |

An auto-background wait budget of zero backgrounds immediately. `async: true` also backgrounds immediately. An omitted Brush attachment wait is not limited by the process backends' 10-second default or 30-second ceiling. With `timeout: 0`, waiting until completion has no timer or artificial upper bound.

HostJob foreground completion means that the actual host job's `run` has settled, including final formatting and progress publication. Native shell exit alone is not that completion anchor.

### Following an existing session

An empty `write_stdin` poll has a five-second minimum/default and no built-in maximum. An explicit `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` caps relative empty polls; invalid configuration fails the call. Durations must be finite, non-negative, and within JavaScript's safe millisecond range.

`yield_until` is a strict RFC 3339 UTC deadline for an empty poll only. It is mutually exclusive with relative `yield_time_ms` and nonempty input. There is no default horizon. The monotonic wait engine chunks timers at `2^31-1` ms to avoid overflow. Agents use absolute waits only when the human explicitly asks for a long attached wait or UTC deadline.

Empty waits retain output in the session while waiting. Cancelling a live empty poll returns without draining its buffered output or terminating the execution. Streaming updates are output-driven and rate-limited, not periodic keepalive messages.

### Input cancellation

A Brush stdin write waits until its actual pipe accepts the bytes. During preparation, it waits for that execution's stdin without keeping an unbounded input queue. Cancelling a writer cancels only that write or readiness wait; the execution and stdin remain available. An incomplete write may already have delivered a prefix. Cancellation neither rolls that prefix back nor leaves a detached remainder queued for later delivery.

A write after execution has ended reports `session_not_running` and its exit status. A HostJob write also performs terminal observation before removing the index. Another call by the removed id reports `unknown session_id`; it cannot reach a different execution.

## Execution deadlines on omp

`timeout` is measured in seconds and belongs to the execution/session, not to the initiating attachment. Returning a session id does not cancel the deadline.

- Brush resolves an omitted timeout from the host's `TOOL_TIMEOUTS.bash.default` (300 seconds), including the bound `tools.maxTimeout` ceiling.
- PipeProcess and PtyProcess have no default deadline. This intentionally preserves long-lived real-process sessions rather than applying built-in bash's default to every backend.
- Explicit positive values use the shared host `clampTimeout`: the per-tool range is 1–3600 seconds and a positive `tools.maxTimeout` caps the resolved value.
- `timeout: 0` disables the deadline, including the global cap.
- A changed value includes the built-in `formatTimeoutClampNotice` wording. The plugin copies only that unexported notice formatter and imports the host's timeout configuration/clamp helper.

Brush passes the deadline to its native shell. If native execution still has not returned five seconds after that deadline, its backstop aborts the backend and reports that output may be incomplete. A timeout is a normal terminal outcome classified as an error; it is not cancellation through the termination primitive.

A real process owns its deadline timer. Expiry marks the session timed out, requests SIGTERM for its owned process group, and requests SIGKILL after two seconds if the group is still addressable and the session remains open. It does not call the plugin's kill route, suppress a wake, or remove the session. Subsequent observation returns the actual exit with `timedOut: true` and the timeout message.

Deadline signaling is separate from existing explicit-kill behavior. On POSIX it addresses only the negative process-group id, without falling back to a possibly recycled leader PID. ESRCH stops escalation. Signal failures remain visible rather than throwing from the timer or pretending the command exited. The deadline cannot reach a process that has moved to a different group.

On Windows, the existing tree-kill path is used only while the root has not exited. Once the root is gone, the current backend has no reusable-safe Job Object handle; it reports that safe tree signaling is unavailable and retains the live session instead of invoking `taskkill` on an old PID. Windows dead-root/held-ConPTY termination is therefore a known capability limit, not a verified guarantee. A backend's confirmed terminal/stream close ends the process session and its timer; this timer does not take ownership of background descendants after that anchor.

## Completion ownership and host admission

The C1 binding supplies the actual session, settings, job manager, and owner agent id. No singleton or cwd-based reconstruction selects these values.

A Brush execution registers a `bash` HostJob when its bound manager is available and has capacity. The manager owns its job row, status, foreground visibility, consumption, retention, and follow-up delivery. The plugin's numeric session id is only an index to the execution. PipeProcess and PtyProcess always use Coordinator delivery. A Brush execution with no available host slot also uses Coordinator delivery.

`async` is an omp-only parameter and appears only when the bound `async.enabled` setting is true. Direct calls enforce this order: disabled setting first, non-Brush variant second, then missing/full manager. Explicit async never falls back to Coordinator and never starts an execution after admission fails. Ordinary Brush calls may fall back on the host's capacity error; other manager failures are not silently swallowed.

Host registration precedes preparation. The host callback captures its actual run context and returns a single result relay; after `register` returns, the caller obtains the actual row promise, constructs and indexes the session, links cancellation, and begins preparation in the same synchronous stack. Every setup failure settles that relay. The host run never waits for its own manager promise.

Preparation and native execution share one execution-owned abort controller. Cancelling preparation settles without leasing a shell, and a late preflight completion cannot start native work. A preparing writer waits for the same execution to become ready. The eventual shell lease is persistent only when async was not requested and either auto-background is disabled or delivery belongs to Coordinator. Busy/quarantined keys use a one-shot shell. Managed automatic/explicit background work otherwise uses a one-shot shell.

## HostJob foreground and terminal observation

A HostJob begins hidden as a foreground job. If it completes during the attachment, the caller releases foreground ownership and returns its one memoized final result. If the wait expires or the caller is cancelled, the caller promotes it with `backgroundJob()` and returns the job id and numeric session id without terminating native execution. This Esc behavior deliberately differs from built-in bash, which cancels the job.

The run reports serial, bounded output-tail progress through the host manager and the originating tool's live update callback. Background card frames carry the real host job id. Final reporting uses the one final result, independently of the polling cursor; nonzero exit and timeout fail the host job rather than delivering a success-shaped completion. Output/artifact construction is described in [IV-0002](IV-0002-output-lifecycle-and-rendering.md).

The host's actual row promise settles after native completion, output closure, final formatting, and final progress publication. Terminal observers then decide synchronously:

| Observation | Authority and response |
|---|---|
| Terminated | The execution was terminated or the host job signal was aborted. Return newly observed tail with the termination error; do not consume or construct a deliverable final result. |
| Already delivered | The manager no longer has the row or says its result was consumed. Return status, exit information, and any archive reference without replaying output. |
| Available | The row exists and is unconsumed. Consume it through `consumeJobResults`, then return only output after the observation cursor plus terminal classification and archive reference. |

Every terminal observation removes the session index. With no observer, the host delivers the complete final result once; polling does not truncate that body. There is no plugin-side delivered flag or second wake for a HostJob.

`list_sessions` reports terminal HostJobs with `delivery: pending | delivered | terminated`. Pending entries remain available for later polling; delivered and terminated entries are removed after reporting. LRU removal of a settled HostJob removes only its index; the host still owns its result. Cancellation removes an unobserved index when the host run settles; an attached observer already holding the session can still return the termination outcome.

## Termination and session boundaries

HostJob termination first calls `manager.cancel(jobId)`, then reaches the execution's one idempotent termination primitive. The host cancellation signal reaches that same primitive. This covers `kill_session`, `/unified-exec-sessions`, host `proc://<id>/kill`, live LRU eviction, cancellation boundaries, and shutdown. Cancelled jobs do not send final follow-ups. A deadline is not this cancellation path and remains eligible for normal failed-result delivery.

Brush termination carries an explicit call-local intent. Hidden slash/HUD controls do not drain the output cursor or consume HostJob results, including an already-settled race. The model-visible `kill_session` tool is a terminal observation and returns newly observed tail; cancellation still never consumes the host's final result. Concurrent visible observers share one cursor without replay. Both delivery variants preserve that distinction, while real-process termination keeps its existing behavior.

Stopping an already-settled HostJob observes its terminal state instead of replaying the body or claiming it was killed. `on_exit: "wake"` is rejected for HostJob delivery, both at command start and through `set_on_exit`; `"none"` is a no-op for host delivery.

Boundary handling follows actual host events and session files, not cwd or guessed command text:

| Event | Brush execution | Coordinator wakes | Real processes |
|---|---|---|---|
| `session_switch`, reason `new` | Terminate and remove | Reset | Continue |
| Any emitted `session_branch` | Terminate and remove | Reset | Continue |
| `resume` to a different session file | Continue | Reset | Continue |
| `fork` to a different session file | Continue | Preserve | Continue |
| Same-file `resume`/reload | Continue | Preserve | Continue |

Every real boundary also clears HostJob indexes already evicted by the manager. An in-place history action that emits no boundary event is not inferred to be a boundary. Real-process natural exits retain their existing one-final-listing behavior; dropping their wake does not delete their later exit record.

The host may abort an initiating foreground call before it cancels jobs on a cancellation boundary. The call can first return a background-start result; subsequent host cancellation still terminates that execution and prevents delivery. Host `resetSessionContext` can cancel/evict jobs without an extension event; the cancellation signal still terminates execution, and a later observation cleans up an undefined row.

Shutdown cancels owned executions before closing the outer activation. It does not wait for a HostJob promise inside the shutdown hook. Print mode immediately disposes the session after the model's reply, cancelling unfinished HostJobs; use an actual surviving interactive/RPC session when verifying later delivery.

## Coordinator wakes and agent guidance

`on_exit` defaults to `"none"`. Agents request `"wake"` only when the human explicitly wants auto-resume; long-lived servers/watchers do not need it by default. `set_on_exit(...,"none")` disarms without killing. Explicit kill suppresses the Coordinator wake; deadline expiry does not. An already queued follow-up cannot be recalled.

Coordinator terminal observation commits at the host's finalized `tool_execution_end`, not merely when a handler returns. Failed/cancelled delivery leaves an armed wake eligible. Its existing observation leases, eviction tombstones, suppression recheck before dispatch, and `agent_settled` flush remain unchanged. HostJobs do not enter that coordinator.

Pi owns cache warming. This plugin does not override cost policy, extension vetoes, or prompt-cache behavior. Cache lifetime is not a prerequisite or a polling budget.

## Known host boundaries

- The extension execution context does not expose the steering signal. Early backgrounding on a newly queued user message remains [host-gated](https://github.com/oh-my-omp/omp-unified-exec/issues/27#issuecomment-6201336439); no synthetic signal is substituted.
- A preserved Brush job may report an `artifact://<id>` belonging to its old session file after resume/fork. The new session may contain the same number. Built-in bash has this limitation; the plugin does not rewrite those links.
- `resetSessionContext` sends no extension boundary event, so previously armed Coordinator wakes cannot be proactively discarded and may enter the reset context.
- The host's tool-card retention is name-gated. Its `JOB_CARD_TOOLS` contains `task`, `bash` and `eval`, not extension `exec_command`; `event-controller` drops a non-retained tool's pending row when the start call returns. Actual omp 18.11.1 delivered successive `prog2`–`prog10` updates and a completed frame through the extension callback while the ANSI card remained at `prog1`. Manager/proc progress and final delivery work, but retaining the original background card requires a public host retention capability. The plugin neither patches that private allowlist nor creates another HUD. Native Tern retention is source-inferred, not runtime-qualified.
- Windows dead-root tree termination has the safe capability boundary described above. POSIX group-only signaling is not evidence of Windows behavior.

## Implementation and verification

`src/index.ts` owns dispatch, foreground/attached waits, host-job progress/final relay, terminal observations, boundary handling, and tool registration. `fork-features/brush/jobs.ts` adapts the real manager and consumption APIs; `deadline.ts` reads host timeout policy; `execution.ts` owns preparation/native cancellation and shell leases. `src/session.ts` separates native/output completion from host-job settlement and owns process timers. `src/pty.ts` provides deadline-only group requests without changing ordinary kills. `src/completion.ts` remains the Coordinator owner; `src/long-wait.ts` remains the chunked monotonic empty-poll engine.

Canonical verification is `npm test`. Real runtime acceptance additionally exercises the actual registered omp tools, true PTY interaction for Esc/slash controls, actual host async-result transcripts, process-group/PID outcomes, and genuine RPC boundary responses. Typecheck, aggregate test counts, source review, and mock lifecycle tests do not replace those outcomes. Pi's actual-CLI wait fixture and TUI suite remain compatibility checks; unavailable platforms and unreached state preconditions must be stated rather than counted as passes.

Compiled omp 18.11.1 qualification on macOS arm64 exercised actual Esc, slash/proc kills, deadlines, host consumption and RPC session boundaries. The final slash cancellation returned its original waiting call's `formatter-fixed-slash-tail` exactly once, removed the session and native PID, and emitted no async result. Concurrent visible poll/kill returned the fresh marker once in the poll and zero times in the kill. A separately unobserved 400,012-byte giant line retained its terminal marker in the kill result. These are observed cursor/ownership outcomes, not conclusions from source review or aggregate test counts.
