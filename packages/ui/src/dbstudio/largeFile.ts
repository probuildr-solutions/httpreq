/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * How a file is opened, decided from its size alone (read from the file's metadata, never from its
 * contents), and the limits that decide it. The limits are configuration, not constants buried in
 * an editor component:
 *
 *     size ≤ normalMaxBytes         open in the editor normally
 *     size ≤ monacoMaxBytes         open in the editor in Large File Mode (reduced features)
 *     above                         not loaded into an editor: stream it (viewer, execute, import)
 *
 * The defaults are conservative on purpose. Monaco keeps the whole text in the renderer process,
 * with a tokenizer, an undo stack and a piece tree per model, so its cost is a multiple of the file's
 * size. `bench/monaco-large` measures it so the limit can be set from numbers; until a limit has been
 * measured on a machine it is not raised above what the file host will hand to a window at once.
 */
export interface LargeFileLimits {
    /** Up to this size the editor opens a file with every feature on. */
    normalMaxBytes: number;
    /** Up to this size the editor opens it with the expensive features off. */
    monacoMaxBytes: number;
}

const MIB = 1024 * 1024;

/** What the host will return from one read of a whole file's text: the hard ceiling of `monacoMaxBytes`. */
export const HOST_TEXT_CEILING_BYTES = 64 * MIB;

export const DEFAULT_LIMITS: LargeFileLimits = {
    normalMaxBytes: 4 * MIB,
    monacoMaxBytes: 32 * MIB,
};

const KEY = 'httpreq.dbstudio.largeFileLimits';

const sanitize = (value: Partial<LargeFileLimits> | null | undefined): LargeFileLimits => {
    const monaco = Math.min(
        HOST_TEXT_CEILING_BYTES,
        Math.max(MIB, Math.floor(value?.monacoMaxBytes ?? DEFAULT_LIMITS.monacoMaxBytes)),
    );
    const normal = Math.min(
        monaco,
        Math.max(64 * 1024, Math.floor(value?.normalMaxBytes ?? DEFAULT_LIMITS.normalMaxBytes)),
    );
    return { normalMaxBytes: normal, monacoMaxBytes: monaco };
};

let current: LargeFileLimits | null = null;

/** The limits in force: the saved ones, else the defaults. */
export const largeFileLimits = (): LargeFileLimits => {
    if (current) return current;
    let saved: Partial<LargeFileLimits> | null = null;
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        saved = raw ? (JSON.parse(raw) as Partial<LargeFileLimits>) : null;
    } catch {
        saved = null;
    }
    current = sanitize(saved);
    return current;
};

/** Changes the limits (clamped to what is safe) and remembers them. */
export const setLargeFileLimits = (limits: Partial<LargeFileLimits>): LargeFileLimits => {
    current = sanitize({ ...largeFileLimits(), ...limits });
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
    } catch {
        // The limits still apply for this session.
    }
    return current;
};

export const resetLargeFileLimits = () => {
    current = null;
    try {
        globalThis.localStorage?.removeItem(KEY);
    } catch {
        // Nothing to remove.
    }
};

export type FileHandling = 'editor' | 'large-file-mode' | 'stream';

/** Decides how a file of this size is handled. Looks at the number only. */
export const handlingFor = (
    sizeBytes: number,
    limits: LargeFileLimits = largeFileLimits(),
): FileHandling =>
    sizeBytes <= limits.normalMaxBytes
        ? 'editor'
        : sizeBytes <= limits.monacoMaxBytes
          ? 'large-file-mode'
          : 'stream';
