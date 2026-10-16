# omp-unified-exec

English | [简体中文](README.zh-CN.md)

Long-lived shell sessions for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp), with a tty terminal HUD in Tern. Interactive programs, REPLs, `ssh`,
`sudo` and full-screen programs use real PTY sessions that remain available
between calls. Noninteractive commands default to an embedded Brush shell;
omp can own their background jobs and deliver final output automatically.

This is a fork of [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec),
a Pi port of codex's `unified_exec`. It retains the five tools
(`exec_command`, `write_stdin`, `set_on_exit`, `kill_session`, `list_sessions`).
Pi keeps upstream's process semantics; omp adds Brush execution, host jobs,
deadlines, internal URLs and output artifacts. The differences and upgrade
checks are in [fork-features/README.md](fork-features/README.md).

## Install

```bash
omp install https://github.com/oh-my-omp/omp-unified-exec
```

Remove an existing `pi-unified-exec` first (`omp plugin uninstall
pi-unified-exec`): both register the same tools. The fork publishes nothing to
npm.

omp also installs the bundled Tern plugin as a normal copy when `tern` is on
PATH. Updates use the same command with `--force`:

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

The Tern update finishes before this command succeeds; no separate Tern
command or developer link is needed.

The package still loads on Pi unchanged (Pi's renderers, no HUD). PTY mode uses
Bun's native `Bun.Terminal` under Bun 1.4+ (omp is a compiled Bun executable),
and the optional `@homebridge/node-pty-prebuilt-multiarch` under Node. Without
either, pipe mode (`tty: false`) still works and `tty: true` reports the missing
capability.

## What it does

- **Executions outlive attachments.** A returned `session_id` remains writable
  through `write_stdin`. Cancelling an attachment never kills its execution.
  Brush HostJobs deliver completion automatically; Coordinator sessions use
  polling or an explicitly requested completion wake.
- **PTY output is what a terminal shows.** `tty: true` sessions run through a
  headless terminal emulator, so progress bars, redraws and full-screen
  programs come back as the current screen (plus lines scrolled off since the
  last call and the cursor), not every redraw appended. The emulator answers
  the terminal queries a real terminal would (cursor position, device
  attributes, default colours), so programs that wait for them, or pick a light
  or dark palette from them, behave as in a real terminal.
- **Bounded output with truthful recovery.** Real-process results retain their
  50 KiB / 2000-line terminal-safe tails and complete raw logs. Brush final
  output uses the host's bounded head/tail sink and extracted terminal images.
  Its complete native text is stored in a real session artifact when available;
  inline-only output explicitly says when complete recovery is unavailable.
- **One completion owner.** omp HostJobs deliver through the actual session's
  job manager. Coordinator sessions support opt-in `on_exit: "wake"`;
  `set_on_exit` disarms it without killing.
- **omp-native presentation.** `exec_command`, `write_stdin` and
  `kill_session` render through omp's own bash card (command line, output,
  exit chip, error tone), in the ANSI TUI and in Tern alike.
- **A terminal HUD in Tern.** Watch, scroll back through, type into and kill
  the model's tty sessions without a tool call.

## Tern terminal HUD

When omp renders natively in Tern and a tty session exists:

- **Counter pill.** A terminal icon and the stored tty session count sit on
  their own line just above omp's counter. The row, pill and segment use
  Tern's native HUD styling across Reader, Spine, Console and color themes.
  There is no outer hide button; removing the last tty unmounts the pill.
- **Terminals sheet.** Clicking the pill opens a sheet built like omp's Agents
  sheet: one row per tty session with a status dot, size, PID and running
  time; the selected session's command, state, directory, PID, size, start
  time, linked log path and newest output rows as the preview. ↑/↓ or a click
  picks a session, `x` / Kill ends it the way `kill_session` does, Esc / Close
  leaves.
- **Terminal page.** Enter / Open shows the session as a full-pane page built
  like omp's Console: its retained history and current screen in colour, at
  its own width, following new output and scrollable back. Typed keys go to
  the session (as `write_stdin` writes them, so the model sees their effect);
  Esc / Back returns to the sheet; Kill ends the session.

The HUD reads the sessions in place and keeps no copy of them. It only exists
while omp renders natively, so omp's ANSI TUI gains no row. PTY model output
remains terminal-inert text; Brush image extraction is separate from this HUD.

**The Tern plugin.** An omp extension cannot add to omp's pill line, so the
package ships a CSS-only Tern plugin (`fork-features/tern-plugin/`). It moves
the shared `belowEditor` widget container above omp's pill line and clears
its container spacing, background and shadow so native HUD margins are not
applied twice. Other widgets in that container share this placement and reset;
the plugin does not restyle the pills or omp's editor. It also sets the sheet's
output preview in the monospace face. The awaited omp extension factory
synchronizes this plugin during package-install validation, including
`install --force`, and during ordinary extension loading. It asks Tern for
its plugin directory and catalog; an exact three-file normal copy with the
current ready version and stylesheet is left unchanged. Missing or stale
files are updated with `tern plugin install <bundled-directory> --force`.
Known legacy `.path` registrations are migrated automatically through Tern's
own unlink and copy-install operations; no developer link is created.

The CLI inherits omp's environment, so Tern owns the destination and reload.
With no daemon running, Tern installs the copy for its next start. A missing
`tern` executable does not prevent non-Tern use. If Tern is present but
synchronization fails, package validation or ordinary extension loading
fails with command diagnostics; there is no deferred session-start retry or
success toast. Tern's external update is not rolled back if omp later fails
to save its package configuration. Without the plugin the pill sits below
the composer.

Design, decisions and Tern qualification evidence:
[docs/IV-0002-output-lifecycle-and-rendering.md](docs/IV-0002-output-lifecycle-and-rendering.md).

## Tools

### `exec_command`

On omp, omitted/empty `shell` with `tty: false` selects **Brush**. A nonempty
`shell` selects a real **PipeProcess**; `tty: true` always selects a real
**PtyProcess**. Git Guard, builtins, internal URL paths and native minimization
are Brush-only. Pi keeps its existing real-process selection.

| Param | Type | Default | Notes |
|---|---|---|---|
| `cmd` | string | — | Required shell command; approval evaluates the original request. Execution/results use its effective planned command. |
| `workdir` | string | caller cwd | Relative paths resolve against the calling session. Brush also accepts supported internal URL directories; real processes reject URL workdirs. |
| `shell` | string | omitted | On omp, omission/empty selects Brush unless `tty: true`. Nonempty selects a real process. Real processes default to bash, or PowerShell when Windows bash is unavailable. |
| `tty` | boolean | `false` | Real PTY for interactive programs, REPLs, ssh, sudo and password prompts. Output is rendered terminal state. |
| `cols` | number | `120` | PTY-only width, clamped to [20, 500]; ignored by Brush and pipes. |
| `rows` | number | `30` | PTY-only height, clamped to [5, 300]; ignored by Brush and pipes. |
| `yield_time_ms` | number | backend-dependent | Attachment wait, not a command deadline. Explicit values clamp to [250, 30000]. Real processes default to 10000 ms. Brush HostJobs use the bound auto-background threshold when enabled; otherwise omitted waits last until completion/deadline. Coordinator Brush also waits until completion/deadline. |
| `timeout` | number | Brush: host default; process: unlimited | omp-only deadline in seconds. Brush's host default is 300, capped by `tools.maxTimeout`. Explicit positive values use host 1..3600 bounds and global cap; `0` disables the deadline. Returning a session id does not disarm it. |
| `async` | boolean | `false` | omp-only and present in schema only when `async.enabled` is true. Immediately backgrounds Brush as a HostJob; a missing/full manager rejects without starting. Real-process variants reject async. |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | Coordinator-only opt-in wake at the human's request. HostJob `"wake"` is a typed error; `"none"` leaves host delivery unchanged. |

Brush uses the bound session's current settings for its description and stable
base/async schemas. Binding precedes the awaited first active-tool refresh,
including `--keep-builtin-bash`. Numeric settings are reread on the next host
prompt rebuild; changing a number alone does not promise an immediate rebuild.
An unbound omp execution reports `host_binding_unavailable`, rather than using
another session's settings. Pi's description and parameter surface stay unchanged.

A HostJob backgrounds after the configured threshold, an explicit attachment
wait, or a cancelled initiating attachment. Its `job_id` names the host's job;
the final result arrives automatically. Do not poll for that final result.
Without a host slot, ordinary Brush uses Coordinator delivery and can be polled.
Use `tty: true` for interactive sessions and `timeout: 0` for indefinite
noninteractive Brush work. The plugin has no service/ready API.

Brush transcripts use `log_path: artifact://<id>` only after successful closure.
The artifact contains exact native UTF-8 text before graphics/minimizer changes;
the String native bridge does not preserve arbitrary invalid UTF-8 process bytes.
Minimization replaces inline text only when that transcript was saved, with a
`[raw output: artifact://<id>]` footer. Missing or failed capture remains bounded
original text with an unsaved-output notice and no recovery link. Brush does not
write temporary process logs. Terminal images accompany final foreground and
HostJob results; polls return only new text, including terminal observations.

A HostJob's foreground and background final share the smaller of the configured
spill budget and the host's async inline boundary (currently 12000 characters,
conservatively bounded in UTF-8 bytes). This can shorten foreground Brush output
even with auto-background disabled; it prevents a second artifact containing only
an already-reduced result. Coordinator Brush retains the configured inline budget.

Real-process response body (short output, no truncation):

```
[still running]                     (or [exited])
session_id: 1                       (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with session_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/pi-unified-exec-1-5cc5e104.log
cwd: /home/you/project
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn — compare across polls to detect stalls)
omitted_bytes: 0                   (only present when the 1 MiB in-memory retention dropped middle bytes)
tty: false
---
<captured stdout+stderr>
```

If a chatty real pipe process exceeds its 1 MiB retention between polls, the
middle is dropped and a marker is spliced at that position. Brush uses the same
incremental retention but reports its actual artifact/inline-only recovery state:

```
[... 3145728 bytes omitted here (output exceeded the 1048576-byte in-memory retention between polls; the full stream is in the session log file) ...]
```

For real processes, output above 50 KiB / 2000 lines receives a footer:

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-1-5cc5e104.log]
```

#### PTY sessions (`tty: true`)

A tty session feeds every byte its child writes, in order, into a headless
terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless))
of the session's `cols`×`rows`, and each result reports what that terminal
shows rather than the raw stream:

```
[still running]
session_id: 3
…
tty: true
terminal: normal screen 120x30, cursor row 4 col 5
history_lines: 2                   (optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

- **History plus screen.** Lines that scrolled off the top since the previous
  call and were not already reported come first, then the whole current screen.
  Carriage-return progress bars and redraws show their final state.
- **Unchanged screen.** When neither the screen, the cursor nor the history
  changed, the result has `screen_changed: false` and `(no output)`.
- **Full-screen programs** (alternate screen, e.g. `top`, editors) are reported
  as `terminal: alternate screen …`; leaving it restores the normal screen.
- **Plain text and cursor only.** Colours are not in model results; the raw
  stream stays in `log_path`, and Tern's terminal page shows the colours.
- **Terminal queries are answered** on the child's input: cursor position and
  device attributes, and the default foreground/background colours (OSC 10/11).
  On omp the colours follow omp's theme (light or dark, which in Tern follows
  Tern's appearance); on Pi they are dark.
- History between calls is bounded by a cell budget (`TERMINAL_HISTORY_CELLS`
  divided by `cols` rows). Lines scrolled past it before a call reports them
  set `history_may_be_truncated: true`; they are only in the log.

### `write_stdin`

Drives or polls an existing session.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `chars` | string | `""` | Empty = pure poll; non-empty writes (after escape decoding) then polls. Mutually exclusive with `chars_b64`. |
| `chars_b64` | string | `""` | Base64-encoded bytes to write. Binary-safe. Mutually exclusive with `chars`. |
| `yield_time_ms` | number | `250` with input; `5_000` empty | Attachment window, not a process timeout. Input-bearing calls clamp to [250, 30_000]. Empty polls have a 5_000 minimum and no built-in maximum; fractional milliseconds round down. An explicit operator cap rejects larger relative polls. Mutually exclusive with `yield_until`. |
| `yield_until` | string | — | Absolute UTC deadline for an **empty poll only**, strict RFC 3339 UTC (`2026-07-21T18:30:00Z` or with `.mmm`; uppercase `Z`; real calendar dates only). **Only when the human explicitly asks** for a long attached wait. Returns on exit, cancellation or the deadline; a past deadline is an immediate poll. Mutually exclusive with `yield_time_ms` and with input bytes. |

#### Waiting on long-running commands

1. Use a finite `yield_time_ms` based on the expected job duration. Empty polls
   default to five seconds and have no built-in maximum. An attachment deadline
   never kills the process.
2. Use `yield_until` **only when the human explicitly asks** for a long attached
   wait or a wall-clock deadline on a **finite, non-interactive** command,
   computed from `tool_time_utc`. **Never** for REPLs, `sudo`, `ssh`, password
   prompts, dev servers, watchers or debuggers.
3. `on_exit` defaults to `"none"`. Use `"wake"` only when the human explicitly
   wants auto-resume; `set_on_exit(session_id, on_exit: "none")` disarms it
   without killing.
4. A completion observed directly by a tool result consumes the wake; a
   deadline or cancellation leaves it armed.

Both empty-poll forms use an event-driven monotonic wait. Pipe/Brush sessions
retain bounded cursor content; tty sessions retain their rendered screen.
Process logs receive raw bytes, while Brush uses its session artifact or explicit
inline-only state. Streaming is output-driven, not a quiet heartbeat. Cache
warming is the host's responsibility. Process logs and available Brush artifacts
are unbounded on disk; archive quotas remain
[follow-up work](docs/IV-0002-output-lifecycle-and-rendering.md#output-archive-safety).

| Env var | Default | Notes |
|---|---|---|
| `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` | unset, no cap | Optional limit for empty relative polls. Values below `5_000` become `5_000`; invalid values fail the poll instead of removing the limit. Does not affect `yield_until`. |

#### Control bytes and escapes in `chars`

`chars` is decoded as a C-style escape string before it is written.

| Escape | Produces |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH` (2 hex) | single byte |
| `\\uHHHH` (4 hex) | Unicode char |
| `\\u{H…H}` (1–6 hex) | Unicode code point |
| `\\\\` `\\"` `\\'` | literal `\` `"` `'` |
| `\\X` not in the list above | preserved literally (both chars) |
| Raw bytes in the string | pass through untouched |

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
write_stdin chars_b64="G3s6wgo="  → exact 5 decoded bytes
```

Passing both `chars` and `chars_b64`, or malformed base64, rejects the call.
Submit tty input with `\r`: it works everywhere, while `\n` does not run a line
in legacy Windows consoles.

### `set_on_exit`

Changes the `on_exit` policy **without killing the process**.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `on_exit` | `"none"` \| `"wake"` | — | `"none"` disarms a pending wake (also for coordinator tombstones after eviction). `"wake"` arms it while the session is still running in the store. |

Status tokens: `disarmed`, `already_none`, `armed`, `already_armed`,
`too_late`; unknown ids return `found: false`. Disarming cannot recall a
follow-up already queued to the host.

For HostJob sessions, `"none"` reports no change to automatic host delivery;
`"wake"` returns `on_exit_requires_coordinator`.

### `on_exit: "wake"` — completion notifications

> Coordinator completion is delivered through a finalized tool result **or**
> causes one synthetic model prompt, never both. HostJobs use only host delivery.

- An exit that lands while a `write_stdin` is observing is returned by that
  call, and the wake is consumed when the result is finalized. A result
  finalized as error or cancelled keeps the wake eligible.
- A deadline or a cancelled call leaves the wake armed; when the process later
  exits, exactly one follow-up prompt is sent (`deliverAs: "followUp"`, never
  interrupting a running turn). Simultaneous completions are batched into one
  prompt.
- The prompt carries bounded metadata only (session id, exit code/signal,
  command, cwd, elapsed time, log path, failure) — never raw output.
- `kill_session`, the `/unified-exec-sessions` command, LRU eviction of a live
  process and `session_shutdown` suppress the wake; a kill that fails restores
  it. A naturally exited wake session evicted before notification keeps a
  bounded tombstone so its wake is still delivered.

### `kill_session`

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `signal` | string | `"SIGTERM"` | Escalates to SIGKILL after 2s. `"SIGKILL"` skips the grace. On Windows any signal force-kills the process tree. |

Real-process signal names are normalized (`term`, `INT`, `sigkill`); unknown
names are rejected. Failed kills remain registered with `running: true`.
Brush ignores signal distinctions and uses its one termination primitive.
Hidden slash controls preserve the observation cursor; the model-visible
`kill_session` result returns unseen tail. Concurrent observations consume
each tail segment only once.
An already-settled Brush reports `already_exited`, and HostJob observation does
not replay an already-delivered body. The tty-only HUD uses the process kill path.

### `list_sessions`

Real-process exits are reported once before pruning. Ended Brush HostJobs carry
`delivery: pending | delivered | terminated`: pending results remain observable;
delivered/terminated indexes are removed without taking ownership from the host.
Each entry reports `wake_armed` and truthful `log_path`; Brush has native `pids`
while running rather than a shell `pid`. The response includes `tool_time_utc`.

## Command and flag

- `/unified-exec-sessions` — lists live sessions in a selector (armed wakes
  show `[wake]`) and kills the chosen one, or all, without the model, with the
  same SIGTERM → 2s → SIGKILL escalation.
- `--keep-builtin-bash` — on Pi, the built-in `bash` tool is removed from the
  active set by default so the model uses `exec_command` / `write_stdin`; this
  flag keeps it.

## Presentation

**On omp,** `exec_command`, `write_stdin` and `kill_session` render through
omp's exported bash renderer, in the ANSI TUI and in Tern: `$ cmd`, collapsed
output with omp's expand binding, the exit chip and error tone for failures,
`Backgrounded: session N` for running sessions, and the truncation marker with
the log path as the last line. `write_stdin` and `kill_session` show their
action as a bash comment (`# poll session N`, `# stdin → session N: "…"`,
`# kill session N (SIGTERM)`). `set_on_exit` and `list_sessions` use omp's
default card. If omp's bash renderer is missing or reshaped, plugin loading
fails rather than showing raw envelopes.

**On Pi,** all five tools have their own renderers: command banners,
five-visual-line output tails expanded with `app.tools.expand`, live elapsed
counters, `⟳ poll` / `» input` banners and kill/list summaries. While a process
is alive the footer shows `unified-exec: N sessions running`.

Pi's output contract remains unchanged; omp Brush adds the artifact, image,
timeout and HostJob metadata described above. The host currently name-gates
background-card retention: protocol/job progress continues after return, but an
extension's original card can remain frozen. The plugin does not patch that
private allowlist or add another HUD.

## Codemode scripts (Pi)

Every tool declares an `outputSchema` and returns matching
`structuredContent`, so Pi codemode scripts receive an object:

```js
const r = await tools.exec_command({ cmd: "npm test", yield_time_ms: 30000 });
if (r.running) text(`still running as session ${r.session_id}`);
else text(`exit ${r.exit_code}`);
text(r.output); // print the output, not the whole object
```

Shapes are in `src/script-result.ts`. On Pi the package also caps collapsed
codemode results at ten visual rows (all nested tools, display only);
`PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` opts out. omp has no codemode, so this is
off there.

## Constants

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
MIN_EMPTY_YIELD_TIME_MS      = 5_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
HEAD_TAIL_MAX_BYTES          = 1 MiB   (in-memory drain buffer, pipe sessions)
TERMINAL_HISTORY_CELLS       = 240_000 (tty history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 2000
```

## Semantics

- **Real-process early exit:** commands finishing within 150 ms do not enter the
  store. Brush is indexed before asynchronous preparation and owns a separate
  native/output lifecycle.
- **Exits between calls:** real processes stay until observed; HostJob indexes
  follow host consumption/retention without duplicating delivery.
- **Startup failures:** omp cwd errors are rejected before allocation; process
  spawn failures report `failure_message`.
- **Shell exit vs pipe close:** real-process sessions remain open while inherited
  stdout is held. Brush ends with its foreground native command; retained `&`
  jobs belong to the shell lifecycle, not a reopened output archive.
- **Closed stdin** never crashes the host; writes report `failure_message`.
- **Esc** breaks the current wait but leaves the session running.
- **Shutdown** terminates Brush through its cancellation primitive and disposes
  its owned shells; real processes receive TERM and surviving processes KILL.
- **LRU eviction** at 64 sessions takes the oldest non-protected one, preferring
  exited sessions; the 8 most recent are never evicted.
- **tty observations** are serialized per session; streaming updates and the
  Tern HUD read the screen without consuming it.
- **Recovery:** real-process logs live under the temporary directory and are not
  deleted by this package. Brush transcripts belong to the host's session
  artifact lifecycle; failed/partial captures are never linked as complete.
  Inspect raw PTY logs with a non-executing viewer, not `cat`.

## Worked examples

### Dev server

```
> exec_command(cmd="npm run dev", shell="bash", yield_time_ms=5000)
[still running]
session_id: 1
---
> Server listening on :3000

> write_stdin(session_id=1, chars="", yield_time_ms=10000)
[still running]
---
  GET /health 200 in 3ms

> kill_session(session_id=1)
```

### Interactive Python REPL

```
> exec_command(cmd="python3 -q", tty=true, yield_time_ms=1500)
[still running]
session_id: 1
terminal: normal screen 120x30, cursor row 1 col 5
---
>>>

> write_stdin(session_id=1, chars="print(7*6)\r", yield_time_ms=1000)
[still running]
terminal: normal screen 120x30, cursor row 3 col 5
---
>>> print(7*6)
42
>>>
```

### Long job with auto-resume (human asked for it)

```
> exec_command(cmd="npm test", shell="bash", yield_time_ms=1000, on_exit="wake")
[still running]
session_id: 2
completion_notification: armed
---
# …the agent ends its turn; when npm test exits, one follow-up prompt resumes it.
> set_on_exit(session_id=2, on_exit="none")   # if the job is abandoned
```

## Windows

Pipes and PTY both work; `tty: true` uses ConPTY through `Bun.Terminal` (Bun)
or node-pty (Node).

- **Real-process default shell:** `bash`, found via `PI_UNIFIED_EXEC_BASH`, then `bash` on
  PATH (excluding System32's WSL stub), then Git for Windows derived from
  `git.exe` or well-known install roots, then `powershell` with a one-time
  warning. Shell names are resolved to absolute paths before spawning.
- **No POSIX signals:** every kill is a tree kill (`taskkill /T /F`); killed
  processes report `exit_code: 1`, and failed kills are reported, not hidden.
- **Node PTY prebuilds** are downloaded at install time and not covered by an
  npm digest; Bun's built-in backend has no such download.

## Layout

| Area | Files |
|---|---|
| Registration, sessions and ownership | `src/index.ts`, `session.ts`, `session-store.ts`, `completion.ts` |
| Observation and waits | `src/head-tail-buffer.ts`, `collect.ts`, `long-wait.ts`, `time.ts`, `notify.ts` |
| Real process and terminal | `src/pty.ts`, `shell.ts`, `terminal-screen.ts`, `unescape.ts` |
| Result and Pi presentation | `src/tool-result.ts`, `script-result.ts`, `render.ts`, `codemode-render.ts`, `output-safety.ts`, `format-time.ts` |
| omp Brush and native addon | `fork-features/brush/`, `fork-features/native/` |
| omp cards and tty HUD | `fork-features/omp-presentation.ts`, `omp-tools.d.ts`, `tern-terminal-hud.ts` |
| Tern installation/style | `fork-features/tern-plugin-install.ts`, `fork-features/tern-plugin/` |
| Contracts and maintenance | `docs/IV-0001-long-wait-and-wake-control.md`, `IV-0002-output-lifecycle-and-rendering.md`, `DC-0001-agentic-workspace.md`, `DEV.md`, `fork-features/README.md` |

## Tests

```bash
npm install
npm test                                   # strict typecheck + unit/integration suites
EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
npm run test:tui                           # Pi tmux acceptance (skips without tmux)
```

Under Node the Node PTY suites skip when no prebuild loads; the Bun command runs
the HUD lifecycle tests against real PTY sessions. Tern behaviour is qualified
in a real Tern window, as described in
[fork-features/README.md](fork-features/README.md).

## Development and upstream

[docs/DEV.md](docs/DEV.md) is upstream's maintainer guide (dev loop, test
recipes, codex sources); its npm release section does not apply here, since
the fork's publish workflow is disabled. Upstream changes arrive through the
daily `Sync upstream` workflow; how fork changes are kept apart from upstream
and resolved on sync is in [fork-features/README.md](fork-features/README.md).

Licensed [MIT](./LICENSE), like upstream.
