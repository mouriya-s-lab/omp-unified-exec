/**
 * Compiled CLI executable recovery copied from can1357/oh-my-pi
 * @c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * packages/coding-agent/src/subprocess/worker-client.ts:resolveExecutablePath.
 * Helpers come from the host's utils module, so compiled detection describes
 * the host, not this disk-loaded plugin. Source hosts use their own resolver
 * lazily, preserving its shared worker-host entry and host-relative fallback.
 */
export interface CliResolutionHelpers {
	readonly isCompiledBinary: () => boolean;
	readonly stripWindowsExtendedLengthPathPrefix: (path: string) => string;
	readonly isExecutable: (path: string) => boolean;
	readonly isFullyQualifiedPath: (path: string) => boolean;
	/** Absolute-only lookup with the host's WhichCachePolicy.Bypass. */
	readonly which: (command: string) => string | null;
	readonly sourceCliEntryCmd: () => Promise<readonly string[]>;
}

export async function resolveCliEntryCmd(helpers: CliResolutionHelpers): Promise<readonly string[]> {
	if (!helpers.isCompiledBinary()) return helpers.sourceCliEntryCmd();
	const executable = helpers.stripWindowsExtendedLengthPathPrefix(process.execPath);
	if (!helpers.isExecutable(executable)) {
		const argv0 = helpers.stripWindowsExtendedLengthPathPrefix(process.argv0);
		const isPath = argv0.includes("/") || argv0.includes("\\") || argv0.includes(":");
		const candidates = [
			helpers.isFullyQualifiedPath(argv0) ? argv0 : null,
			!isPath ? helpers.which(argv0) : null,
			helpers.which("omp"),
		];
		for (const candidate of candidates) {
			if (candidate && helpers.isExecutable(candidate)) return [candidate];
		}
	}
	return [executable];
}
