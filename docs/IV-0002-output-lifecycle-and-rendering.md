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

1. **Capture:** real processes mirror their byte stream to a session log. omp
   Brush preserves its complete native UTF-8 text in one session artifact when
   available; otherwise it explicitly provides only a bounded inline projection.
2. **Model/session result:** output text is bounded and terminal-inert, with
   explicit omission and recovery information. Brush final results may also
   contain terminal images extracted by the host decoder.
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
8. **Tern terminal HUD (fork):** a tool result shows a tty screen only as it
   was when that call returned. On omp rendering natively in Tern, a counter
   pill copied from omp's running-work counter (terminal icon and bare count,
   words in its hover label) counts stored tty sessions on its own line above
   omp's counter. Its row, pill and segment use native `omp.hud`,
   `omp.hud.pill` and `omp.hud.seg` styling across Reader, Spine, Console and
   color themes. There is no outer hide button or dismiss state. Clicking the
   pill opens the Terminals sheet, built like omp's Agents sheet: the sessions
   listed with a status dot, the selected session's facts and newest output
   rows as the preview, Kill, Close and Open. Open shows the
   session as a full-pane terminal page built like omp's Console sheet: its
   retained history and current screen, colored, scrollable back and
   following new output without any tool call, with typed keys sent to the
   session
   ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17),
   [#19](https://github.com/mouriya-s-lab/omp-unified-exec/issues/19),
   [#21](https://github.com/mouriya-s-lab/omp-unified-exec/issues/21),
   [#23](https://github.com/mouriya-s-lab/omp-unified-exec/issues/23),
   [#25](https://github.com/mouriya-s-lab/omp-unified-exec/issues/25)).

## Requirements

- Never depend on a TUI renderer to enforce model/session size limits. Pi falls
  back to raw result content if a renderer throws.
- Apply Pi's `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` tail limits to
  `kill_session`, including model-visible recovery markers; independently cap
  metadata scans/headers that sit outside the output body.
- Keep the full retained stream out of result details; `details.output` is the
  canonical bounded body for exec, write, and kill.
- Strip ANSI/VT sequences and unsafe C0/C1 controls before text reaches model
  content, persisted details, partial updates, or custom renderers. Pipe text is
  stripped directly; tty bytes are interpreted by the session emulator before
  their rendered plain text leaves it. Brush graphics are extracted before its
  host sink sanitizes text. Real-process raw bytes stay only in their log;
  Brush's pre-projection native text stays only in its artifact. The styled
  Tern HUD projection is re-encoded from emulator cell attributes as SGR; no
  child control sequence reaches it. Legacy/fallback text is sanitized again.
- tty observations are consuming and serialized per session; a cancelled empty
  poll does not observe. Streaming snapshots and HUD screens never consume. The
  emulator is read only after every written chunk is parsed (HUD screens may lag
  unparsed output), and released after the session leaves ownership and its
  pending writes are parsed; the HUD reads only sessions still in the store.
- Represent operation and state explicitly (`operation`, `status`, `running`),
  rather than inferring liveness from the presence of `session_id`.
- Preserve failed-kill ownership: an unconfirmed kill remains registered and is
  reported as running.
- On Pi, give all five tools explicit call and result renderers and use
  `keyHint("app.tools.expand", ...)`, not a hard-coded Ctrl+O label. On omp,
  never register Pi-signature renderers: exec/write/kill provide omp render and
  describe hooks delegating to omp's bash renderer; set_on_exit and
  list_sessions use omp's bounded default card.
- On omp, mount the terminal HUD only while omp renders natively and the store
  holds a tty session, so the ANSI TUI gains no row. In Tern the pill takes a
  line of its own above omp's pill line. The stylesheet moves and resets the
  shared belowEditor container; any co-located widgets share its placement and
  loss of container padding/background/shadow. It does not restyle omp's
  activity, todo, meter or composer rows. With no widgets, the selected empty
  container must be zero-size and the dock match a plugin-free one.
  Only the open Terminals sheet and terminal page take focus and keys, as
  omp's Agents and Console sheets do.
  The page writes typed keys to its running session (Esc goes back instead),
  and Kill ends a session through `kill_session`'s path; nothing else reaches
  sessions, and the HUD keeps no copy of session or screen state.
- Count collapsed child output in visual lines after terminal wrapping.
- Keep truncation and log-recovery warnings visible while collapsed.
- Do not synchronously load an arbitrary log or artifact when expanded.
  Expanded mode shows the bounded result; `log_path` names complete-stream
  recovery only when capture succeeded.
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
| Keep complete process logs and available Brush artifacts | Archive quotas and retention are separate policies; bounded inline projections never imply bounded disk usage. |
| Bundle the native codemode display fix by default in 0.12.1 | Owner requested the fix here, not a separate package. It applies globally to nested tools while unified-exec is loaded; no Pi core patch or executor fork. |
| Register codemode at session start in 0.12.2 | Load-time registration made Pi skip `builtin:codemode` and warn every package user. Session-start registration is Pi's documented dynamic-tool pattern; load order keeps this definition first, the built-in stays as fallback, and precedence is checked at runtime. |
| Wrap the public factory via a receiver-bound API proxy | Keep native execution/schema/loadout/persistence and method receivers intact; intercept only tool registration and result rendering. |
| Keep native ordering and clip the rendered head at ten rows | Bound the whole result text component. Call summaries can consume the budget; reserve recovery/hint footer space. Script-call and separate image components are outside this cap. |
| Use a non-numeric clipping hint | Native rendering has already hidden output, so its rendered row count is not the full-output hidden-row count. |
| Present on omp through omp's exported bash renderer | omp's `toolRenderers.bash` (`@oh-my-pi/pi-tui/tools`) already owns collapse, expansion, exit/background status and both ANSI and Tern views; reimplementing them on omp's native view primitives would couple deeper. Only a pure display adapter is plugin code. omp is identified by its injected `ExtensionAPI.arktype`; on omp a missing or reshaped bash renderer fails plugin loading instead of silently re-registering Pi renderers. Pi activation stays synchronous and unchanged. |
| Show write/kill actions as bash comments | `# poll session N`, `# stdin → session N: "…"`, `# kill session N (SIGTERM)` name the action without presenting input bytes as an executable command; base64 input shows only its byte count. |
| Append the truncation marker to the omp display text | The marker and `log_path` live outside `details.output`; appending `truncationMarker()` keeps recovery visible as the last collapsed line without claiming the log is an omp artifact. |
| Distinguish process completion from Brush failure classification | Existing real-process nonzero exits retain their model semantics. Brush nonzero exits and timeouts are error results; timeout metadata reaches omp's warning presentation rather than ordinary failure red. |
| Render tty output through `@xterm/headless` | Proven identical under Node, Bun and a `bun build --compile` binary, with no DOM, assets or native code. Rejected: Codex's `TERM=dumb`/`NO_COLOR`/`PAGER=cat` mitigation (openai/codex `core/src/unified_exec/process_manager.rs:94-104`), which cannot stop programs that force redraws ([openai/codex#32325](https://github.com/openai/codex/issues/32325)). |
| tty result = unseen history + full current screen + cursor | A self-contained screen matches what a human sees and does not ask the model to splice earlier results. Rejected: a first-changed-row delta, which leaves full-screen redraws without context. Lines scrolled off since the last observation that equal the previous screen's rows at the same position were already reported and are skipped; an unchanged screen reports `screen_changed: false`. Results represent only plain text and the cursor (owner's choice); styling stays in the log and, on Tern, in the HUD. |
| Align history with an xterm marker on the observed screen's top row | Each observation registers a marker at the screen's top row; the next observation's history starts there, so positional comparison with the previous screen is exact. The marker follows the row as it scrolls and is disposed when the row is trimmed from the history, so the emulator keeps its history for the HUD. Rejected: erasing the emulator's scrollback (ED3) after each observation, which left the HUD screen nothing to scroll back through; counting scroll events into absolute line numbers, which leaving the alternate screen, DECSTBM regions, ED3 and RIS all break. |
| Bound tty history by cells, not lines | History rows = 240000 cells / `cols`, at least one screen. `history_may_be_truncated` is reported when the marked row was evicted while the history sits at that cap (on the first observation, whenever it sits at the cap); a child's ED3 or RIS also drops the marker but erased those rows itself. |
| HUD logic inside the omp extension; a CSS-only Tern plugin places the pill and sets the preview's output in the mono face | The sessions and their emulators live in this process; a dock widget reads them directly. A Luau plugin block would need the screen pushed to it across processes (a second copy of state) and shows as a pane, not a floating panel (owner's choice, [#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The fork's Tern plugin (`fork-features/tern-plugin/`) only injects CSS (owner's choice): a stylesheet listed in its manifest `styles`, which Tern loads with the plugin; the window entry Tern requires of every plugin is empty. |
| Synchronize a normal Tern copy in the awaited omp factory | `omp plugin install URL --force` must update the bundled Tern plugin before success, not ask the operator to unlink/install or wait for a session. omp materializes the package then awaits extension factories during validation. `withHostPresentation` therefore awaits `initializeTernPlugin` before activation, both during installation and ordinary loading. The installed package owns source assets; Tern's CLI owns its directory, registration and reload. `plugin dir --json` and `list --json`, together with the exact regular three-file normal copy, determine whether work is needed. Missing/stale files use `plugin install DIR --force --json`; an exact ready copy is untouched. Only Tern's precise linked-target collision, a matching canonical regular `.path` file and a fresh catalog identifying this plugin allow official unlink followed by copy installation. Other failures never remove a registration. No developer link, session-start installation IO, toast, argv parsing, host patch, trust change or lifecycle script is used. Missing Tern skips this integration; an available but failing Tern rejects package validation and ordinary loading with bounded sanitized command diagnostics. Each CLI operation has a 75-second timeout for the documented 60-second reload wait. Offline Tern installs for next start. omp's package rollback does not roll back an already completed external Tern update. |
| Pill = omp's native running-work counter | The widget describes an `omp.hud` root row with `justify: "end"`, holding `omp.hud.pill` with one `omp.hud.seg`: a terminal icon and the bare stored tty count, words in its hover/aria label, and `unified-exec.terminals.open` as its click action (Tern handles built-in action names itself). The row has no plugin gap or alignment override, so Tern's native rules own its wrapping, spacing, column alignment and chat-style changes. The outer ✕ and complete dismiss lifecycle are removed; OPEN remains the only pill action. Naturally exited tty sessions still count while stored; pipes do not. `belowEditor` avoids the leading spacer of `aboveEditor`. |
| Shared widget container above omp's pill line; native roles own appearance | An extension cannot add a segment to `HudPillsRow`, whose counter describes only agents and jobs. `html .sf-region.sf-dock > .sf-col.gap-none:last-child` selects the shared belowEditor container and retains `order: -1`, then sets only `margin: 0`, `padding: 0`, `background: none`, `box-shadow: none`. Native `omp.hud` rules match nested rows and supply general spacing, Reader's centered column, Spine's side margins/timeline inset and Console's gutter; do not copy them into plugin CSS or override pill/segment colors, fonts, dimensions, borders, radius, hover or animation. Resetting the container removes the proven Spine plate and double padding; the prefix wins over Spine's unfocused rule. Other belowEditor widgets share the move/reset. With no widgets the selector still matches a zero-size void, never the editor. No `:has()` or DOM manipulation: the current control selector parser rejects `:has()`. No theme listener, cache, reload flag or per-theme CSS is needed. |
| Sheet = a `picker` like omp's Agents sheet | omp's Agents sheet is a `picker` (title with icon and subtitle, `lg`, rows with status dots and fact columns, the selected item as a side preview, an action bar Kill `x` … Close `esc`, Open transcript `enter`) that its component mounts as the modal sheet by answering `nativeSheet` (omp `packages/tui/src/native/backend.ts`); measured in Tern, its Kill ends the agent without confirmation and Enter replaces the sheet with a full-pane transcript page. The Terminals sheet is an extension custom overlay (`ctx.ui.custom(..., { overlay: true })`) whose component does the same: title Terminals with a `running · stored` subtitle, one row per session (command in mono, `#id · state`, dot accent while running, success after exit 0, error otherwise) with Size, PID and Time columns (elapsed while running, as the Agents roster's Time), and Kill (`x`, only while running), Close (`esc`) and Open (`enter`, also a row's `activate`). The preview follows the Agents preview (omp `agent-hub.ts` `#describePreview`): a title row with the command and a state badge, a `kv` facts grid (Session, Directory with the home directory as `~`, PID, Size, Started), the log path on its own line cut at its start so the file name stays, linked to the file, and a Recent output section. Picker `select` events and ↑/↓ pick the session. Kill runs `terminateSessionById` (SIGTERM, then SIGKILL after 2s), the path `kill_session` and `/unified-exec-sessions` use, handed to the HUD as `ActivatedExtension.kill`; a confirmed exit removes the session from the store, so its row leaves the list. Rejected: a non-modal `overlay` node with tabs, which matched no omp sheet (owner's choice); the below-list preview, whose fixed short region left the list area empty; the log path in the facts grid, where its value column wrapped it over several lines. |
| Terminal page = a `full` sheet like omp's Console | omp's own terminal window is the Console sheet its bash tool opens with `pty: true`: `ui.custom` with `nativeOverlay { size: "full" }`, the PTY screen as `ansi`, keys forwarded to the process, and an action bar. Open closes the Terminals sheet and opens the page the same way (role `unified-exec.overlay.terminal`, head `Terminals · #id command state`); its body is a column filling the sheet (`min.h` 1) holding the session's history and screen as `ansi` at the session's own width, which grows into the height the action bar leaves (`grow` 1, `max.h` 1, a fraction of the available height) and follows the newest row, and the action bar with Kill (while running) and Back (`esc`) pinned at the bottom. Back, Esc and Tern's `close` reopen the Terminals sheet on the same session; at most one of the two is open. Typed keys go to the running session through `ExecSession.write`, as `write_stdin` writes, so the model's next observation sees their effect (owner's choice); Esc is kept for Back. The PTY keeps the size the model's session started with. Rejected: showing a session only in the sheet's side preview, which wrapped wide screens into a narrow column; a `max.h` in rows computed from the pane's rows less the sheet's chrome, which left the action bar floating above empty space. |
| Page screen = `ansi`; preview output = plain `code` in the mono face | `ansi` keeps the colors and follows the newest row. Its text is the session's retained history plus the current screen (the alternate screen has no history), so its scrollbar scrolls back through the terminal's history. In the side preview Tern draws `ansi` as a mini terminal that reflows rows at the column's width, which shredded a 120-column `top` into fragments, so the preview shows only the newest 12 non-blank rows as a plain-text `code` block (`lang: "text"`, `wrap: false`, as omp sends its QR code), whose rows keep their spacing and scroll sideways. Tern draws a preview's `code` lines and `mono` spans in the UI face; the plugin's stylesheet sets the block (role `unified-exec.terminals.tail`) in the mono face and the facts' size, so columns align. Rejected: one `mono` text row per screen row, which Tern drew in the UI face with collapsed spacing and wide line gaps; restyling a truncated text's font, whose truncation Tern measures in the original face. |
| HUD colors from cell attributes | `TerminalScreen.styledScreen()` writes SGR for palette/256/RGB colors and bold, dim, italic, underline, blink, inverse, invisible, strikethrough and overline. Child OSC, cursor and mode sequences cannot pass, because nothing is copied from the byte stream. |
| Answer OSC 10/11 with the host's appearance | xterm answers DSR and DA1 itself but not the default-colour queries, so a child that picks its palette from them (omp probes OSC 11 with a DA1 sentinel) got no answer and fell back to dark, drawing dark blocks on a light Tern page. The emulator answers `?` queries inside the parse, before a following DA1, with white on black for a dark host and black on white for a light one. On omp the appearance is read at each query from omp's theme (`isLightTheme(getCurrentThemeName())` from `@oh-my-pi/pi-tui/theme`, loaded with the other omp modules so a reshaped omp fails plugin loading); Pi has no such signal and answers dark, as omp's Console responder does. Colour sets (`OSC 11;rgb:…`) are ignored. |
| Mount only while native and a tty session exists | omp's `isNativeRendering`/`onNativeRenderingChange` (`@oh-my-pi/pi-tui/native/state`) gate the widget, so the ANSI TUI never gets the widget container's spacer row. Store membership and native changes re-evaluate the gate; a missing module fails omp plugin loading before anything registers, like the bash renderer. |
| Watch screens only while the sheet or page is open | The pill re-describes on store membership only; the open sheet or page watches every listed session's exit (its dot or state) and only the shown session's parsed-output notifications, and each re-description reads the current screens, so a closed HUD costs nothing per chunk. |

## Brush output ownership

This contract applies only to omp Brush. PipeProcess and PtyProcess retain their
existing logs, terminal observations, limits and recovery behavior. The output
contract is tracked in [issue 35](https://github.com/oh-my-omp/omp-unified-exec/issues/35).

The native bridge delivers Unicode strings, not arbitrary subprocess bytes.
An original Brush transcript means the exact UTF-8 encoding of those strings,
before graphics extraction, control stripping, carriage-return normalization,
column limits, minimization or truncation. Invalid UTF-8 lost before that native
boundary cannot be recovered by this plugin.

The execution captures its actual caller's artifact allocator. After successful
environment preparation and before native launch, that allocator reserves one
path and id. Small and zero-output commands also create their session artifact.
Brush never creates an `os.tmpdir()` process log or a second `bash-original`
artifact. The artifact has no disk cap because it promises the complete native
transcript; the host's bounded sink is a derived inline view, not another archive.

```mermaid
stateDiagram-v2
    [*] --> Preparing
    Preparing --> Writing: Caller allocates and opens artifact
    Preparing --> InlineOnly: Artifact unavailable
    Writing --> ArtifactBacked: Native stream ends and close succeeds
    Writing --> InlineOnly: Artifact open, write or close fails
    Writing --> Cancelled: Execution is terminated
    Preparing --> Cancelled: Preparation is terminated
    InlineOnly --> Cancelled: Execution is terminated
    ArtifactBacked --> Final: One bounded final projection
    InlineOnly --> Final: Unminimized bounded projection and capture notice
    Cancelled --> [*]: Close resources without a deliverable final result
    Final --> [*]
```

Every accepted native chunk reaches the transcript before the decoder and sink.
Artifact writes preserve order and backpressure the existing bounded native
bridge; the plugin does not enqueue a second unbounded stream. One decoder
spans chunk boundaries and finishes before output closure. The sink's sanitized
incremental chunks feed the existing consuming observation buffer. Polling
never reads the sink's cumulative preview or modifies the artifact.

Only successful transcript closure permits native minimizer text to replace the
inline view. The replacement references the same original artifact, not the
native minimizer's separate original-text copy. Decoded images accompany the
one final result and its HostJob final progress report. Polls remain incremental
text and never replay that final body or its images.

Inline-only output never claims recovery or applies a lossy minimizer replacement.
An unavailable artifact produces an explicit unsaved-output notice without
failing the command. Failed artifact I/O uses the host's
`formatArtifactErrorNotice`; it stops further writes, but observation, decoding
and command execution continue. The command's exit/deadline still determines
error classification. The plugin closes but does not unlink a partial allocation
and never advertises its URL as complete. The host has no abandon/incomplete
state or automatic cleanup guarantee; directory scans or a caller holding its
id may still find that unadvertised partial file. A cancelled run likewise has no
deliverable final result or complete-archive link.

Output closure precedes final construction. The final body uses the host sink's
head/tail selection, not the old process tail-only envelope. The complete text
envelope, including headers, is capped against the configured host spill budget.
Brush kill results use that cap too; the old process body cap alone cannot stop
the outer extension wrapper from archiving a reduced kill tail.

HostJobs have a second host delivery boundary:
`ASYNC_INLINE_RESULT_MAX_CHARS`. The plugin imports that limit and conservatively
uses the lesser of its character limit and the configured byte budget for the
one HostJob final, whether returned in the foreground or delivered later.
The complete envelope cannot exceed the shared character threshold. This is an
intentional smaller HostJob inline budget: it prevents the host from saving an
already-reduced result as another “Full output” artifact. The plugin does not
invent truncation/column metadata or artifact errors just to carry an archive id.
Coordinator output keeps the configured budget.

Late chunks after the execution's output-close anchor are ignored, as in the
host executor; retained ordinary `&` jobs do not reopen the finished archive.

The final result is independent of the observation cursor and is built once.
Foreground completion and HostJob follow-up use that result; terminal polling
uses only new cursor content plus classification and a successful archive link.
Compiled omp 18.11.1 qualification on macOS arm64 recovered the 1,288,895-byte
sequence transcript exactly through its session artifact, returned foreground
and background PNG content, and distinguished timeout warning from exit-3 error
on the actual ANSI surface. A real first-write EBADF left one zero-byte partial
allocation, returned unminimized output and the host capture notice once, and
advertised no recovery link. Fresh 1 KiB/50 KiB runs preserved giant-line suffixes
and concurrent observation ownership without creating a second preview artifact.
These observations qualify the native UTF-8 boundary above, not arbitrary bytes,
Windows output behavior or native Tern background-card retention.

## Implementation map

| Area | Location |
|---|---|
| Terminal-control scanner | `src/output-safety.ts` |
| tty terminal emulator, observations, snapshots, styled screens, parse notifications | `src/terminal-screen.ts`, owned by `ExecSession` (`src/session.ts`); released by `src/session-store.ts`; tests `tests/terminal-screen.test.ts` |
| Session membership notifications | `SessionStore.subscribe` in `src/session-store.ts` |
| Shared output envelope, truncation, process/kill text | `src/tool-result.ts` |
| Brush native transcript, bounded host sink, graphics and output authority | `fork-features/brush/output.ts`, `output-host.ts`; lifecycle in `src/session.ts` |
| Brush one-time final projection and complete-envelope cap | `fork-features/brush/result.ts`; foreground and HostJob delivery in `src/index.ts` |
| Codemode script schemas and projections | `src/script-result.ts`, `tests/script-result.test.ts` |
| Kill collection, partial sanitization, and tool registration | `src/index.ts` (`TerminateOutcome`, `buildStreamUpdate`, `kill_session`) |
| Explicit Pi renderers and shared five-line preview | `src/render.ts` |
| omp host selection, bash-renderer delegation, result/args display adapters | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`; wired by `withHostPresentation` in `src/index.ts`; tests `tests/omp-presentation.test.ts` |
| Tern terminal HUD: native counter pill, Terminals picker sheet, terminal page, tty/native mount gate | `fork-features/tern-terminal-hud.ts`, mounted by `withHostPresentation` with the store and kill `activate` returns; tests `tests/tern-terminal-hud.test.ts` |
| Tern plugin placing the pill above omp's pill line and setting the sheet preview's output rows in the mono face | `fork-features/tern-plugin/` (`plugin.toml`, `terminals.css`, empty `window.luau`), shipped in the package; `initializeTernPlugin` in `fork-features/tern-plugin-install.ts` awaited by `withHostPresentation` during omp factory initialization; state tests `tests/tern-plugin-install.test.ts`, real omp install-boundary regression `tests/tern-install-cli.test.ts` |
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

Tern theme qualification starts from a real window, not `tern serve` (which
does not load plugins), with isolated state and screenshots under
`/tmp/tern-pill-theme-check/`. Preserve the operator's fonts and dimensions;
use the existing OS account and omp credential paths, never fixture secrets.
Tern 0.8.3 requires `-e` as its first argument; a controlled window may instead
start a shell and run the checkout explicitly in its dedicated test pane:

```bash
tern --control /tmp/tern-pill-theme-check/control.sock
# In that isolated pane:
omp --no-extensions -e /ABSOLUTE/CHECKOUT/src/index.ts --no-session --no-title
```

Set `TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET` to the isolated config and
daemon socket when addressing that daemon from outside its pane. The window
control socket is separate. Factory initialization must complete before the
extension activates: confirm the exact normal three-file copy and Tern's ready
catalog match the checkout, with no `.path` registration. Package-update
qualification uses normal `omp plugin install URL --force`, not `-e`, and
checks that copy immediately after the command returns, before any session.

Use the real omp input to start tty `cat` and `sleep 600` with
`yield_time_ms: 1000`, plus a read-only background agent. The terminal count
must be 2 while the native agent counter is visible. Before editing, capture
the same theme/style combination, rectangles and screenshot. After editing,
repeat the full entry path; switch Reader, Spine and Console and a light/dark
theme without replacing those tty sessions. At 1280×800 and 700px width,
compare row/pill right edges (within 1px), font, height, radius, border and
hover against the agent counter in the same pane. Check Spine focus/unfocus,
no outer ✕ or empty button, no double inset/plate/spacing, and no Console
full-width mismatch. `tern ctl dump` reports runtime rectangles and fonts;
identify the two rows by their terminal/users icon descendants.

Click the terminal counter; Close and Esc must leave both processes alive.
Kill sleep from the list: only its confirmed exit removes its row and changes
2 to 1. Open cat, type `hello-from-tern` and Enter, observe the actual echo,
then Kill from its page: await exit/removal, the list empties and the counter
unmounts. Starting another tty must immediately show 1. With no tty or other
widget, compare composer/meter/activity/todo rectangles against a plugin-free
baseline in every style; the selected empty container must occupy no height.
List `x` remains Kill and is also covered by the real-session automated tests.

OSC 10/11 qualification, 2026-10-12, macOS arm64 / omp 18.10.1, isolated real
window: an omp started in a tty session and opened on the terminal page drew
omp's light palette on the light page (it had drawn black message and
thinking blocks before the emulator answered OSC 11).

Install-boundary qualification, 2026-10-13, macOS arm64 / omp 18.10.3 compiled
binary and Tern 0.8.3: the full production package was installed from an
isolated loopback-Git source with only `omp plugin install URL --force --json`
as the behavior trigger. Before any interactive session, missing files became
an exact normal three-file copy; stale CSS and window-script bytes were
replaced without a version change; and a canonical regular legacy `.path`
registration migrated even though its catalog version/CSS were already
identical. Every successful case reported the exact ready catalog and no
remaining `.path`. Repeating force installation preserved the copy's bytes,
inodes and timestamps as well as the directory identity.

A real Tern linked-target conflict backed by a noncanonical symlink
registration made factory validation fail and the CLI exit 1, with
`nothing was unlinked`. The previous managed dependency, package source,
Bun lock and omp plugin lock bytes were restored; package inode preservation
is not claimed. The unknown registration's inode and target content stayed
unchanged. A separate PATH without Tern installed and enabled the new Git
candidate successfully without creating a Tern copy. All six cases used
isolated HOME, cache, temporary files and Tern configuration, with no daemon
running and no credential copies. Commands, owner replies, byte hashes,
before/after state and results are under
`/tmp/tern-auto-install-check/acceptance/` (`matrix-summary.json`).

Before-change reproduction, 2026-10-13, macOS arm64, Tern 0.8.3 / omp 18.10.3,
operator fonts at 12px, light-dawn, 1280×800: the checkout extension started
cat (#1), sleep (#2) and a background agent in the isolated real window.
Console's native agent pill ended at x1259 while the terminal pill ended at
x1233.69; the outer ✕ occupied the remaining space. After switching through
the real Chat style control, Spine's shared widget container had a
44.31px height and `rgba(255, 255, 255, 0.55)` background, and pill right edges
were x1027.69 (agent) and x1002.64 (terminal). The pre-change window screenshot
is `/tmp/tern-pill-theme-check/before-spine.png`. This establishes the original
layout defect, not post-change qualification.

Post-change theme qualification, same environment: a fresh omp process loaded
the modified checkout, started cat (#1, PID 1910), sleep (#2, PID 1912) and a
native background agent (PID 2050). The same two tty sessions stayed stored
while the real settings UI selected Reader, Spine and Console at 1280×800 and
700×800, with light-dawn and titanium selected from the available picker.
All 12 focused combinations had identical native/terminal row and pill right
edges, fonts and pill heights; the terminal row remained above the agent row
and the count stayed 2. Four additional Spine combinations used a real
split-down shell to take focus: the tested surface had `sf-unfocused`, kept
its width and transparent container, and still matched both right edges.
The split changed pane height, which the geometry records include.

The real hover comparisons in all six style/theme combinations also matched:
light segments used `rgba(45, 52, 64, 0.06)` and dark segments used
`rgba(232, 236, 244, 0.06)`. Same-pane screenshots show matching border/radius
appearance, no outer ✕ or empty button and no Spine plate; the native dump
does not expose numeric border/radius values. Close and Esc retained the
two terminal counters and the live native agent. Geometry, accessibility,
hover observations and screenshots are under `/tmp/tern-pill-theme-check/`
(`matrix-*.json/png`, `matrix-summary.json`, `hover-matrix.json`,
`after-close-escape.json`).

The same real interaction path killed sleep from the list (only cat remained,
count 1), opened cat and showed `hello-from-tern` twice (terminal echo and
cat output), then killed cat from its page. The empty sheet reported
`0 running · 0 stored`; its counter unmounted and the selected widget
container was an invisible `sf-void` at `[0, 0, 0, 0]`. A new tty (#5) mounted
count 1 immediately and was killed through the list afterward. The captured
sequence is in `list-kill-sleep.json`, `cat-echo.png`, `page-kill-cat.json`,
`empty-list-unmounted.json` and `new-tty-remount.json` in that directory.

No-tty geometry qualification used a fresh checkout omp with a per-run
`--config=/tmp/tern-pill-theme-check/todo-startup.yml` overlay containing
`todo: { enabled: true }`, so real working and native todo HUD rows were
visible during a pipe wait. Across eight same-process
linked/plugin-free pairs (three styles at both widths, plus Spine unfocused
at both widths), actual `tern plugin unlink` / `link` changed only the
isolated daemon's stylesheet. The dock, working, todo, Message and context
meter rectangles were identical, as were all visible descendant backgrounds.
The selector always matched the invisible zero-size `sf-void`, never the
editor. Its computed Spine background changed, but with no paint area.
Evidence: `final-baseline-summary.json`, `final-plugin-*.json/png`,
`final-pluginfree-*.json/png` and `plugin-lifecycle-comparison.json`.

Automated qualification after the install-boundary change: `npm test`
passed strict types and 492 tests, with zero failures and five individual
skips (two Windows-only, two opt-in PTY cases and the opt-in omp install
gate); the unavailable Node PTY backend also excluded its real-session
suites. The mandatory real omp install gate passed 1/1 with no skips.
`EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts
./tests/omp-presentation.test.ts` passed all 54 with no skips, including
list Kill/x, terminal-page echo and Kill, native resume and last-tty removal.

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

Real omp installation gate (POSIX host, `git` and an installed omp required):

```bash
EXPECT_TERN_INSTALL_CLI=1 OMP_TEST_BINARY=/ABSOLUTE/PATH/TO/omp \
  npx tsx --test tests/tern-install-cli.test.ts
```

Without `OMP_TEST_BINARY`, the test resolves `omp` on PATH. The isolated
loopback-Git fixture ships the actual production initializer and bundled
assets; only Tern's CLI is substituted with a stateful copy installer.
It checks completion before any session, same-version asset updates,
unchanged current-copy identity and package/lock rollback on owner failure.
This host-contract regression complements, not replaces, real Tern/UI
qualification.

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
- Humans glancing at live tty screens in the Tern terminal HUD on omp.
- Persisted Pi session entries containing tool result details.
- Pi codemode scripts calling these tools through `ctx.executeTool()`.
- Private path-based adoption in `piagent-config`, whose lifecycle owner links
  this public initiative.

## Follow-up backlog

### Output archive safety

Process logs and available Brush transcripts are complete but unbounded. Process
logs rely on OS temporary-directory cleanup; Brush artifacts follow the host
session's artifact lifecycle. A separate initiative should decide and test:

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
- No child ANSI styling in text model/results or Pi/omp tool rows. Logs and
  successful Brush artifacts are recovery surfaces; Brush may return extracted
  terminal images. The Tern HUD re-encodes colors from the emulator.
- No input from the Tern HUD to sessions beyond the terminal page's typed keys
  and Kill; neither is model-visible except through the session's own output
  and exit.
- No new model tool or output-size parameter.
- No change to process signaling, wake suppression, or kill escalation.
- No archive cap or deletion policy in 0.9.0.

## Retirement conditions

Before replacing this contract, prove the successor keeps model-visible output
bounded independently of rendering, keeps terminal state inert, preserves
complete/degraded recovery truthfully, honors Pi's configured expansion state,
and retains failed-process ownership. Remove this IV only after its tests and
consumers move with that replacement.
