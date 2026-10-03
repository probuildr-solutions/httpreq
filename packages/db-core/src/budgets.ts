/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/**
 * Every memory and size limit of the large-file machinery, in one place.
 *
 * These are architectural constants, not tuning knobs: the benchmarks and the memory tests assert
 * against them, so changing one is a deliberate act that shows up in review (see
 * docs/database-studio.md, "Memory budget").
 */
export const STUDIO_BUDGETS = {
    /** Size of one read from disk. */
    chunkBytes: MIB,
    /** Chunks a single sequential scan may hold at once (one being scanned, one being read). */
    maxChunksInFlight: 2,
    /** One checkpoint (the byte offset of a line start) per this many lines. */
    lineCheckpointInterval: 4096,
    /** A longer line is cut when displayed; the full line stays on disk. */
    maxLineBytes: 64 * KIB,
    /** Most lines one `readLines` call returns. */
    maxLinesPerRead: 1000,
    /** Most text one `readLines` call returns, across all its lines. */
    maxReadResponseBytes: 4 * MIB,
    /** Lines per cached page. */
    linePageSize: 128,
    /** Decoded line pages kept per open file. */
    linePageCacheBytes: 32 * MIB,
    /** Files one host keeps open at a time. */
    maxOpenFiles: 32,
    /** Total size of the on-disk index cache before the oldest entries are evicted. */
    maxIndexCacheBytes: 2 * GIB,
    /** V8 old-space limit for the file host process. */
    fileHostHeapMb: 512,
    /** Files up to this size are edited as a whole in the full editor; larger ones a line at a time. */
    maxFullEditBytes: 64 * MIB,
    /** Most of one statement or document a single read returns to the UI. */
    maxItemReadBytes: MIB,
    /** Longest statement or document the executors will buffer (later phases). */
    maxSingleItemBytes: 64 * MIB,
} as const;
