# omp-unified-exec

English | [简体中文](README.zh-CN.md)

Long-lived shell sessions for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp), with a terminal HUD in Tern. Every command the
model runs becomes a session it drives with writes and polls, instead of a
single blocking call: dev servers, REPLs, `ssh`, `sudo`, full-screen programs
and long jobs keep running between turns, and a human can watch and type into
them from Tern.

This is a fork of [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec),
a Pi port of codex's `unified_exec`. The tool surface (`exec_command`,
`write_stdin`, `set_on_exit`, `kill_session`, `list_sessions`) and its
semantics are upstream's; the fork adds what omp and Tern need. The full list
of fork changes, why each exists and how to requalify them on omp/Tern
upgrades is in [fork-features/README.md](fork-features/README.md).

## Install

```bash
omp install https://github.com/mouriya-s-lab/omp-unified-exec
```

Remove an existing `pi-unified-exec` first (`omp plugin uninstall
pi-unified-exec`): both register the same tools. The fork publishes nothing to
npm.

Run inside Tern, omp installs the package's Tern plugin itself at the first
session (see [Tern terminal HUD](#tern-terminal-hud)). Nothing else is
configured.

The package still loads on Pi unchanged (Pi's renderers, no HUD). PTY mode uses
Bun's native `Bun.Terminal` under Bun 1.4+ (omp is a compiled Bun executable),
and the optional `@homebridge/node-pty-prebuilt-multiarch` under Node. Without
either, pipe mode (`tty: false`) still works and `tty: true` reports the missing
capability.

## What it does

- **Sessions, not calls.** `exec_command` starts a process and returns within
  its yield window with output so far and a `session_id`; `write_stdin` writes
  to it, polls it, or sends control bytes (`\x03` Ctrl-C, arrow keys) on later
  turns. Cancelling a call never kills the process.
- **PTY output is what a terminal shows.** `tty: true` sessions run through a
  headless terminal emulator, so progress bars, redraws and full-screen
  programs come back as the current screen (plus lines scrolled off since the
  last call and the cursor), not every redraw appended. The emulator answers
  the terminal queries a real terminal would (cursor position, device
  attributes, default colours), so programs that wait for them, or pick a light
  or dark palette from them, behave as in a real terminal.
- **Bounded output, complete recovery.** Every result the model sees is
  tail-capped at 50 KiB / 2000 lines and stripped of terminal controls; the
  complete raw stream of every session is written to `log_path`.
- **Opt-in completion wake.** `on_exit: "wake"` resumes the agent once when a
  backgrounded process exits unobserved; `set_on_exit` disarms it.
- **omp-native presentation.** `exec_command`, `write_stdin` and
  `kill_session` render through omp's own bash card (command line, output,
  exit chip, error tone), in the ANSI TUI and in Tern alike.
- **A terminal HUD in Tern.** Watch, scroll back through, type into and kill
  the model's tty sessions without a tool call.

## Tern terminal HUD

When omp renders natively in Tern and a tty session exists:

- **Counter pill.** A terminal icon and the session count, copied from omp's
  running-work counter, sit on their own line just above omp's counter. Its ✕
  hides the HUD until a new tty session starts.
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
while omp renders natively, so omp's ANSI TUI gains no row. Model-visible
results stay plain text.

**The Tern plugin.** An omp extension cannot add to omp's pill line, so the
package ships a CSS-only Tern plugin (`fork-features/tern-plugin/`). It moves
the HUD's row above omp's pill line and sets the sheet's output preview in the
monospace face; omp's own rows are untouched. omp keeps it installed: at the
first interactive session inside a Tern pane (detected as omp does, from
`TERN_PANE_SOCKET` and `TERN_PANE`) it asks Tern with `tern plugin list --json`
and, unless Tern already runs the plugin's current version, links the
package's plugin directory with `tern plugin link`. An install or update shows
a toast; a failure shows a warning with the manual command. The link reloads
Tern's plugins, so the open window picks the stylesheet up. Without the plugin the pill sits below
the composer.

Design, decisions and Tern qualification evidence:
[docs/IV-0002-output-lifecycle-and-rendering.md](docs/IV-0002-output-lifecycle-and-rendering.md).

## Tools

### `exec_command`

Runs a command in a persistent session.

| Param | Type | Default | Notes |
|---|---|---|---|
| `cmd` | string | — | Shell command. Required. |
| `workdir` | string | turn cwd | Working directory. |
| `shell` | string | `bash` | Shell binary. On Windows: `bash` if found, else `powershell`. `cmd` / `powershell` / `pwsh` get shell-appropriate flags. |
| `tty` | boolean | `false` | Allocate a PTY. Output is then the rendered terminal screen; see [PTY sessions](#pty-sessions-tty-true). |
| `cols` | number | `120` | PTY width (`tty: true` only). Clamped to [20, 500]. |
| `rows` | number | `30` | PTY height (`tty: true` only). Clamped to [5, 300]. |
| `yield_time_ms` | number | `10_000` | How long this call stays attached waiting for output (not the command's lifetime), clamped to [250, 30_000]. |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | Policy for exits nobody is observing. `"wake"`: one follow-up prompt resumes the agent — only when the human explicitly wants auto-resume. Change later with `set_on_exit`. |

Response body (short output, no truncation):

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

If a chatty pipe session produces more than the 1 MiB in-memory retention
between polls, the middle is dropped and a marker is spliced at the omission
point (the full stream is always in `log_path`):

```
[... 3145728 bytes omitted here (output exceeded the 1048576-byte in-memory retention between polls; the full stream is in the session log file) ...]
```

When output exceeds the caps (50 KiB / 2000 lines), a footer is appended:

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

Both empty-poll forms use the same event-driven wait on monotonic time. Pipe
sessions keep output in a bounded head/tail buffer, tty sessions in their
terminal screen; the log always gets the raw stream. Streaming updates are
output-driven (short polls at most four per second, long and absolute waits at
most once per 30 seconds), with no heartbeat while quiet. Cache warming during
waits is the host's business, not this package's. Raw logs are unbounded on
disk; archive quotas are [follow-up work](docs/IV-0002-output-lifecycle-and-rendering.md#output-archive-safety).

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

### `on_exit: "wake"` — completion notifications

> Terminal completion is delivered through a finalized tool result **or** it
> causes one synthetic model prompt — never both.

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

Signal names are normalized (`term`, `INT`, `sigkill`); unknown names are
rejected. The result uses the same bounded envelope as the other tools, with
`killed`, `escalated`, requested/actual signal and `running`. A failed kill
stays registered and reports `running: true`. The Tern HUD's Kill uses the same
path.

### `list_sessions`

Lists live sessions and reports each exited one a final time (with
`running: false`, `exit_code`/`signal` and `log_path`) before pruning it. Each
entry has `wake_armed`; the response carries `tool_time_utc` for computing
`yield_until` deadlines.

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

Model-visible content and persisted details are the same on both hosts.

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

- **Early exit:** commands that finish within 150 ms never enter the session
  store; the result has `exit_code` and no `session_id`.
- **Exits between calls** stay in the store until the next `write_stdin` or
  `list_sessions` reports them.
- **Spawn failures** (missing shell or `workdir`) surface as `failure_message`.
- **Shell exit vs pipe close:** a session runs until its output pipe closes.
  Background children that inherited stdout keep it open; such results carry a
  `note` on how to detach them.
- **Closed stdin** never crashes the host; writes report `failure_message`.
- **Esc** breaks the current wait but leaves the session running.
- **Shutdown** sends SIGTERM to every session and SIGKILLs survivors after 1s.
- **LRU eviction** at 64 sessions takes the oldest non-protected one, preferring
  exited sessions; the 8 most recent are never evicted.
- **tty observations** are serialized per session; streaming updates and the
  Tern HUD read the screen without consuming it.
- **Logs** live in the temp directory (`/tmp` or `%TEMP%`) and are never
  deleted by the package. Inspect raw PTY logs with a non-executing viewer, not
  `cat`.

## Worked examples

### Dev server

```
> exec_command(cmd="npm run dev", yield_time_ms=5000)
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
> exec_command(cmd="npm test", yield_time_ms=1000, on_exit="wake")
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

- **Default shell:** `bash`, found via `PI_UNIFIED_EXEC_BASH`, then `bash` on
  PATH (excluding System32's WSL stub), then Git for Windows derived from
  `git.exe` or well-known install roots, then `powershell` with a one-time
  warning. Shell names are resolved to absolute paths before spawning.
- **No POSIX signals:** every kill is a tree kill (`taskkill /T /F`); killed
  processes report `exit_code: 1`, and failed kills are reported, not hidden.
- **Node PTY prebuilds** are downloaded at install time and not covered by an
  npm digest; Bun's built-in backend has no such download.

## Layout

```
src/
├── index.ts              # tool registration, event handlers, flag
├── session.ts            # ExecSession: spawn, read, write, kill, log stream, state
├── session-store.ts      # SessionStore + LRU eviction
├── head-tail-buffer.ts   # port of codex's HeadTailBuffer
├── collect.ts            # collectOutputUntilDeadline
├── long-wait.ts          # event-driven empty-poll wait + rate-limited streaming
├── time.ts               # durations, operator limit, strict UTC deadlines
├── format-time.ts        # elapsed / remaining labels
├── completion.ts         # on_exit "wake" coordination (exactly-once)
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # Bun.Terminal + node-pty backends, pipes, Windows tree-kill
├── shell.ts              # shell selection and argv (Windows-aware)
├── output-safety.ts      # terminal-control stripping
├── terminal-screen.ts    # headless terminal: observations, styled screens, query answers
├── tool-result.ts        # bounded envelopes + model-visible text
├── script-result.ts      # codemode outputSchema / structuredContent
├── render.ts             # Pi renderers for all five tools
├── codemode-render.ts    # Pi codemode preview cap
└── unescape.ts           # C-style escape decoder for `chars`
fork-features/
├── omp-presentation.ts   # omp host detection, bash-renderer delegation, theme appearance
├── omp-tools.d.ts        # types of the omp modules loaded at runtime
├── tern-terminal-hud.ts  # counter pill, Terminals sheet, terminal page
├── tern-plugin-install.ts# keeps the Tern plugin installed
├── tern-plugin/          # CSS-only Tern plugin
└── README.md             # fork customizations and requalification
docs/
├── IV-0001-long-wait-and-wake-control.md
├── IV-0002-output-lifecycle-and-rendering.md
├── DC-0001-agentic-workspace.md
└── DEV.md                # upstream's maintainer guide
```

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
