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
8. **Tern terminal HUD (fork):** a tool result shows a tty screen only as it
   was when that call returned. On omp rendering natively in Tern, a counter
   pill copied from omp's running-work counter (a terminal icon and the bare
   count, the words in its hover label), on its own line just above omp's
   counter, counts the stored tty sessions; its ✕ hides the HUD until a new
   tty session starts. Clicking the pill opens the Terminals sheet, built like
   omp's Agents sheet: the sessions listed with a status dot, the selected
   session's facts and newest output rows as the preview, Kill, Close and
   Open. Open shows the
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
- Strip ANSI/VT sequences and unsafe C0/C1 controls before child text reaches
  model content, persisted details, partial updates, or custom renderers. Pipe
  text is stripped directly; tty bytes are first interpreted by the session's
  terminal emulator and only its rendered plain text (sanitized again) leaves
  it. Keep exact raw bytes only in the session log and sanitize again while
  rendering legacy/fallback details. The one styled projection, the Tern HUD
  screen, is re-encoded from the emulator's cell attributes as SGR only; no
  child byte reaches it.
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
  line of its own above omp's pill line, and omp's activity line, todo HUD,
  meter and composer keep the geometry omp gives them; with the HUD hidden
  the dock matches a plugin-free one. Only the open Terminals sheet and
  terminal page take focus and keys, as omp's Agents and Console sheets do.
  The page writes typed keys to its running session (Esc goes back instead),
  and Kill ends a session through `kill_session`'s path; nothing else reaches
  sessions, and the HUD keeps no copy of session or screen state.
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
| tty result = unseen history + full current screen + cursor | A self-contained screen matches what a human sees and does not ask the model to splice earlier results. Rejected: a first-changed-row delta, which leaves full-screen redraws without context. Lines scrolled off since the last observation that equal the previous screen's rows at the same position were already reported and are skipped; an unchanged screen reports `screen_changed: false`. Results represent only plain text and the cursor (owner's choice); styling stays in the log and, on Tern, in the HUD. |
| Align history with an xterm marker on the observed screen's top row | Each observation registers a marker at the screen's top row; the next observation's history starts there, so positional comparison with the previous screen is exact. The marker follows the row as it scrolls and is disposed when the row is trimmed from the history, so the emulator keeps its history for the HUD. Rejected: erasing the emulator's scrollback (ED3) after each observation, which left the HUD screen nothing to scroll back through; counting scroll events into absolute line numbers, which leaving the alternate screen, DECSTBM regions, ED3 and RIS all break. |
| Bound tty history by cells, not lines | History rows = 240000 cells / `cols`, at least one screen. `history_may_be_truncated` is reported when the marked row was evicted while the history sits at that cap (on the first observation, whenever it sits at the cap); a child's ED3 or RIS also drops the marker but erased those rows itself. |
| HUD logic inside the omp extension; a CSS-only Tern plugin places the pill and sets the preview's output in the mono face | The sessions and their emulators live in this process; a dock widget reads them directly. A Luau plugin block would need the screen pushed to it across processes (a second copy of state) and shows as a pane, not a floating panel (owner's choice, [#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The fork's Tern plugin (`fork-features/tern-plugin/`) only injects CSS (owner's choice): a stylesheet listed in its manifest `styles`, which Tern loads with the plugin; the window entry Tern requires of every plugin is empty. |
| omp installs the Tern plugin itself | A plugin the owner must link by hand is missed on new machines and after updates (owner's choice: install automatically). On omp, at the first interactive session start, the extension checks it runs in a Tern pane as omp itself does (`TERN_PANE_SOCKET` set and `TERN_PANE` a block id, omp's `resolveTernPane`) and asks that Tern through the `tern` CLI on PATH, which inherits omp's environment and so addresses the same daemon and plugin directory. Tern's daemon is the authority: `tern plugin list --json` tells whether it runs the package's plugin with the same version and stylesheet; only when it does not, `tern plugin link <package>/fork-features/tern-plugin` links the package's directory in place (so later package updates are picked up by the next relink), and an installed copy that blocks the link is removed first. An install or update is reported as an omp status toast, a failure as a warning naming the manual command; when Tern already runs the files nothing is shown or changed. Rejected: copying with `tern plugin install`, which would need a reinstall on every package update; writing Tern's plugin directory directly, which bypasses the daemon's reload. |
| Pill = omp's running-work counter, copied, plus its ✕ | omp 18.10 replaced its agents/jobs pills with one counter (`omp.hud.pill` holding `omp.hud.seg` segments: a tinted icon and the bare count, the words only in the hover label). The widget's root is a row with role `unified-exec.terminals` and `justify: "end"`, as omp describes `omp.hud`, holding the same structure with one `terminal` segment whose click sends `unified-exec.terminals.open` (Tern handles its built-in action names itself and never sends them), and an `omp.btn` ✕ that sends `unified-exec.terminals.dismiss`: it unmounts the widget and records the highest stored tty id, and the widget mounts again only when a session with a higher id is stored. `belowEditor` because an `aboveEditor` widget gets omp's leading spacer row; omp renders the `belowEditor` container as the dock's last child, which is what the stylesheet selects. |
| Pill above omp's pill line through the stylesheet | An extension cannot add a segment to omp's `HudPillsRow` (`describeHudPills` builds only the agents and jobs segments), and an extension overlay cannot attach to the dock. For the pill the stylesheet only moves the widget's container to the front of the dock (`order: -1`); Tern's Reader style already lays its row on omp's 720px line (`.sf-chat-reader.sf-dock > .sf-col:not([data-role]) > *`: centred, `calc(100% - 32px)` wide, at most 720px), so it ends exactly where omp's counter ends at every width. Rejected: wrapping the dock so our pill shares omp's pill line, which during a running turn pulled omp's activity row up onto that line (Tern's own flex rule on the activity row wins), and Tern's style engine has no `:has()`, `:not()` or `~` to restyle omp's rows only while the HUD is shown. |
| Sheet = a `picker` like omp's Agents sheet | omp's Agents sheet is a `picker` (title with icon and subtitle, `lg`, rows with status dots and fact columns, the selected item as a side preview, an action bar Kill `x` … Close `esc`, Open transcript `enter`) that its component mounts as the modal sheet by answering `nativeSheet` (omp `packages/tui/src/native/backend.ts`); measured in Tern, its Kill ends the agent without confirmation and Enter replaces the sheet with a full-pane transcript page. The Terminals sheet is an extension custom overlay (`ctx.ui.custom(..., { overlay: true })`) whose component does the same: title Terminals with a `running · stored` subtitle, one row per session (command in mono, `#id · state`, dot accent while running, success after exit 0, error otherwise) with Size, PID and Time columns (elapsed while running, as the Agents roster's Time), and Kill (`x`, only while running), Close (`esc`) and Open (`enter`, also a row's `activate`). The preview follows the Agents preview (omp `agent-hub.ts` `#describePreview`): a title row with the command and a state badge, a `kv` facts grid (Session, Directory with the home directory as `~`, PID, Size, Started), the log path on its own line cut at its start so the file name stays, linked to the file, and a Recent output section. Picker `select` events and ↑/↓ pick the session. Kill runs `terminateSessionById` (SIGTERM, then SIGKILL after 2s), the path `kill_session` and `/unified-exec-sessions` use, handed to the HUD as `ActivatedExtension.kill`; a confirmed exit removes the session from the store, so its row leaves the list. Rejected: a non-modal `overlay` node with tabs, which matched no omp sheet (owner's choice); the below-list preview, whose fixed short region left the list area empty; the log path in the facts grid, where its value column wrapped it over several lines. |
| Terminal page = a `full` sheet like omp's Console | omp's own terminal window is the Console sheet its bash tool opens with `pty: true`: `ui.custom` with `nativeOverlay { size: "full" }`, the PTY screen as `ansi`, keys forwarded to the process, and an action bar. Open closes the Terminals sheet and opens the page the same way (role `unified-exec.overlay.terminal`, head `Terminals · #id command state`); its body is a column filling the sheet (`min.h` 1) holding the session's history and screen as `ansi` at the session's own width, which grows into the height the action bar leaves (`grow` 1, `max.h` 1, a fraction of the available height) and follows the newest row, and the action bar with Kill (while running) and Back (`esc`) pinned at the bottom. Back, Esc and Tern's `close` reopen the Terminals sheet on the same session; at most one of the two is open. Typed keys go to the running session through `ExecSession.write`, as `write_stdin` writes, so the model's next observation sees their effect (owner's choice); Esc is kept for Back. The PTY keeps the size the model's session started with. Rejected: showing a session only in the sheet's side preview, which wrapped wide screens into a narrow column; a `max.h` in rows computed from the pane's rows less the sheet's chrome, which left the action bar floating above empty space. |
| Page screen = `ansi`; preview output = plain `code` in the mono face | `ansi` keeps the colors and follows the newest row. Its text is the session's retained history plus the current screen (the alternate screen has no history), so its scrollbar scrolls back through the terminal's history. In the side preview Tern draws `ansi` as a mini terminal that reflows rows at the column's width, which shredded a 120-column `top` into fragments, so the preview shows only the newest 12 non-blank rows as a plain-text `code` block (`lang: "text"`, `wrap: false`, as omp sends its QR code), whose rows keep their spacing and scroll sideways. Tern draws a preview's `code` lines and `mono` spans in the UI face; the plugin's stylesheet sets the block (role `unified-exec.terminals.tail`) in the mono face and the facts' size, so columns align. Rejected: one `mono` text row per screen row, which Tern drew in the UI face with collapsed spacing and wide line gaps; restyling a truncated text's font, whose truncation Tern measures in the original face. |
| HUD colors from cell attributes | `TerminalScreen.styledScreen()` writes SGR for palette/256/RGB colors and bold, dim, italic, underline, blink, inverse, invisible, strikethrough and overline. Child OSC, cursor and mode sequences cannot pass, because nothing is copied from the byte stream. |
| Answer OSC 10/11 with the host's appearance | xterm answers DSR and DA1 itself but not the default-colour queries, so a child that picks its palette from them (omp probes OSC 11 with a DA1 sentinel) got no answer and fell back to dark, drawing dark blocks on a light Tern page. The emulator answers `?` queries inside the parse, before a following DA1, with white on black for a dark host and black on white for a light one. On omp the appearance is read at each query from omp's theme (`isLightTheme(getCurrentThemeName())` from `@oh-my-pi/pi-tui/theme`, loaded with the other omp modules so a reshaped omp fails plugin loading); Pi has no such signal and answers dark, as omp's Console responder does. Colour sets (`OSC 11;rgb:…`) are ignored. |
| Mount only while native and a tty session exists | omp's `isNativeRendering`/`onNativeRenderingChange` (`@oh-my-pi/pi-tui/native/state`) gate the widget, so the ANSI TUI never gets the widget container's spacer row. Store membership and native changes re-evaluate the gate; a missing module fails omp plugin loading before anything registers, like the bash renderer. |
| Watch screens only while the sheet or page is open | The pill re-describes on store membership only; the open sheet or page watches every listed session's exit (its dot or state) and only the shown session's parsed-output notifications, and each re-description reads the current screens, so a closed HUD costs nothing per chunk. |

## Implementation map

| Area | Location |
|---|---|
| Terminal-control scanner | `src/output-safety.ts` |
| tty terminal emulator, observations, snapshots, styled screens, parse notifications | `src/terminal-screen.ts`, owned by `ExecSession` (`src/session.ts`); released by `src/session-store.ts`; tests `tests/terminal-screen.test.ts` |
| Session membership notifications | `SessionStore.subscribe` in `src/session-store.ts` |
| Shared output envelope, truncation, process/kill text | `src/tool-result.ts` |
| Codemode script schemas and projections | `src/script-result.ts`, `tests/script-result.test.ts` |
| Kill collection, partial sanitization, and tool registration | `src/index.ts` (`TerminateOutcome`, `buildStreamUpdate`, `kill_session`) |
| Explicit Pi renderers and shared five-line preview | `src/render.ts` |
| omp host selection, bash-renderer delegation, result/args display adapters | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`; wired by `withHostPresentation` in `src/index.ts`; tests `tests/omp-presentation.test.ts` |
| Tern terminal HUD: counter pill and ✕, Terminals picker sheet, terminal page, mount gate | `fork-features/tern-terminal-hud.ts`, mounted by `withHostPresentation` with the store and kill `activate` returns; tests `tests/tern-terminal-hud.test.ts` |
| Tern plugin placing the pill above omp's pill line and setting the sheet preview's output rows in the mono face | `fork-features/tern-plugin/` (`plugin.toml`, `terminals.css`, empty `window.luau`), shipped in the package; installed and kept current by `fork-features/tern-plugin-install.ts` (called from `withHostPresentation`); tests `tests/tern-plugin-install.test.ts` |
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

Tern qualification of the counter pill and Terminals sheet, 2026-10-12,
macOS arm64, omp 18.10.1: a real Tern window (`tern --control`, an isolated
`TERN_CONFIG_DIR` holding only this plugin) ran the installed omp, which
started tty sessions (`top -l 0 -s 2`, `bash -c 'seq 1 300; sleep 600'`) and
a background agent. The pill showed the terminal icon and count above omp's
agents counter; clicking it opened the Terminals sheet in the same frame as
omp's Agents sheet (shot side by side at 1280×800); the preview followed
`top`, ↓ selected the `seq` session and its preview showed rows 269–300, and
Esc closed the sheet.

Tern qualification of the terminal page, Kill and the ✕, 2026-10-12, same
setup: with `top -l 0 -s 2` and `cat` in tty sessions, the pill showed `2`
and its ✕; Enter on `top` opened the full-pane page with `top` at its full
120 columns and Kill and Back in its bar; Esc returned to the sheet; ↓ and
Enter opened `cat`, and typing `hello-from-tern` and Enter showed the typed
line and `cat`'s echo; Esc and `x` killed `cat`, whose row left the list
(`1 running · 1 stored`) once its exit was confirmed. The pill's ✕ hid the
HUD, and it came back with the count when the model started a third tty
session.

Tern qualification of the Agents-style preview and the page's pinned action
bar, 2026-10-12, same setup at 1280×800: with `top -l 0 -s 2` and `cat` in tty
sessions, the sheet showed Size `120×30`, PID and a ticking Time per row; the
`top` preview showed its title and `running` badge, the facts grid, the log
path on one line ending in its file name, and `top`'s newest rows column-aligned
in the mono face (`tern ctl dump` of `.sf-code-lines`: `Berkeley Mono`, before
the stylesheet rule `Geist`); after typing `hello-from-tern` on `cat`'s page,
Back showed the typed line and its echo in `cat`'s preview. The page filled the
sheet with the action bar at its bottom edge. Kill, the ✕ and its return with
a new tty session behaved as above. `npm test` passed 431 tests (four skips),
and `EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts
./tests/omp-presentation.test.ts` passed 56.

Tern qualification of the plugin auto-install and the OSC 10/11 answer,
2026-10-12, same setup: with the plugin unlinked from the isolated Tern,
starting omp showed the toast `unified-exec: installed its Tern plugin
0.14.6`, `tern plugin list` then listed it `ready`, and a new tty session's
pill sat above the composer. With a 0.14.5 copy installed by `tern plugin
install` instead, starting omp removed the copy and linked the package
(`0.14.6 … ready`). Starting omp again showed no toast and changed nothing.
An omp started in a tty session and opened on the terminal page drew omp's
light palette on the light page (it had drawn black message and thinking
blocks before the emulator answered OSC 11).

Tern qualification for 0.14.5, 2026-10-11, macOS arm64, omp 18.8.9: a real
Tern window (`tern --control`, an isolated `TERN_CONFIG_DIR` holding only
this plugin and the owner's `settings.json`, font size 12; `tern serve` loads
no plugins) ran the installed omp with a running turn, five todos, a
background agent and tty sessions, measured with `tern ctl tree`. With the
plugin loaded and the HUD dismissed, at 1280px: agents pill y 590 ending at
972, activity row 623, todo 624, meter 682, composer 706, identical to the
same state with the plugin removed. With the HUD shown, its row sat at y 592
above omp's agents pill (623) and spanned omp's column at every width
(1600: 467.7–1132.3; 1280: 307.7–972.3; 900: 117.7–782.3; 700: 30.8–669.2,
the same as omp's activity row), with the meter (682) and composer (706)
unmoved. A tty session printing `row-1` … `row-400` and then sleeping was
observed by the model's `exec_command` and then by a `write_stdin` poll; the
open panel followed `row-400`, and scrolling it up reached `row-1` after
both observations. `npm test` passed 428 tests (four skips), and
`EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts` passed 21.

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
- Humans glancing at live tty screens in the Tern terminal HUD on omp.
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
- No child ANSI styling in model/result text or in Pi/omp tool rows; the raw
  log is the recovery surface. The Tern HUD shows colors re-encoded from the
  emulator, never the child's bytes.
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
