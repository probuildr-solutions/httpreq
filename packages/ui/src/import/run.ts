/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { importErrorMessage } from './errors';
import { isSupportedFile, MAX_IMPORT_BYTES, parseImportSource } from './sources';
import type { ImportFormat, ImportPlan } from './types';

/** A file chosen for import, from a file picker, a folder picker or a drop. */
export interface ImportSourceFile {
    /** Path relative to the chosen folder, or the file name. Unique within one import. */
    path: string;
    size: number;
    read: () => Promise<string>;
}

export type ImportStatus = 'imported' | 'skipped' | 'failed';

export interface ImportFileResult {
    path: string;
    status: ImportStatus;
    format?: ImportFormat;
    /** What was imported, or why the file was skipped or failed. */
    message: string;
    warnings: string[];
}

export interface ImportProgress {
    done: number;
    total: number;
    current: string | null;
}

/** Lets the browser paint between files, so the progress bar moves and the window stays live. */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Imports files one at a time. Each file is validated on its own: a broken or unsupported file is
 * reported and skipped over, and every valid file is still imported. `apply` merges one plan into
 * the workspace and describes what it added.
 */
export const importFiles = async (
    files: ImportSourceFile[],
    apply: (plan: ImportPlan) => string,
    onProgress: (progress: ImportProgress) => void,
    signal?: AbortSignal,
): Promise<ImportFileResult[]> => {
    const results: ImportFileResult[] = [];
    for (const [index, file] of files.entries()) {
        if (signal?.aborted) break;
        onProgress({ done: index, total: files.length, current: file.path });
        await yieldToUi();
        if (!isSupportedFile(file.path)) {
            results.push({
                path: file.path,
                status: 'skipped',
                message: 'Not a supported file type.',
                warnings: [],
            });
            continue;
        }
        if (file.size === 0) {
            results.push({
                path: file.path,
                status: 'skipped',
                message: 'The file is empty.',
                warnings: [],
            });
            continue;
        }
        if (file.size > MAX_IMPORT_BYTES) {
            results.push({
                path: file.path,
                status: 'failed',
                message: `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
                warnings: [],
            });
            continue;
        }
        try {
            const plan = parseImportSource(file.path, await file.read());
            const message = apply(plan);
            results.push({
                path: file.path,
                status: 'imported',
                format: plan.format,
                message,
                warnings: plan.warnings,
            });
        } catch (error) {
            results.push({
                path: file.path,
                status: 'failed',
                message: importErrorMessage(error),
                warnings: [],
            });
        }
    }
    onProgress({ done: results.length, total: files.length, current: null });
    return results;
};
