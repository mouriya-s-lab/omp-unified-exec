// Ambient script (no top-level import/export): these modules exist only inside
// oh-my-pi, so their values are parsed at runtime by omp-presentation.ts and
// tern-terminal-hud.ts.
declare module "@oh-my-pi/pi-tui/tools" {
	export const toolRenderers: Readonly<Record<string, unknown>>;
}

declare module "@oh-my-pi/pi-tui/native/state" {
	export const isNativeRendering: unknown;
	export const onNativeRenderingChange: unknown;
}

declare module "@oh-my-pi/pi-tui/theme" {
	export const isLightTheme: unknown;
	export const getCurrentThemeName: unknown;
}

// Host modules the embedded brush shell reads through its session binding
// (fork-features/brush/omp-host.ts parses them).
declare module "@oh-my-pi/pi-coding-agent" {
	export const AgentRegistry: unknown;
	export const CRITICAL_BASH_PATTERNS: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/exec/non-interactive-env" {
	export const buildNonInteractiveEnv: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/utils/shell-snapshot" {
	export const getOrCreateSnapshot: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/exec/direnv" {
	export const loadDirenvEnv: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/exec/settings" {
	export const cfgBashGitGuard: unknown;
	export const cfgBashDirenv: unknown;
	export const cfgBashDirenvLoadTimeoutMs: unknown;
	export const cfgShellMinimizer: unknown;
	export const cfgBashPatterns: unknown;
	export const cfgBashAllowCompoundCommands: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/shell-tokenize" {
	export const tokenizeShellSegments: unknown;
	export const extractLiteralAndChainSegments: unknown;
	export const extractLeadingCdTarget: unknown;
	export const extractFlatShellCommandSegments: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/approval" {
	export const truncateForPrompt: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/internal-urls" {
	export const InternalUrlRouter: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/path-utils" {
	export const resolveToCwd: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite" {
	export const rewriteGitWorktreeAdd: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/task/settings" {
	export const cfgWorktreeClone: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/subprocess/worker-client" {
	export const resolveCliEntryCmd: unknown;
}

declare module "@oh-my-pi/pi-utils" {
	export const isCompiledBinary: unknown;
	export const stripWindowsExtendedLengthPathPrefix: unknown;
	export const isExecutable: unknown;
	export const isFullyQualifiedPath: unknown;
	export const $which: unknown;
	export const WhichCachePolicy: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation" {
	export const invalidateGithubCacheForBashCommand: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem" {
	export const InternalUrlFilesystem: unknown;
	export const UrlFsError: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/session/context-settings" {
	export const cfgCompactionExperimentalContextManagement: unknown;
}
