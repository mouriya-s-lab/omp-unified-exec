# IV-0002 — Bounded output lifecycle and compact tool rendering

**Status:** active; codemode visual-row fix shipped in 0.12.1
**Root IV:** this document
**Related release:** [Changelog.md](../Changelog.md) — 2026-09-30 — 0.12.1
**Workspace doctrine:** [docs/DC-0001-agentic-workspace.md](./DC-0001-agentic-workspace.md)

## Intent

`kill_session` historically appended its entire retained final drain directly to
the tool result and had no custom Pi renderer. Pi therefore used its generic
fallback renderer, which ignored the collapsed/expanded state and printed the
whole payload. The same result bypassed unified-exec's normal 50 KiB / 2000-line
model-output cap and persisted an undocumented unbounded `final_output` field.

`list_sessions` also relied on the fallback renderer. Its inventory was smaller,
but the inconsistency meant the package's claim that tool output was compact and
expandable was not true for every tool.

The initiative establishes a durable output contract across these layers:

1. **Capture:** the child stream is mirrored to its session log.
2. **Model/session result:** every output-bearing result is a bounded,
   terminal-inert plain-text tail with explicit truncation/omission metadata and
   a recovery path.
3. **TUI:** the bounded result is collapsed to five visual lines by default and
   expands through Pi's configured `app.tools.expand` binding.
4. **Scripts (0.12.0):** Pi codemode scripts receive `structuredContent`
   matching each tool's `outputSchema`, whose `output` is the same bounded,
   terminal-inert tail with real newlines. Without it, scripts received the
   whole text envelope as one string. Printing that string inside an object
   collapsed it to one escaped logical line, which Pi's logical-line codemode
   preview could not bound.
5. **Codemode presentation (0.12.1):** by default register Pi's native codemode
   definition with a result-renderer-only decorator. Compact JSON from
   `text(r)` / settled results flooded Pi 0.99.1's logical-line previews.
   Pi 0.99.2 bounds individual sections by visual lines, but does not bound
   many nested-call summaries as one result. Bound rendered rows at ten,
   including call summaries,
   spacers, clipping hint and native full-output-path footer; leave expanded
   output and all model/script data native.
6. **oh-my-pi presentation (fork):** omp calls extension renderers with its own
   signatures and its Tern frontend reads `describeCall`/`describeResult`, so
   the Pi renderers threw there and omp showed the raw model envelope. On omp,
   `exec_command`, `write_stdin` and `kill_session` present through omp's own
   bash renderer from the same bounded `details`; the other tools use omp's
   default card.
7. **Rendered tty output:** PTY children draw with cursor movement, erases,
   carriage returns and the alternate screen. Stripping those controls left
   every redraw appended to the previous one, so neither the model nor a human
   saw the terminal's actual state. tty sessions now feed their output into a
   per-session headless terminal emulator, and each result reports the unseen
   history plus the current screen and cursor.

## Requirements

- Never depend on a TUI renderer to enforce model/session size limits. Pi falls
  back to raw result content if a renderer throws.
- Apply Pi's `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` tail limits to
  `kill_session`, including model-visible recovery markers; independently cap
  metadata scans/headers that sit outside the output body.
- Keep the full retained stream out of result details; `details.output` is the
  canonical bounded body for exec, write, and kill.
- Strip ANSI/VT sequences and unsafe C0/C1 controls before child text reaches
  model content, persisted details, partial updates, or custom renderers. Pipe
  text is stripped directly; tty bytes are first interpreted by the session's
  terminal emulator and only its rendered plain text (sanitized again) leaves
  it. Keep exact raw bytes only in the session log and sanitize again while
  rendering legacy/fallback details.
- tty observations are consuming and serialized per session; a cancelled empty
  poll does not observe. Streaming snapshots never consume. The emulator is
  read only after every written chunk is parsed, and released after the session
  leaves ownership and its pending writes are parsed.
- Represent operation and state explicitly (`operation`, `status`, `running`),
  rather than inferring liveness from the presence of `session_id`.
- Preserve failed-kill ownership: an unconfirmed kill remains registered and is
  reported as running.
- On Pi, give all five tools explicit call and result renderers and use
  `keyHint("app.tools.expand", ...)`, not a hard-coded Ctrl+O label. On omp,
  never register Pi-signature renderers: exec/write/kill provide omp render and
  describe hooks delegating to omp's bash renderer; set_on_exit and
  list_sessions use omp's bounded default card.
- Count collapsed child output in visual lines after terminal wrapping.
- Keep truncation and log-recovery warnings visible while collapsed.
- Do not synchronously load an arbitrary log file when expanded. Expanded mode
  shows the complete bounded result; `log_path` owns complete-stream recovery.
- Preserve native codemode definition fields/schema by reference, inactive
  default, settings/loadout, MCP auto-activation, model helpers and store/load.
- Unwrap cached native components before calling the original renderer; Pi
  catches renderer exceptions and can silently expose the unbounded fallback.
- Default-on codemode replacement must not write settings or activate the tool
  beyond `defaultTools`. Register at session start so Pi keeps the built-in
  loaded and never warns; verify precedence and warn on loss. Offer only
  explicit opt-out `PI_UNIFIED_EXEC_COMPACT_CODEMODE=0`.

## Decisions

| Decision | Rationale |
|---|---|
| Split output serialization into `src/tool-result.ts` | Result bounds remain testable without process or TUI machinery, and `src/index.ts` no longer carries multiple ad-hoc serializers. |
| Replace undocumented `final_output` with bounded `output` | One canonical renderer/model field; avoids persisting up to the 1 MiB retained buffer. GitHub code search found no external consumer. |
| Version as 0.9.0 | The observable details shape changed even though the old field was undocumented. |
| Tool-specific render entry points over generic fallback | Kill/list semantics differ from process yields; explicit renderers prevent identity from being mistaken for liveness. |
| Expand only bounded output | Rendering or reading an unlimited multi-gigabyte log from a synchronous tool row is unsafe. |
| Make result text terminal-inert; preserve raw logs | PTY output can contain clipboard, alternate-screen, keyboard-mode, and cursor controls. Models need text, not executable terminal state; forensic bytes remain recoverable by path. |
| Project script results from details, not a second serializer | `structuredContent` inherits the bounds and terminal safety of `details.output`; metadata strings reuse `safeMeta`. Model `content` stays byte-identical. |
| Require Pi 0.99.1 for 0.12.0 | `outputSchema`/`structuredContent` do not exist in earlier Pi types. Older Pi users stay on 0.11.x. |
| Keep complete logs for now | Archive bounding/retention is a separate policy change and remains follow-up work. |
| Bundle the native codemode display fix by default in 0.12.1 | Owner requested the fix here, not a separate package. It applies globally to nested tools while unified-exec is loaded; no Pi core patch or executor fork. |
| Register codemode at session start in 0.12.2 | Load-time registration made Pi skip `builtin:codemode` and warn every package user. Session-start registration is Pi's documented dynamic-tool pattern; load order keeps this definition first, the built-in stays as fallback, and precedence is checked at runtime. |
| Wrap the public factory via a receiver-bound API proxy | Keep native execution/schema/loadout/persistence and method receivers intact; intercept only tool registration and result rendering. |
| Keep native ordering and clip the rendered head at ten rows | Bound the whole result text component. Call summaries can consume the budget; reserve recovery/hint footer space. Script-call and separate image components are outside this cap. |
| Use a non-numeric clipping hint | Native rendering has already hidden output, so its rendered row count is not the full-output hidden-row count. |
| Present on omp through omp's exported bash renderer | omp's `toolRenderers.bash` (`@oh-my-pi/pi-tui/tools`) already owns collapse, expansion, exit/background status and both ANSI and Tern views; reimplementing them on omp's native view primitives would couple deeper. Only a pure display adapter is plugin code. omp is identified by its injected `ExtensionAPI.arktype`; on omp a missing or reshaped bash renderer fails plugin loading instead of silently re-registering Pi renderers. Pi activation stays synchronous and unchanged. |
| Show write/kill actions as bash comments | `# poll session N`, `# stdin → session N: "…"`, `# kill session N (SIGTERM)` name the action without presenting input bytes as an executable command; base64 input shows only its byte count. |
| Append the truncation marker to the omp display text | The marker and `log_path` live outside `details.output`; appending `truncationMarker()` keeps recovery visible as the last collapsed line without claiming the log is an omp artifact. |
| Mark omp Tern failures with view tone, not result `isError` | Tern derives card status from the host result's `isError`, which stays false for a nonzero exit because that is an ordinary completion for the model. The describe view sets `tone: "error"` for failed exits, signals, start failures and failed or unknown kills; the exit chip comes from omp's bash head. |
| Render tty output through `@xterm/headless` | Proven identical under Node, Bun and a `bun build --compile` binary, with no DOM, assets or native code. Rejected: Codex's `TERM=dumb`/`NO_COLOR`/`PAGER=cat` mitigation (openai/codex `core/src/unified_exec/process_manager.rs:94-104`), which cannot stop programs that force redraws ([openai/codex#32325](https://github.com/openai/codex/issues/32325)). |
| tty result = unseen history + full current screen + cursor | A self-contained screen matches what a human sees and does not ask the model to splice earlier results. Rejected: a first-changed-row delta, which leaves full-screen redraws without context. Lines scrolled off since the last observation that equal the previous screen's rows at the same position were already reported and are skipped; an unchanged screen reports `screen_changed: false`. Only plain text and the cursor are represented (owner's choice); styling stays in the log. |
| Align history by erasing the emulator's scrollback (ED3) after each observation | The next observation's history then starts at the previous screen's top row, so positional comparison is exact. Rejected: counting scroll events into absolute line numbers, which leaving the alternate screen, DECSTBM regions, ED3 and RIS all break. |
| Bound tty history by cells, not lines | History rows = 240000 cells / `cols`, at least one screen; reaching the cap reports `history_may_be_truncated` because the emulator exposes no exact eviction count. |

## Implementation map

| Area | Location |
|---|---|
| Terminal-control scanner | `src/output-safety.ts` |
| tty terminal emulator, observations, snapshots | `src/terminal-screen.ts`, owned by `ExecSession` (`src/session.ts`); released by `src/session-store.ts`; tests `tests/terminal-screen.test.ts` |
| Shared output envelope, truncation, process/kill text | `src/tool-result.ts` |
| Codemode script schemas and projections | `src/script-result.ts`, `tests/script-result.test.ts` |
| Kill collection, partial sanitization, and tool registration | `src/index.ts` (`TerminateOutcome`, `buildStreamUpdate`, `kill_session`) |
| Explicit Pi renderers and shared five-line preview | `src/render.ts` |
| omp host selection, bash-renderer delegation, result/args display adapters | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`; wired by `withHostPresentation` in `src/index.ts`; tests `tests/omp-presentation.test.ts` |
| Native codemode factory/renderer wrapper | `src/codemode-render.ts`; registration from `src/index.ts` |
| Codemode width/cache/schema and real-CLI parity | `tests/codemode-render.test.ts`, `tests/codemode-cli.test.ts` |
| Real codemode TUI A/B/C, opt-out, no-warning, legacy exclusion and recovery | `tests/tui-codemode.test.mjs`, `tests/fixtures/codemode-*` |
| Pure output and terminal-safety tests | `tests/{tool-result,output-safety}.test.ts` |
| Collapse/expand/list/legacy-safety renderer tests | `tests/render.test.ts` |
| Real delayed noisy-kill regression | `tests/e2e.test.ts` |
| Package/runtime compatibility | `package.json`, `package-lock.json`, `.github/workflows/ci.yml` |
| Public behavior and development guidance | `README.md`, `docs/DEV.md`, `Changelog.md` |

## Related upstream issues

These are design evidence rather than a direct tracker for this repository,
whose GitHub issues are intentionally disabled:

- [earendil-works/pi#31](https://github.com/earendil-works/pi/issues/31) —
  tool expansion through `app.tools.expand`.
- [#134](https://github.com/earendil-works/pi/issues/134) — bounded model
  output, visible warnings, and full-output recovery.
- [#275](https://github.com/earendil-works/pi/issues/275) — visual-line rather
  than logical-line previews.
- [#1795](https://github.com/earendil-works/pi/issues/1795) and
  [#5137](https://github.com/earendil-works/pi/issues/5137) — live TUI flooding
  and fallback/custom-tool output.
- [#6548](https://github.com/earendil-works/pi/issues/6548) — configured key
  hints in bounded previews.
- [#7578](https://github.com/earendil-works/pi/issues/7578) — exact failure
  class where a custom tool ignores the expanded flag.
- [#7237](https://github.com/earendil-works/pi/issues/7237) — related archive
  quota/failure concerns tracked below.

## Evidence and reproduction

omp 18.8.7 presentation qualification, 2026-10-10, macOS arm64
([#11](https://github.com/mouriya-s-lab/omp-unified-exec/issues/11)). The
installed omp binary loaded the checkout with `-e src/index.ts --keep-builtin-bash`
and an offline scripted provider extension that emits tool calls only. Seventeen
calls covered failed and successful exits, 14-line collapse with Ctrl+O, a
yielded session followed by a poll, `seq 1 100000` truncation, a missing
workdir, `kill -TERM $$`, a tty `cat` driven by text and base64 stdin,
`set_on_exit`, `list_sessions` (non-empty and empty), a successful kill, and an
unknown kill. In the ANSI TUI (tmux), the exec, write and kill cards match the
built-in bash card: `$ cmd`, Output, `Exit: N` and error border for failures,
`Backgrounded: session N`, and the truncation marker with the full log path
while collapsed. In TSP frames from a real PTY handshake, the tool nodes carry
the bash head (command target, `lang: bash`, exit chip), and failures have
`tone: "error"`. Neither frontend showed envelope fields, and the logs had zero
`Tool renderer failed` / `Tool describe failed` entries. The same day,
`npm test` passed 371 tests with three Windows-only skips, and
`npm run test:tui` passed 21. TSP evidence is wire-level; no Tern GUI
screenshot was taken.

Pi 1.0.0 qualification, 2026-10-02, macOS arm64/Node 24.21.0:
exact development pins/locks updated, production renderer/executor unchanged.
Native codemode now points to `docs/codemode.md`; tests no longer require its
retired inline model declaration. `tests/codemode-models.test.ts` compares
native/wrapped generated images and classifier/image usage, checks `in`
probes and fail-fast unknown properties, with only fake model methods.
`EXPECT_PTY=1 npm test`: strict types, 348 passes and three Windows-only skips.
`npm run test:tui`: 21 passes, including regular/fullscreen and system/dark/light.
No npm publication, installed replacement or live model qualification.

Automated gate:

```bash
npm test
```

Codemode focused gates (all providers are offline fixtures; MCP is local stdio):

```bash
npx tsx --test tests/codemode-render.test.ts tests/codemode-cli.test.ts
npm run test:tui
```

On Pi 0.99.1 at 100×60, native object/settled result text components took 20/21 rows;
the wrapper takes at most ten including summaries/spacers/footer. Multiline
output keeps the original 36-more-lines hint when it fits. Actual CLI gates
compare content after normalizing only the elapsed-time header, plus native
declarations, mode/budget, default/legacy-exclusion/opt-out/MCP activation, search/model helpers
and all store entries. TUI gates exercise Ctrl+O expansion and recollapse at
40/80/100 columns, regular/fullscreen and dark/system/light themes, with no
generic renderer fallback. Re-run on Pi upgrades; local TUI evidence is Linux,
not live provider traffic or non-Linux terminal qualification. Pi 0.99.2
macOS qualification is recorded below; it does not rewrite that release evidence.

The local Pi 0.99.2 migration updates exact development pins while retaining
`>=0.99.1` peers. Renderer tests accept native previews already within the cap,
verify whole-result clipping for many summaries, and exercise native Container
cache reuse. Tmux tests measure the isolated server with extended keys enabled
to exclude host startup warnings. Runtime execution and rendering logic are
unchanged. This is an unpublished checkout change, not an installed update.

Local 0.12.1 release gate: `EXPECT_PTY=1 npm test` passes strict types and
342 tests, with three Windows-only skips. `npm run test:tui` passes all 21
cases. The eight codemode CLI cases and all TUI cases also pass with
`PI_UNIFIED_EXEC_TEST_CLI` pointing at the installed 0.99.1 bundled CLI.
`npm audit --omit=dev` reports zero vulnerabilities and `npm pack --dry-run`
includes the new renderer module. No live provider traffic was used.

The focused process regression:

1. starts a command that yields before producing output;
2. emits 4000 long lines and then remains alive;
3. waits until the final line reaches the log;
4. calls `kill_session`;
5. asserts `details.output` is at most Pi's byte cap, the model text carries a
   truncation marker, no `final_output` exists, and the log contains line 1
   through line 4000.

Pure and renderer tests additionally exercise CSI/SGR mode changes, OSC
clipboard/title writes, terminal strings, C0/C1 controls, unterminated
sequences, legacy raw details, collapse, expand, re-collapse, expand-hint
placement, partial-preview cache refresh, unknown-id errors, and a seven-entry
session inventory with width-keyed row caching.

Manual TUI smoke procedure:

```text
exec_command: delayed noisy command that sleeps after output
kill_session: terminate its returned session id
observe: five visual tail lines + expansion hint + kill/log status
app.tools.expand: full bounded result
app.tools.expand again: five-line tail restored
```

## Consumers

- Pi model turns using `exec_command`, `write_stdin`, `kill_session`, or
  `list_sessions`.
- Humans reviewing streaming and settled tool rows in Pi's TUI, and in omp's
  ANSI TUI and Tern frontend; exact PTY logs must be opened through a
  non-executing reader/escape visualizer, not `cat`.
- Persisted Pi session entries containing tool result details.
- Pi codemode scripts calling these tools through `ctx.executeTool()`.
- Private path-based adoption in `piagent-config`, whose lifecycle owner links
  this public initiative.

## Follow-up backlog

### Output archive safety

The current session log is complete but unbounded and relies on OS `/tmp`
cleanup. A separate initiative should decide and test:

- a configurable per-session archive cap with explicit unlimited opt-in;
- `log_status: complete | partial | unavailable`, bytes written, and bounded
  failure evidence;
- private (`0600`) exclusive creation with symlink/collision resistance and a
  documented trust boundary for `TMPDIR`;
- withholding the phrase “Full output” whenever archival degraded;
- prefix-scoped age/size cleanup; and
- quota, synchronous-open, asynchronous-write, close, and cleanup races.

Likely implementation location: a new `src/output-archive.ts` owned by
`ExecSession`.

### Renderer ticker ownership

The one-second elapsed/remaining ticker is cleared on a final result, but Pi's
component API has no universal disposal callback if an in-flight transcript is
dropped. Follow-up options are an extension-owned timer registry cleared on
`session_shutdown`, an upstream disposal contract, or accepting lower countdown
resolution without a dedicated ticker. Timers should at minimum be unreferenced
if this becomes observable as a host-liveness problem.

### Existing lifecycle work

Wake TTL/human disarm UX and Windows Job Object ownership remain in their
existing backlogs; they do not weaken this output contract.

## Non-goals

- No async full-log viewer in a tool row.
- No preservation of child ANSI styling in model/result/TUI text; the raw log
  is the recovery surface.
- No new model tool or output-size parameter.
- No change to process signaling, wake suppression, or kill escalation.
- No archive cap or deletion policy in 0.9.0.

## Retirement conditions

Before replacing this contract, prove the successor keeps model-visible output
bounded independently of rendering, keeps terminal state inert, preserves
complete/degraded recovery truthfully, honors Pi's configured expansion state,
and retains failed-process ownership. Remove this IV only after its tests and
consumers move with that replacement.
