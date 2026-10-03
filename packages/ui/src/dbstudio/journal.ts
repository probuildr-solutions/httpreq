/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbLineEnding, DbSavePiece } from '@httpreq/shared';

/**
 * Unsaved work, kept so a crash or a reload does not lose it.
 *
 * Only what the user typed is stored, never the file: an edit to a 3 GB file is a few pieces that
 * refer to its lines plus the lines added. The journal is tied to the file's size and modification
 * time, so it is offered only for the file it was made for, and is dropped when the file changed.
 *
 * It lives in this browser's local storage, which is small, so a journal over the limit is not
 * written (the caller says so) rather than half-written. Every access is guarded: storage can be
 * missing, full or blocked.
 */

export type Journal =
    | {
          version: 1;
          kind: 'pieces';
          size: number;
          mtimeMs: number;
          eol: DbLineEnding;
          pieces: DbSavePiece[];
      }
    | { version: 1; kind: 'text'; size: number; mtimeMs: number; eol: DbLineEnding; text: string };

/** Largest journal written, in characters. */
export const MAX_JOURNAL_CHARS = 3_000_000;

const keyOf = (fileKey: string) => `httpreq.dbstudio.journal.${fileKey}`;

const storage = (): Storage | null => {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
};

/** Whether the journal was written. `false` when it is too large or storage is unavailable. */
export const writeJournal = (fileKey: string, journal: Journal): boolean => {
    const store = storage();
    if (!store) return false;
    try {
        const serialized = JSON.stringify(journal);
        if (serialized.length > MAX_JOURNAL_CHARS) {
            store.removeItem(keyOf(fileKey));
            return false;
        }
        store.setItem(keyOf(fileKey), serialized);
        return true;
    } catch {
        return false;
    }
};

const isPiece = (value: unknown): value is DbSavePiece => {
    if (!value || typeof value !== 'object') return false;
    const piece = value as Record<string, unknown>;
    if (piece.kind === 'original') {
        return Number.isInteger(piece.from) && Number.isInteger(piece.count);
    }
    return (
        piece.kind === 'added' &&
        Array.isArray(piece.lines) &&
        piece.lines.every((line) => typeof line === 'string')
    );
};

/** The saved work for a file, if it was made for the file as it is now. */
export const readJournal = (
    fileKey: string,
    file: { size: number; mtimeMs: number },
): Journal | null => {
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(keyOf(fileKey));
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<Journal> & Record<string, unknown>;
        const current =
            value.version === 1 &&
            value.size === file.size &&
            value.mtimeMs === file.mtimeMs &&
            (value.eol === '\n' || value.eol === '\r\n');
        const valid =
            current &&
            ((value.kind === 'text' && typeof value.text === 'string') ||
                (value.kind === 'pieces' &&
                    Array.isArray(value.pieces) &&
                    value.pieces.every(isPiece)));
        if (!valid) {
            store.removeItem(keyOf(fileKey));
            return null;
        }
        return value as Journal;
    } catch {
        return null;
    }
};

export const clearJournal = (fileKey: string): void => {
    try {
        storage()?.removeItem(keyOf(fileKey));
    } catch {
        // Nothing to clear if storage is unavailable.
    }
};
