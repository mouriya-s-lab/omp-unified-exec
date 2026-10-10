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
| Compact codemode fix reads `createCodemodeExtension` off the module namespace and stays off when the host lacks it | `src/codemode-render.ts`, `tests/codemode-render.test.ts` | Since 0.12.1 a named import of Pi's codemode factory fails to link on omp, which has no codemode; the whole package then fails plugin validation | Fork-only |
| Native Bun PTY backend with lazy Node fallback | `src/pty.ts`, `tests/bun-pty-runtime.mjs`, `.github/workflows/ci.yml` | omp is a `bun build --compile` executable and blocks dependency lifecycle scripts, so Node ABI prebuilds cannot provide a reliable PTY. Bun 1.4's `Bun.Terminal` supplies `openpty` on Linux/macOS and ConPTY on Windows; ordinary Node hosts retain the pinned @homebridge backend. | Fork-only |
| omp presentation: exec_command, write_stdin and kill_session render through omp's bash renderer; other tools use omp's default card | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`, `tests/omp-presentation.test.ts`; `withHostPresentation` in `src/index.ts`; `base64ByteLength`/`stringifyChars` exported from `src/render.ts`; `fork-features` in `package.json` `files` and `tsconfig.json` | omp calls extension renderers as `renderCall(args, options, theme)` / `renderResult(result, options, theme, args)` and Tern reads `describeCall`/`describeResult`; Pi's renderers threw on every repaint and omp showed the raw model envelope. omp is detected by its injected `ExtensionAPI.arktype`; the bash renderer comes from `@oh-my-pi/pi-tui/tools` `toolRenderers.bash`, and omp fails plugin loading if that contract is missing. Pi activation is unchanged. | Fork-only |
| Tern terminal HUD: a dock pill counts tty sessions; clicking it floats a non-modal panel above it with one collapsible card per session showing the live, colored screen | `fork-features/tern-terminal-hud.ts`, `fork-features/omp-tools.d.ts`, `tests/tern-terminal-hud.test.ts`; `TerminalScreen.styledScreen`/`onChange` in `src/terminal-screen.ts`, `ExecSession.styledScreen`/`onScreenChange` in `src/session.ts`, `SessionStore.subscribe` in `src/session-store.ts`; `activate` in `src/index.ts` returns the store to `withHostPresentation` | A tool result shows a tty screen only as it was when that call returned ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The widget is mounted through `ctx.ui.setWidget` only while `@oh-my-pi/pi-tui/native/state` reports native (Tern) rendering and a tty session is stored, so omp's ANSI TUI is unchanged. The panel is an `overlay` node in the widget's own description, which omp hoists into the TSP `layer` and anchors to the pill. Read-only; model-visible results stay plain text. | Fork-only |

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

The package rename, codemode host guard, native Bun PTY backend, omp
presentation and Tern terminal HUD are the fork customizations meant to stay. On
omp upgrades, requalify the omp presentation: `toolRenderers.bash` must still
expose `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`
and accept `{command, cwd}` args and `{exitCode, wallTimeMs, async}` details.
Requalify the Tern HUD too: `@oh-my-pi/pi-tui/native/state` must still export
`isNativeRendering`/`onNativeRenderingChange`; a widget component's `describe`
must still reach Tern, its `overlay` children must still be hoisted into `layer`
with `anchor.node` resolved against the component's keypaths
(`packages/tui/src/native/reconcile.ts`), and pill actions must still reach the
component's `handleNativeEvent`. Check it in a real Tern window: the pill, the
floating panel, live updates and an unchanged composer.
