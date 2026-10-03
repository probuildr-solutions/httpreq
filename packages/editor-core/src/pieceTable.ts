/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * A run of lines of the document, taken either from the file on disk or from text typed in.
 *
 * Pieces never hold the file's text: an `original` piece is a line range of the file, read from
 * disk when it is shown or saved. The memory an edited 3 GB file needs is therefore the lines the
 * user added, however many pieces they have been cut into.
 */
export type Piece =
    | { readonly kind: 'original'; readonly from: number; readonly count: number }
    | { readonly kind: 'added'; readonly lines: readonly string[] };

/** A part of a requested range, ready to be read. */
export type Segment =
    { kind: 'original'; from: number; count: number } | { kind: 'added'; lines: readonly string[] };

const HISTORY_LIMIT = 500;

const sizeOf = (piece: Piece): number =>
    piece.kind === 'original' ? piece.count : piece.lines.length;

/**
 * The document as a sequence of pieces over the original file's lines, with undo and redo.
 *
 * Every edit is a splice on line ranges: delete some lines, insert others. Splitting a piece
 * copies no text, and every piece is immutable, so an undo point is just the previous array of
 * pieces (cheap, since unchanged pieces are shared). Adjacent pieces that can be merged are.
 *
 * Line semantics match the rest of Database Studio: a document with `n` line breaks has `n + 1`
 * lines, so an empty document has one empty line.
 */
export class LinePieceTable {
    private current: readonly Piece[];
    private undoStack: (readonly Piece[])[] = [];
    private redoStack: (readonly Piece[])[] = [];
    /** Starts of each piece in document lines; rebuilt lazily after an edit. */
    private starts: number[] | null = null;
    private total: number;
    private savedPoint: readonly Piece[];

    constructor(readonly originalLineCount: number) {
        this.current =
            originalLineCount > 0 ? [{ kind: 'original', from: 0, count: originalLineCount }] : [];
        this.total = originalLineCount;
        this.savedPoint = this.current;
    }

    get lineCount(): number {
        return this.total;
    }

    get pieces(): readonly Piece[] {
        return this.current;
    }

    /** Whether the document differs from what was last saved (or opened). */
    get dirty(): boolean {
        return this.current !== this.savedPoint && !samePieces(this.current, this.savedPoint);
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Marks the current content as saved; later edits make the document dirty again. */
    markSaved(): void {
        this.savedPoint = this.current;
    }

    /**
     * Replaces `deleteCount` lines starting at `from` with `lines`. This one operation is every
     * edit: inserting is a splice that deletes nothing, deleting one that adds nothing.
     */
    splice(from: number, deleteCount: number, lines: readonly string[] = []): void {
        if (!Number.isInteger(from) || from < 0 || from > this.total) {
            throw new RangeError('Line out of range.');
        }
        const remove = Math.max(0, Math.min(deleteCount, this.total - from));
        if (remove === 0 && lines.length === 0) return;

        const before: Piece[] = [];
        const after: Piece[] = [];
        let position = 0;
        for (const piece of this.current) {
            const size = sizeOf(piece);
            const end = position + size;
            // The part of this piece before the splice, and the part after it.
            if (position < from) before.push(...slice(piece, 0, Math.min(size, from - position)));
            if (end > from + remove)
                after.push(...slice(piece, Math.max(0, from + remove - position), size));
            position = end;
        }
        const next = normalize([...before, ...(lines.length > 0 ? [added(lines)] : []), ...after]);
        // The document can never have zero lines: an empty one is a single empty line.
        this.push(next.length > 0 ? next : [added([''])]);
    }

    /**
     * Replaces the whole document with `pieces` (restored unsaved work). It is one undo step, so
     * undoing it returns to the document as opened. Pieces that refer to lines the file does not
     * have are refused.
     */
    restore(pieces: readonly Piece[]): void {
        for (const piece of pieces) {
            if (
                piece.kind === 'original' &&
                (piece.from < 0 || piece.from + piece.count > this.originalLineCount)
            ) {
                throw new RangeError('The saved pieces do not fit this file.');
            }
        }
        const next = normalize([...pieces]);
        this.push(next.length > 0 ? next : [added([''])]);
    }

    insert(at: number, lines: readonly string[]): void {
        this.splice(at, 0, lines);
    }

    delete(from: number, count: number): void {
        this.splice(from, count, []);
    }

    /** Replaces one line. */
    setLine(index: number, text: string): void {
        if (index < 0 || index >= this.total) throw new RangeError('Line out of range.');
        this.splice(index, 1, [text]);
    }

    undo(): boolean {
        const previous = this.undoStack.pop();
        if (!previous) return false;
        this.redoStack.push(this.current);
        this.set(previous);
        return true;
    }

    redo(): boolean {
        const next = this.redoStack.pop();
        if (!next) return false;
        this.undoStack.push(this.current);
        this.set(next);
        return true;
    }

    /** The parts of `[from, from + count)` and where each comes from, in document order. */
    segments(from: number, count: number): Segment[] {
        const first = Math.max(0, from);
        const last = Math.min(this.total, from + count);
        const out: Segment[] = [];
        if (first >= last) return out;
        const starts = this.startsOf();
        // Binary search for the piece containing `first`.
        let low = 0;
        let high = this.current.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (starts[middle]! <= first) low = middle;
            else high = middle - 1;
        }
        for (let i = low; i < this.current.length && starts[i]! < last; i++) {
            const piece = this.current[i]!;
            const start = starts[i]!;
            const takeFrom = Math.max(first, start) - start;
            const takeTo = Math.min(last, start + sizeOf(piece)) - start;
            if (piece.kind === 'original') {
                out.push({
                    kind: 'original',
                    from: piece.from + takeFrom,
                    count: takeTo - takeFrom,
                });
            } else {
                out.push({ kind: 'added', lines: piece.lines.slice(takeFrom, takeTo) });
            }
        }
        return out;
    }

    /**
     * The lines of a range as text. `readOriginal` fetches lines of the file by their original
     * line numbers; it is called once per original run, never for added text.
     */
    async read(
        from: number,
        count: number,
        readOriginal: (from: number, count: number) => Promise<string[]>,
    ): Promise<string[]> {
        const out: string[] = [];
        for (const segment of this.segments(from, count)) {
            if (segment.kind === 'added') out.push(...segment.lines);
            else {
                const lines = await readOriginal(segment.from, segment.count);
                // A short read (the file shrank, or a line is not readable yet) keeps the layout.
                for (let i = 0; i < segment.count; i++) out.push(lines[i] ?? '');
            }
        }
        return out;
    }

    /** Which original line a document line is, or `null` for a line that was added or edited. */
    originalLineAt(index: number): number | null {
        const [segment] = this.segments(index, 1);
        return segment?.kind === 'original' ? segment.from : null;
    }

    private push(next: readonly Piece[]): void {
        this.undoStack.push(this.current);
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.set(next);
    }

    private set(next: readonly Piece[]): void {
        this.current = next;
        this.starts = null;
        this.total = next.reduce((sum, piece) => sum + sizeOf(piece), 0);
    }

    private startsOf(): number[] {
        if (this.starts) return this.starts;
        const starts: number[] = [];
        let at = 0;
        for (const piece of this.current) {
            starts.push(at);
            at += sizeOf(piece);
        }
        return (this.starts = starts);
    }
}

const added = (lines: readonly string[]): Piece => ({ kind: 'added', lines });

/** The part `[from, to)` of a piece, as zero or one piece. */
const slice = (piece: Piece, from: number, to: number): Piece[] => {
    if (to <= from) return [];
    return piece.kind === 'original'
        ? [{ kind: 'original', from: piece.from + from, count: to - from }]
        : [added(piece.lines.slice(from, to))];
};

/** Drops empty pieces and joins neighbours that continue one another. */
const normalize = (pieces: Piece[]): Piece[] => {
    const out: Piece[] = [];
    for (const piece of pieces) {
        if (sizeOf(piece) === 0) continue;
        const last = out[out.length - 1];
        if (
            last?.kind === 'original' &&
            piece.kind === 'original' &&
            last.from + last.count === piece.from
        ) {
            out[out.length - 1] = {
                kind: 'original',
                from: last.from,
                count: last.count + piece.count,
            };
        } else if (last?.kind === 'added' && piece.kind === 'added') {
            out[out.length - 1] = added([...last.lines, ...piece.lines]);
        } else {
            out.push(piece);
        }
    }
    return out;
};

const samePieces = (a: readonly Piece[], b: readonly Piece[]): boolean =>
    a.length === b.length &&
    a.every((piece, i) => {
        const other = b[i]!;
        if (piece.kind === 'original') {
            return (
                other.kind === 'original' &&
                other.from === piece.from &&
                other.count === piece.count
            );
        }
        return (
            other.kind === 'added' &&
            other.lines.length === piece.lines.length &&
            other.lines.every((line, k) => line === piece.lines[k])
        );
    });
