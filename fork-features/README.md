# omp-unified-exec fork

Fork of [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) for
[oh-my-pi](https://github.com/can1357/oh-my-pi) (omp). omp forked from Pi in early
2026 and loads Pi packages through a compatibility layer that only covers part of
Pi's newer API, so upstream releases can stop loading on omp.

Install: `omp install https://github.com/mouriya-s-lab/omp-unified-exec`.
Remove an existing `pi-unified-exec` first (`omp plugin uninstall pi-unified-exec`):
both register `exec_command` and the other unified-exec tools.

## Customizations

| Change | Files | Why | Upstream |
|---|---|---|---|
| Package name `omp-unified-exec` | `package.json` (`name`, `repository`, `homepage`) | omp names the plugin after the package | Fork-only |
| README rewritten for the fork, in English and Chinese: omp install, Tern terminal HUD, omp presentation, fork layout; upstream's npm, badges and maintenance notice removed | `README.md`, `README.zh-CN.md` | The fork's behaviour and installation diverged from upstream's README (npm package, Pi-only presentation), so it misled omp users | Fork-only |
| Compact codemode fix reads `createCodemodeExtension` off the module namespace and stays off when the host lacks it | `src/codemode-render.ts`, `tests/codemode-render.test.ts` | Since 0.12.1 a named import of Pi's codemode factory fails to link on omp, which has no codemode; the whole package then fails plugin validation | Fork-only |
| Native Bun PTY backend with lazy Node fallback | `src/pty.ts`, `tests/bun-pty-runtime.mjs`, `.github/workflows/ci.yml` | omp is a `bun build --compile` executable and blocks dependency lifecycle scripts, so Node ABI prebuilds cannot provide a reliable PTY. Bun 1.4's `Bun.Terminal` supplies `openpty` on Linux/macOS and ConPTY on Windows; ordinary Node hosts retain the pinned @homebridge backend. | Fork-only |
| omp presentation: exec_command, write_stdin and kill_session render through omp's bash renderer; other tools use omp's default card | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`, `tests/omp-presentation.test.ts`; `withHostPresentation` in `src/index.ts`; `base64ByteLength`/`stringifyChars` exported from `src/render.ts`; `fork-features` in `package.json` `files` and `tsconfig.json` | omp calls extension renderers as `renderCall(args, options, theme)` / `renderResult(result, options, theme, args)` and Tern reads `describeCall`/`describeResult`; Pi's renderers threw on every repaint and omp showed the raw model envelope. omp is detected by its injected `ExtensionAPI.arktype`; the bash renderer comes from `@oh-my-pi/pi-tui/tools` `toolRenderers.bash`, and omp fails plugin loading if that contract is missing. Pi activation is unchanged. | Fork-only |
| Tern terminal HUD: a native running-work counter (terminal icon and stored tty count), on its own line above omp's counter; clicking it opens the Terminals sheet, built like omp's Agents sheet (sessions with status dots and Size / PID / Time columns, the selected session's facts, log link and newest output rows as the preview, Kill, Close, Open); Open shows a full-pane terminal page built like omp's Console, with typed keys sent to the session | `fork-features/tern-terminal-hud.ts`, `fork-features/tern-plugin/`, `fork-features/tern-plugin-install.ts`, `fork-features/omp-tools.d.ts`, `tests/tern-terminal-hud.test.ts`, `tests/tern-plugin-install.test.ts`; `TerminalScreen.styledScreen`/`onChange` in `src/terminal-screen.ts`, `ExecSession.styledScreen`/`onScreenChange` in `src/session.ts`, `SessionStore.subscribe` in `src/session-store.ts`; `activate` in `src/index.ts` returns the store and a kill over `terminateSessionById` to `withHostPresentation`; `fork-features/tern-plugin` in `package.json` `files` | A tool result shows a tty screen only as it was when that call returned ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The widget mounts through `ctx.ui.setWidget` (`belowEditor`) exactly while native rendering is active and a tty session is stored, including naturally exited tty sessions not yet removed; there is no outer dismiss action or hidden lifecycle. Its row uses `omp.hud`, with `omp.hud.pill` / `omp.hud.seg`, so Tern owns its appearance and Reader, Spine and Console geometry. The CSS-only plugin moves the shared belowEditor container above omp's counter and clears its margin, padding, background and shadow; other co-located widgets share this placement and reset. It also sets the preview's `code` output (`unified-exec.terminals.tail`) in the mono face. The awaited omp factory synchronizes a normal Tern copy during install/force validation and ordinary loading; it verifies all three files and the ready catalog, automatically migrates confirmed legacy `.path` links through Tern's CLI, and fails loading if an available Tern cannot synchronize. No session-start installation or developer link remains. Without the plugin the pill sits below the composer. The sheet answers `nativeSheet` and uses a modal `picker`; the page declares a `full` `nativeOverlay` and shows colored, scrollable `ansi` from retained history and the current screen ([#19](https://github.com/mouriya-s-lab/omp-unified-exec/issues/19)). Only the page's typed keys and sheet/page Kill reach sessions; model-visible results stay plain text. | Fork-only |

Environment variables (`PI_UNIFIED_EXEC_*`), tool names and source layout are
unchanged, so other omp plugins that import `src/*` keep working after the path
moves from `node_modules/pi-unified-exec` to `node_modules/omp-unified-exec`.

## Repository state

- `Publish to npm` and `Interaction limit reminder` are disabled with
  `gh workflow disable`: the fork publishes nothing to npm, and the reminder
  tracks upstream's own interaction limit. This is repo state, so syncing the
  workflow files back in does not re-enable them.
- `Sync upstream` (`.github/workflows/sync-upstream.yml`) merges `upstream/main`
  into `main` daily through PRs gated on `CI`.

## Expected sync conflict

`name` sits on the line next to `version`, and git treats edits to adjacent lines
as a conflict. Every upstream release bumps `version`, so its sync arrives as a
review PR. Resolve it by keeping `"name": "omp-unified-exec"` and taking upstream's
`version`.

`README.md` and `README.zh-CN.md` are fork-owned. When a sync touches the
README, keep the fork's and carry over only upstream facts that still hold here
(tool parameters, limits, semantics), written into the fork's sections of both
files; the two stay section-for-section translations of each other.

The package rename, fork README, codemode host guard, native Bun PTY backend,
omp presentation and Tern terminal HUD are the fork customizations meant to stay. On
omp upgrades, requalify the omp presentation: `toolRenderers.bash` must still
expose `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`
and accept `{command, cwd}` args and `{exitCode, wallTimeMs, async}` details.
Requalify the Tern HUD too: `@oh-my-pi/pi-tui/native/state` must still export
`isNativeRendering`/`onNativeRenderingChange`; a widget component's `describe`
must still reach Tern, `belowEditor` widgets must still get no spacer, and the
pill's `open` action must still reach the widget's `handleNativeEvent`; a
custom-overlay component answering `nativeSheet` must
still be mounted as its `picker` sheet with `select`/`activate`/`action`
events reaching it, a custom overlay with a `full` `nativeOverlay` must still
be drawn as a full-pane sheet whose `handleInput` receives typed keys, and
omp's counter must still use `omp.hud` / `omp.hud.pill` / `omp.hud.seg`.
On omp or Tern upgrades, the Tern plugin's selectors must still hold: the
shared `belowEditor` container is the dock's last `.sf-col.gap-none` child,
the empty container stays zero-size and never selects the editor, and the
native HUD rules match the nested terminal row in Reader, Spine and Console.
A `code` node's role must still reach its element with `.sf-code-lines`.
In Tern, a `full` sheet's `ansi` must still fill the height its action bar leaves under
`grow` and a fractional `max.h`, and scroll inside itself. On omp upgrades,
package installation validation must still await the extension factory after
materializing package assets, and propagate its rejection before reporting
success. Ordinary loading uses that same initializer; `session_start` has no
installation IO. Requalify missing/stale copies, same-version asset updates,
unchanged exact copies and legacy `.path` registrations through only
`omp plugin install URL --force`, checking Tern's copy before any session.
Tern's `plugin dir --json`, `list --json` (`id`, `version`, `css`, `status`),
`install DIR --force --json` (`id`, `version`, absolute `dir`) and
`unlink ID --json` must retain their contract. The exact linked-target
conflict plus a matching canonical registration and fresh catalog are
required before unlink; unrelated failures must never remove registrations.
The per-command timeout is 75 seconds, covering Tern's 60-second reload wait.
With no daemon, the copy must still install for next start. Missing Tern
skips initialization; an available but failing Tern rejects installation
validation and ordinary loading. Check
it in a real Tern window (`tern --control`, plugins load only in windows, not
in `tern serve`) with the owner's settings, a running turn, todos and a
background agent at 1280×800 and 700px width, in Reader, Spine and Console
with a light and a dark theme switched in the same live tty session.
Compare both counters' row and pill rects (right edges within 1px), fonts,
height, radius, border and hover; check Spine with the pane focused and
unfocused. With no tty or other widget, every composer, meter and activity/
todo rect must match a plugin-free run and the empty container occupy no
height. With tty sessions, the terminal counter has only its icon and count,
no outer ✕, extra bottom spacing or Spine container plate. The Terminals sheet
must open like the Agents sheet and pick a session by click and ↑/↓. Kill and
`x` must end only the selected running session after confirmed exit; Open /
Enter must show the full-pane page at the session's full width, with retained
history still scrollable after model observations and typed keys reaching a
running `cat`. Esc / Back must return to the sheet; Close and Esc must leave
processes alive and the composer usable. Removing the last tty unmounts the
counter; starting another tty immediately mounts it again.
