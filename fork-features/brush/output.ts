/**
 * Brush output (contract C7). Projection order follows
 * can1357/oh-my-pi@c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4,
 * packages/coding-agent/src/exec/bash-executor.ts:576-618,813-847.
 * Unlike upstream's sanitized, lazily spilled sink, the single session
 * artifact receives every native text chunk unchanged, including small runs.
 * The native bridge supplies UTF-8 strings, not arbitrary subprocess bytes.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostSettings } from "./omp-host.ts";
import type { Delivery } from "./jobs.ts";

const EMPTY_UTF8 = new Uint8Array(0);

export type ImageContent = Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>;
export type TextContent = Extract<AgentToolResult<unknown>["content"][number], { type: "text" }>;

export type ArtifactError = "open" | "write" | "flush" | "end";
export type OutputAuthority =
	| { readonly kind: "artifact-backed"; readonly artifactId: string }
	| { readonly kind: "inline-only"; readonly reason: "artifact-unavailable"; readonly artifactError?: ArtifactError };

export interface ArtifactAllocation { readonly id?: string; readonly path?: string }
export interface OutputArtifactOwner {
	allocateArtifactPath(toolType: string): Promise<ArtifactAllocation>;
}
export interface OutputSummary {
	readonly output: string;
	readonly truncated: boolean;
	readonly totalLines: number;
	readonly totalBytes: number;
	readonly outputLines: number;
	readonly outputBytes: number;
	readonly elidedBytes?: number;
	readonly elidedLines?: number;
	readonly columnDroppedBytes?: number;
}
export interface HostOutputSink {
	push(chunk: string): void;
	replace(text: string): void;
	dump(): Promise<OutputSummary>;
	dispose(): Promise<void>;
}
export interface GraphicsDecoder {
	push(chunk: string): string;
	finish(): string;
	images(): Promise<ImageContent[]>;
}
export interface OutputBudgets {
	readonly spillThreshold: number;
	readonly headBytes: number;
	readonly maxColumns: number;
}
export interface OutputServices {
	createSink(budgets: OutputBudgets, onChunk: (text: string) => void): HostOutputSink;
	createGraphicsDecoder(): GraphicsDecoder;
	budgets(settings: HostSettings): OutputBudgets;
	enforceInlineByteCap(text: string, options: { maxBytes: number }): Promise<string>;
	formatArtifactErrorNotice(error: ArtifactError): string;
	readonly asyncInlineMaxChars: number;
}
export interface BrushOutputProjection {
	readonly summary: OutputSummary;
	readonly images: ImageContent[];
	readonly authority: OutputAuthority;
}

type Archive =
	| { readonly kind: "unallocated" }
	| { readonly kind: "open"; readonly fd: number; readonly artifactId: string }
	| OutputAuthority;

/** Parse only the public caller context; never retrieve an unrelated global session. */
export function outputArtifactOwner(context: unknown): OutputArtifactOwner | undefined {
	if (typeof context !== "object" || context === null || !("sessionManager" in context)) return undefined;
	const owner = context.sessionManager;
	if (typeof owner !== "object" || owner === null || !("allocateArtifactPath" in owner) ||
		typeof owner.allocateArtifactPath !== "function") return undefined;
	const allocate = owner.allocateArtifactPath;
	return { allocateArtifactPath: async (toolType) => {
		const result: unknown = await allocate.call(owner, toolType);
		if (typeof result !== "object" || result === null) throw new Error("omp artifact allocator returned no allocation");
		const id = "id" in result ? result.id : undefined;
		const path = "path" in result ? result.path : undefined;
		if ((id !== undefined && typeof id !== "string") || (path !== undefined && typeof path !== "string")) {
			throw new Error("omp artifact allocator returned an invalid allocation");
		}
		return { id, path };
	} };
}

/** One raw archive, one bounded final projection, one incremental graphics decoder. */
export class BrushOutput {
	readonly #services: OutputServices;
	readonly #owner: OutputArtifactOwner | undefined;
	readonly #sink: HostOutputSink;
	readonly #graphics: GraphicsDecoder;
	readonly #observe: (bytes: Uint8Array) => void;
	readonly #encoder = new TextEncoder();
	/** Only valid during synchronous sink.push; reuse encoding when sanitization is a no-op. */
	readonly #chunk = { text: "", bytes: EMPTY_UTF8 };
	#archive: Archive = { kind: "unallocated" };
	#closed = false;
	#closing: Promise<void> | undefined;
	#observing = true;
	#rawSummary: OutputSummary | undefined;
	#totalBytes = 0;
	#projection: Promise<BrushOutputProjection> | undefined;
	readonly budgets: OutputBudgets;

	constructor(services: OutputServices, settings: HostSettings, owner: OutputArtifactOwner | undefined,
		observe: (bytes: Uint8Array) => void) {
		this.#services = services;
		this.#owner = owner;
		this.#observe = observe;
		this.budgets = services.budgets(settings);
		this.#sink = services.createSink(this.budgets, (text) => {
			if (this.#observing) this.#observe(text === this.#chunk.text ? this.#chunk.bytes : this.#encoder.encode(text));
		});
		this.#graphics = services.createGraphicsDecoder();
	}

	/** Called inside the indexed execution's preparation, before native launch. */
	async prepare(signal: AbortSignal): Promise<void> {
		if (this.#closed || signal.aborted) return;
		let allocation: ArtifactAllocation;
		try { allocation = (await this.#owner?.allocateArtifactPath("bash")) ?? {}; }
		catch { this.#archive = { kind: "inline-only", reason: "artifact-unavailable", artifactError: "open" }; return; }
		// Preparation can finish after cancellation won its race. Never open a late descriptor.
		if (this.#closed || signal.aborted) return;
		if (!allocation.id || !allocation.path) {
			this.#archive = { kind: "inline-only", reason: "artifact-unavailable" };
			return;
		}
		try {
			this.#archive = { kind: "open", fd: openSync(allocation.path, "wx", 0o600), artifactId: allocation.id };
		} catch { this.#archive = { kind: "inline-only", reason: "artifact-unavailable", artifactError: "open" }; }
	}

	/** N-API awaits each callback; synchronous writes backpressure its bounded chunk bridge. */
	push(chunk: string): void {
		if (this.#closed) return;
		const raw = this.#encoder.encode(chunk);
		this.#totalBytes += raw.length;
		if (this.#archive.kind === "open") {
			const archive = this.#archive;
			try {
				let offset = 0;
				while (offset < raw.length) {
					const written = writeSync(archive.fd, raw, offset, raw.length - offset);
					if (written === 0) throw new Error("artifact write made no progress");
					offset += written;
				}
			} catch {
				this.#archive = { kind: "inline-only", reason: "artifact-unavailable", artifactError: "write" };
				try { closeSync(archive.fd); } catch { /* The first failed operation owns the notice. */ }
			}
		}
		const text = this.#graphics.push(chunk);
		if (text) {
			this.#chunk.text = chunk;
			this.#chunk.bytes = raw;
			try { this.#sink.push(text); }
			finally { this.#chunk.text = ""; this.#chunk.bytes = EMPTY_UTF8; }
		}
	}

	get authority(): OutputAuthority {
		switch (this.#archive.kind) {
			case "open":
			case "unallocated": return { kind: "inline-only", reason: "artifact-unavailable" };
			case "artifact-backed":
			case "inline-only": return this.#archive;
		}
	}

	/** UTF-8 byte length bounds JS UTF-16 length from above; using the char threshold as bytes is conservative. */
	inlineByteCap(delivery: Delivery["kind"]): number {
		return delivery === "host-job" ? Math.min(this.budgets.spillThreshold, this.#services.asyncInlineMaxChars)
			: this.budgets.spillThreshold;
	}

	get logPath(): string | undefined {
		return this.#archive.kind === "artifact-backed" ? `artifact://${this.#archive.artifactId}` : undefined;
	}

	get totalBytes(): number { return this.#totalBytes; }

	get captureNotice(): string | undefined {
		if (!this.#closed) return undefined;
		const authority = this.authority;
		if (authority.kind === "artifact-backed") return undefined;
		return authority.artifactError ? this.#services.formatArtifactErrorNotice(authority.artifactError)
			: "Full output was not saved (artifact unavailable)";
	}

	/** Native chunks drain first; resource closure precedes the session's outputClosed anchor. */
	close(terminated: boolean): Promise<void> {
		return this.#closing ??= this.#close(terminated);
	}
	async #close(terminated: boolean): Promise<void> {
		this.#closed = true;
		try {
			const tail = this.#graphics.finish();
			if (tail) this.#sink.push(tail);
		} finally {
			if (this.#archive.kind === "open") {
				const archive = this.#archive;
				try {
					closeSync(archive.fd);
					this.#archive = terminated ? { kind: "inline-only", reason: "artifact-unavailable" }
						: { kind: "artifact-backed", artifactId: archive.artifactId };
				} catch { this.#archive = { kind: "inline-only", reason: "artifact-unavailable", artifactError: "end" }; }
			}
		}
		try {
			if (terminated) await this.#sink.dispose();
			else this.#rawSummary = await this.#sink.dump();
		} finally { this.#observing = false; }
	}

	/** Cancellation never constructs a deliverable final projection. */
	dispose(): Promise<void> { return this.close(true); }

	finalize(minimized: string | undefined): Promise<BrushOutputProjection> {
		return this.#projection ??= this.#finalize(minimized);
	}
	async #finalize(minimized: string | undefined): Promise<BrushOutputProjection> {
		await this.close(false);
		const authority = this.authority;
		try {
			if (authority.kind === "artifact-backed" && minimized !== undefined) {
				// Do not decode the original stream's images twice.
				const scrub = this.#services.createGraphicsDecoder();
				const text = scrub.push(minimized) + scrub.finish();
				this.#sink.replace(`${text}${text.endsWith("\n") ? "" : "\n"}[raw output: artifact://${authority.artifactId}]\n`);
			}
			const summary = authority.kind === "artifact-backed" && minimized !== undefined
				? await this.#sink.dump() : this.#rawSummary;
			if (!summary) throw new Error("Brush output closed without its final inline projection");
			return { summary, authority, images: await this.#graphics.images() };
		} finally { await this.#sink.dispose(); }
	}
}
