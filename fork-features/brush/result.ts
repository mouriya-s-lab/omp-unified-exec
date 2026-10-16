/** Brush result construction independent of the polling cursor. */
import { open, type FileHandle } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { CollectResult } from "../../src/collect.ts";
import type { ExecSession } from "../../src/session.ts";
import { finalizeProcessResult } from "../../src/tool-result.ts";
import type { FinalizeProcessInput, ProcessResultDetails } from "../../src/tool-result.ts";

async function readExactly(file: FileHandle, bytes: Buffer, offset: number, length: number, position: number): Promise<void> {
	let received = 0;
	while (received < length) {
		const { bytesRead } = await file.read(bytes, offset + received, length - received, position + received);
		if (bytesRead === 0) throw new Error("Output archive changed while reading its final projection");
		received += bytesRead;
	}
}

/** Read a bounded head/tail projection from the complete archive, never the consumed poll buffer. */
export async function readBoundedArchive(path: string): Promise<CollectResult> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		if (size <= DEFAULT_MAX_BYTES) {
			const bytes = Buffer.allocUnsafe(size);
			await readExactly(file, bytes, 0, size, 0);
			return { kind: "stream", bytes, omittedBytes: 0 };
		}
		const half = Math.floor(DEFAULT_MAX_BYTES / 2);
		const omittedBytes = size - half * 2;
		const marker = Buffer.from(`\n[... ${omittedBytes} bytes omitted; complete output is in the archive ...]\n`);
		const bytes = Buffer.allocUnsafe(half * 2 + marker.length);
		await readExactly(file, bytes, 0, half, 0);
		bytes.set(marker, half);
		await readExactly(file, bytes, half + marker.length, half, size - half);
		return { kind: "stream", bytes, omittedBytes };
	} finally { await file.close(); }
}

export function deadlineDetails(session: ExecSession): Partial<ProcessResultDetails> {
	return {
		...(session.timedOut ? { timedOut: true } : {}),
		...(session.wasTerminated ? { cancelled: true } : {}),
		...(session.deadline.kind === "deadline" ? {
			timeoutSeconds: session.deadline.seconds,
			timeoutNotice: session.deadline.notice,
		} : {}),
	};
}

export function finalizeSessionResult(session: ExecSession, input: FinalizeProcessInput): ProcessResultDetails {
	return finalizeProcessResult({ ...input, extra: { ...deadlineDetails(session), ...input.extra } });
}

/** ExecSession memoizes this promise once; all foreground and host consumers share its result. */
export async function finalizeBrushSession(session: ExecSession): Promise<ProcessResultDetails> {
	return finalizeSessionResult(session, {
		operation: "exec_command", wallTimeSec: (Date.now() - session.startedAt) / 1000,
		collected: await readBoundedArchive(session.logPath), totalBytes: session.totalBytesSeen,
		sessionId: undefined, exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage,
		tty: false, logPath: session.logPath, cwd: session.cwd, command: session.displayCommand,
	});
}
