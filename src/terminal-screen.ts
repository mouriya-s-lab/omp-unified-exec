/**
 * TerminalScreen — the rendered view of one tty session.
 *
 * A PTY child draws with cursor movement, erases, carriage returns and the
 * alternate screen. Stripping those controls from the raw stream leaves every
 * redraw appended to the previous one, so neither the model nor a human can
 * read the result. Each tty session therefore feeds its output, in order, into
 * a headless terminal emulator and reports what that terminal shows.
 *
 * Authority: the PTY byte stream (also mirrored raw to the session log). This
 * emulator is a derived projection owned by the session; it never feeds back
 * into the log or the pipe path.
 *
 * Observation contract (consuming, serialized per session):
 *   - normal screen: rows that scrolled into history since the previous
 *     observation and were not already reported, then the full current
 *     screen. After observing, history is dropped inside the emulator (ED3) so
 *     the next observation's history starts at this screen's top row and lines
 *     up positionally with it.
 *   - alternate screen: the full screen.
 *   - nothing changed (rows, cursor, screen): `unchanged`.
 * Snapshots (partial TUI updates) never consume anything.
 */

// @xterm/headless ships CommonJS; Node's ESM loader exposes it only as the default export.
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/** History budget in cells; scrollback rows = budget / cols (never below one screen). */
export const TERMINAL_HISTORY_CELLS = 240_000;

/** Emulator-only "erase saved lines": resets history without touching the screen or cursor. */
const ERASE_SCROLLBACK = "\x1b[3J";

export type TerminalScreenKind = "normal" | "alternate";

export interface TerminalView {
	readonly screen: TerminalScreenKind;
	readonly cols: number;
	readonly rows: number;
	/** 1-based cursor position within the screen. */
	readonly cursor: { readonly row: number; readonly col: number };
}

export type TerminalObservation =
	| { readonly kind: "unchanged"; readonly view: TerminalView }
	| {
			readonly kind: "rendered";
			readonly view: TerminalView;
			/** History lines (if any) followed by the full current screen, trailing blank rows removed. */
			readonly text: string;
			/** Leading lines of `text` that scrolled off above the screen since the previous observation. */
			readonly historyLines: number;
			/** History reached the emulator's capacity, so older scrolled-off lines may be missing (see the log). */
			readonly historyMayBeTruncated: boolean;
	  };

export interface TerminalSnapshot {
	readonly view: TerminalView;
	readonly text: string;
}

/** Immutable copy of one physical row; xterm reuses its line objects. */
interface Row {
	readonly text: string;
	readonly wrapped: boolean;
}

interface ObservedScreen {
	readonly screen: TerminalScreenKind;
	readonly rows: readonly Row[];
	readonly cursorRow: number;
	readonly cursorCol: number;
	/** Alternate-screen entry count when this was observed (alternate only). */
	readonly altEpoch: number;
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i]!.text !== b[i]!.text || a[i]!.wrapped !== b[i]!.wrapped) return false;
	}
	return true;
}

/**
 * Join wrapped continuation rows into logical lines; drop trailing blank lines.
 * `startedBefore` counts the logical lines that begin within the first
 * `splitRow` rows, so a line wrapping across that boundary is counted once.
 */
function toLines(rows: readonly Row[], splitRow = 0): { lines: string[]; startedBefore: number } {
	const lines: string[] = [];
	let startedBefore = 0;
	rows.forEach((row, index) => {
		if (row.wrapped && lines.length > 0) {
			lines[lines.length - 1] += row.text;
			return;
		}
		lines.push(row.text);
		if (index < splitRow) startedBefore++;
	});
	const trimmed = lines.map((line) => line.trimEnd());
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
	return { lines: trimmed, startedBefore: Math.min(startedBefore, trimmed.length) };
}

export class TerminalScreen {
	readonly cols: number;
	readonly rows: number;
	private readonly scrollback: number;
	private readonly term: Terminal;
	/** Writes handed to xterm whose parse callback has not fired yet. */
	private pendingWrites = 0;
	private flushWaiters: Array<() => void> = [];
	/** Serializes consuming observations. */
	private observeChain: Promise<unknown> = Promise.resolve();
	private altEpoch = 0;
	private lastNormal: ObservedScreen | undefined;
	private lastAlt: ObservedScreen | undefined;
	private lastScreen: TerminalScreenKind | undefined;
	private disposed = false;

	/**
	 * @param reply receives the terminal's own responses to queries (cursor
	 *   position, device attributes), which a real terminal sends back to the child.
	 */
	constructor(cols: number, rows: number, reply: (bytes: Uint8Array) => void) {
		this.cols = cols;
		this.rows = rows;
		this.scrollback = Math.max(rows, Math.floor(TERMINAL_HISTORY_CELLS / cols));
		this.term = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true });
		const encoder = new TextEncoder();
		this.term.onData((data) => reply(encoder.encode(data)));
		this.term.buffer.onBufferChange((buffer) => {
			if (buffer.type === "alternate") this.altEpoch++;
		});
	}

	/** Feed child output, in arrival order. */
	write(chunk: Uint8Array): void {
		if (this.disposed) return;
		this.enqueue(chunk);
	}

	private enqueue(data: Uint8Array | string): void {
		this.pendingWrites++;
		this.term.write(data, () => {
			this.pendingWrites--;
			if (this.pendingWrites === 0) {
				const waiters = this.flushWaiters;
				this.flushWaiters = [];
				for (const resolve of waiters) resolve();
			}
		});
	}

	/** Resolves once every write so far has been parsed into the screen. */
	private flushed(): Promise<void> {
		if (this.pendingWrites === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.flushWaiters.push(resolve);
		return promise;
	}

	private view(): TerminalView {
		const buffer = this.term.buffer.active;
		return {
			screen: buffer.type,
			cols: this.cols,
			rows: this.rows,
			cursor: { row: buffer.cursorY + 1, col: Math.min(buffer.cursorX, this.cols - 1) + 1 },
		};
	}

	private readRows(kind: TerminalScreenKind, start: number, end: number): Row[] {
		const buffer = kind === "normal" ? this.term.buffer.normal : this.term.buffer.alternate;
		const rows: Row[] = [];
		for (let y = start; y < end; y++) {
			const line = buffer.getLine(y);
			rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
		}
		return rows;
	}

	/** Current screen as a human sees it now, without consuming anything. May lag unparsed output. */
	snapshot(): TerminalSnapshot {
		const buffer = this.term.buffer.active;
		const rows = this.readRows(buffer.type, buffer.baseY, buffer.baseY + this.rows);
		return { view: this.view(), text: toLines(rows).lines.join("\n") };
	}

	/** Consuming observation; serialized so concurrent callers never share or skip a boundary. */
	observe(): Promise<TerminalObservation> {
		const run = this.observeChain.then(() => this.observeNow());
		this.observeChain = run.catch(() => undefined);
		return run;
	}

	private async observeNow(): Promise<TerminalObservation> {
		if (this.disposed) throw new Error("terminal screen observed after release");
		await this.flushed();
		const view = this.view();
		const buffer = this.term.buffer.active;

		if (buffer.type === "alternate") {
			const rows = this.readRows("alternate", 0, this.rows);
			const current: ObservedScreen = {
				screen: "alternate",
				rows,
				cursorRow: view.cursor.row,
				cursorCol: view.cursor.col,
				altEpoch: this.altEpoch,
			};
			const previous = this.lastScreen === "alternate" ? this.lastAlt : undefined;
			this.lastAlt = current;
			this.lastScreen = "alternate";
			if (
				previous &&
				previous.altEpoch === current.altEpoch &&
				previous.cursorRow === current.cursorRow &&
				previous.cursorCol === current.cursorCol &&
				sameRows(previous.rows, rows)
			) {
				return { kind: "unchanged", view };
			}
			return {
				kind: "rendered",
				view,
				text: toLines(rows).lines.join("\n"),
				historyLines: 0,
				historyMayBeTruncated: false,
			};
		}

		const baseY = buffer.baseY;
		const history = this.readRows("normal", 0, baseY);
		const screen = this.readRows("normal", baseY, baseY + this.rows);
		const previous = this.lastNormal;
		const returningFromAlt = this.lastScreen === "alternate";
		this.lastNormal = { screen: "normal", rows: screen, cursorRow: view.cursor.row, cursorCol: view.cursor.col, altEpoch: 0 };
		this.lastScreen = "normal";

		// History rows line up with the previous screen's rows (ED3 reset history
		// at its top). Skip the prefix already reported unchanged; never start
		// inside a wrapped logical line.
		const priorRows = previous?.rows ?? [];
		let skip = 0;
		while (
			skip < history.length &&
			skip < priorRows.length &&
			history[skip]!.text === priorRows[skip]!.text &&
			history[skip]!.wrapped === priorRows[skip]!.wrapped
		) {
			skip++;
		}
		// The row at `skip` is the next one reported (history first, then the
		// screen); back up while it continues a line whose start was skipped.
		while (skip > 0 && (skip < history.length ? history[skip]! : screen[0])?.wrapped) skip--;
		const newHistory = history.slice(skip);
		const historyMayBeTruncated = baseY >= this.scrollback;

		// Drop the history we just read so the next observation aligns with this screen.
		this.enqueue(ERASE_SCROLLBACK);
		await this.flushed();

		if (
			previous &&
			!returningFromAlt &&
			newHistory.length === 0 &&
			previous.cursorRow === view.cursor.row &&
			previous.cursorCol === view.cursor.col &&
			sameRows(previous.rows, screen)
		) {
			return { kind: "unchanged", view };
		}
		const { lines, startedBefore } = toLines([...newHistory, ...screen], newHistory.length);
		return {
			kind: "rendered",
			view,
			text: lines.join("\n"),
			historyLines: startedBefore,
			historyMayBeTruncated,
		};
	}

	/** Release the emulator once all output written so far is parsed. Idempotent. */
	async release(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.flushed();
		this.term.dispose();
	}
}
