/** Brush results are built once from their bounded host sink, independently of the poll cursor. */
import type { ExecSession } from "../../src/session.ts";
import { NO_OUTPUT } from "../../src/collect.ts";
import { finalizeProcessResult, renderKillResultText, renderProcessResultText } from "../../src/tool-result.ts";
import type { FinalizeProcessInput, KillResultDetails, ProcessResultDetails } from "../../src/tool-result.ts";
import { sanitizeOutputText } from "../../src/output-safety.ts";
import type { BrushOutcome } from "./execution.ts";
import type { BrushOutput, ImageContent, OutputServices, TextContent } from "./output.ts";

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
	const output = session.brushOutput;
	return finalizeProcessResult({ ...input, extra: {
		...deadlineDetails(session),
		...(output ? {
			brush_output: { authority: output.authority, inlineByteCap: output.inlineByteCap(session.delivery.kind), truncated: false },
			...(output.captureNotice ? { note: output.captureNotice } : {}),
		} : {}),
		...input.extra,
	} });
}

/** Keep owned notices outside the child's tail-line trimming window. */
async function boundedBrushBody(
	body: string, notices: readonly string[], budget: number, services: OutputServices,
): Promise<{ output: string; truncated: boolean }> {
	const suffix = notices.filter(Boolean).join("\n\n");
	const separator = body && suffix ? "\n\n" : "";
	const remaining = Math.max(1, budget - Buffer.byteLength(suffix) - separator.length);
	const bounded = await services.enforceInlineByteCap(body, { maxBytes: remaining });
	return { output: `${bounded}${separator}${suffix}`, truncated: bounded !== body };
}

/** ExecSession memoizes this promise; foreground and HostJob delivery share the exact result. */
export async function finalizeBrushSession(
	session: ExecSession, outcome: BrushOutcome, output: BrushOutput, services: OutputServices,
): Promise<ProcessResultDetails> {
	if (outcome.kind === "cancelled") throw new Error("Cancelled executions have no deliverable final result");
	const projection = await output.finalize(outcome.kind === "exited" ? outcome.minimized : undefined);
	const shape = finalizeSessionResult(session, {
		operation: "exec_command", wallTimeSec: (Date.now() - session.startedAt) / 1000,
		collected: NO_OUTPUT, totalBytes: session.totalBytesSeen,
		sessionId: undefined, exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage,
		tty: false, logPath: output.logPath, cwd: session.cwd, command: session.displayCommand,
	});
	const authority = projection.authority;
	const notices: string[] = [];
	if (session.timedOut) notices.push(`[${session.failureMessage ?? "Command timed out"}]`);
	if (session.exitCode !== null && session.exitCode !== 0) notices.push(`Command exited with code ${session.exitCode}`);
	if (authority.kind === "inline-only") {
		notices.push(authority.artifactError
			? services.formatArtifactErrorNotice(authority.artifactError)
			: "Full output was not saved (artifact unavailable)");
	}
	const summary = projection.summary;
	if (summary.columnDroppedBytes) notices.push(`Some lines were truncated to ${output.budgets.maxColumns} bytes`);
	// The host sink already selected head/tail. Never use the process tail-only envelope here.
	const text = sanitizeOutputText(summary.output);
	delete shape.note; // This final builder places the capture notice in its owned body suffix.
	const inlineByteCap = output.inlineByteCap(session.delivery.kind);
	shape.original_token_count = Math.ceil(summary.totalBytes / 4);
	const headerBytes = Buffer.byteLength(renderProcessResultText({ ...shape, output: "x" }, shape.command)) - 1;
	const bounded = await boundedBrushBody(text, notices, inlineByteCap - headerBytes, services);
	shape.output = bounded.output;
	shape.brush_output = { authority, inlineByteCap, truncated: summary.truncated || bounded.truncated };
	if (projection.images.length) shape.images = projection.images;
	return shape;
}

/** Cap the complete envelope, not just its body, so the host cannot spill a second lossy artifact. */
export async function brushResultContent(
	shape: ProcessResultDetails, services: OutputServices, command?: string,
): Promise<Array<TextContent | ImageContent>> {
	if (shape.brush_output) {
		const budget = shape.brush_output.inlineByteCap;
		const headerBytes = Buffer.byteLength(renderProcessResultText({ ...shape, output: "x", truncation: undefined }, command)) - 1;
		const bounded = await boundedBrushBody(shape.output, [], budget - headerBytes, services);
		const body = bounded.output;
		if (body !== shape.output) {
			shape.output = body;
			shape.brush_output = { ...shape.brush_output, truncated: true };
			delete shape.truncation; // Process-tail ranges do not describe the tighter Brush projection.
		}
	}
	const text = renderProcessResultText(shape, command);
	const capped = shape.brush_output
		? await services.enforceInlineByteCap(text, { maxBytes: shape.brush_output.inlineByteCap }) : text;
	if (capped !== text && shape.brush_output) {
		shape.brush_output = { ...shape.brush_output, truncated: true };
	}
	return [{ type: "text", text: capped }, ...(shape.images ?? [])];
}

/** Control results use the same truthful Brush archive and never spill a reduced kill tail. */
export async function brushKillResultContent(
	details: KillResultDetails, output: BrushOutput, services: OutputServices,
): Promise<TextContent[]> {
	const budget = output.budgets.spillThreshold;
	const notice = output.captureNotice;
	const headerBytes = Buffer.byteLength(renderKillResultText({ ...details, output: "x" })) - 1;
	const bounded = await boundedBrushBody(
		details.output, notice ? [`[${notice}]`] : [], budget - headerBytes, services,
	);
	details.output = bounded.output;
	const reduced = bounded.truncated;
	details.brush_output = {
		authority: output.authority, inlineByteCap: budget,
		truncated: reduced || details.truncation?.truncated === true,
	};
	if (reduced) delete details.truncation; // Its old process-tail ranges no longer describe this projection.
	const text = renderKillResultText(details);
	const capped = await services.enforceInlineByteCap(text, { maxBytes: budget });
	if (capped !== text) details.brush_output = { ...details.brush_output, truncated: true };
	return [{ type: "text", text: capped }];
}
