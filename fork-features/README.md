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
| Tern terminal HUD: a counter pill copied from omp's running-work counter (terminal icon and count), on its own line above omp's counter, counts tty sessions, and its ✕ hides it until a new tty session; clicking it opens the Terminals sheet, built like omp's Agents sheet (sessions with status dots and Size / PID / Time columns, the selected session's facts, log link and newest output rows as the preview, Kill, Close, Open); Open shows the session as a full-pane terminal page built like omp's Console, with typed keys sent to the session | `fork-features/tern-terminal-hud.ts`, `fork-features/tern-plugin/`, `fork-features/tern-plugin-install.ts`, `fork-features/omp-tools.d.ts`, `tests/tern-terminal-hud.test.ts`, `tests/tern-plugin-install.test.ts`; `TerminalScreen.styledScreen`/`onChange` in `src/terminal-screen.ts`, `ExecSession.styledScreen`/`onScreenChange` in `src/session.ts`, `SessionStore.subscribe` in `src/session-store.ts`; `activate` in `src/index.ts` returns the store and a kill over `terminateSessionById` to `withHostPresentation`; `fork-features/tern-plugin` in `package.json` `files` | A tool result shows a tty screen only as it was when that call returned ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The widget is mounted through `ctx.ui.setWidget` (`belowEditor`) only while `@oh-my-pi/pi-tui/native/state` reports native (Tern) rendering and an undismissed tty session is stored, so omp's ANSI TUI is unchanged. It describes a row built like omp's pill line (`unified-exec.terminals`) holding omp's counter structure (`omp.hud.pill` / `omp.hud.seg`) and the ✕; an extension cannot add to omp's `HudPillsRow`, so the CSS-only Tern plugin in `fork-features/tern-plugin/` moves that row to the front of omp's dock, above omp's pill line, without touching omp's own rows. omp installs that plugin itself: at the first interactive session in a Tern pane (`TERN_PANE_SOCKET` and a numeric `TERN_PANE`) it asks `tern plugin list --json` and, unless Tern already runs the same version and stylesheet, runs `tern plugin link` on the package's directory (removing an installed copy that blocks it), with a toast on install or update and a warning naming the manual command on failure; without the plugin the pill sits below the composer. The sheet and the page are extension custom overlays: the sheet answers `nativeSheet`, so omp mounts its `picker` description as the modal sheet, as for the Agents sheet; the page declares a `full` `nativeOverlay`, as omp's Console does. The preview shows the newest output rows as a plain-text `code` block (role `unified-exec.terminals.tail`), which the plugin also sets in the mono face because Tern draws a preview's code in the UI face; the page shows colored `ansi` holding the session's retained history and current screen, filling the page and scrolling inside itself ([#19](https://github.com/mouriya-s-lab/omp-unified-exec/issues/19)). Only the page's typed keys and Kill reach sessions; model-visible results stay plain text. | Fork-only |

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
pill's `open` and ✕ `dismiss` actions must still reach the widget's
`handleNativeEvent`; a custom-overlay component answering `nativeSheet` must
still be mounted as its `picker` sheet with `select`/`activate`/`action`
events reaching it, a custom overlay with a `full` `nativeOverlay` must still
be drawn as a full-pane sheet whose `handleInput` receives typed keys, and
omp's counter must still be `omp.hud.pill` / `omp.hud.seg`. On omp or Tern
upgrades, the Tern plugin's selectors must still hold: the `belowEditor`
container is the dock's last `.sf-col.gap-none` child, Tern's Reader style
still lays a role-less column's rows on omp's 720px line, and a `code` node's
role still reaches its element with the lines in `.sf-code-lines`. In Tern, a
`full` sheet's `ansi` must still fill the height its action bar leaves under
`grow` and a fractional `max.h`, and scroll inside itself. Tern must still
export `TERN_PANE_SOCKET` and `TERN_PANE` into panes, and `tern plugin`
must still offer `list --json` (each plugin's `id`, `version`, `css`,
`status`), `link DIR`, `remove ID`, and a link must still reload the daemon's
plugins. Check
it in a real Tern window (`tern --control`, plugins load only in windows, not
in `tern serve`) with the owner's settings, a running turn, todos and a
background agent at several widths: with the HUD hidden, every omp rect equal
to a plugin-free run; with it shown, the counter pill above omp's counter on
omp's column; the ✕ hiding it until a new tty session; the Terminals sheet
opening like the Agents sheet, picking a session by click and ↑/↓, Kill and
`x` ending a running session; Open / Enter showing the full-pane page at the
session's full width, scrolling back to its first history row after the
model has observed it, typed keys reaching a running `cat`, Esc / Back
returning to the sheet; Esc and Close, live updates and a usable composer
after closing.
