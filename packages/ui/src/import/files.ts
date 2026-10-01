/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ImportSourceFile } from './run';

/** Folders that never hold import sources and can be huge: version control and dependencies. */
const IGNORED_SEGMENT = /^(\.git|\.svn|\.hg|node_modules|\.idea|\.vscode)$/;

const ignored = (path: string) =>
    path
        .split('/')
        .slice(0, -1)
        .some((segment) => IGNORED_SEGMENT.test(segment));

const fromFile = (file: File, path: string): ImportSourceFile => ({
    path,
    size: file.size,
    read: () => file.text(),
});

/** Files from an `<input type="file">`, keeping each file's path inside a chosen folder. */
export const sourcesFromFileList = (list: FileList | File[] | null): ImportSourceFile[] =>
    Array.from(list ?? [])
        .map((file) => fromFile(file, file.webkitRelativePath || file.name))
        .filter((file) => !ignored(file.path));

const readEntries = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

const fileOf = (entry: FileSystemFileEntry) =>
    new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** Walks a dropped folder; `readEntries` returns entries in batches until it returns none. */
const walk = async (entry: FileSystemEntry, into: ImportSourceFile[]) => {
    const path = entry.fullPath.replace(/^\//, '');
    if (entry.isFile) {
        if (!ignored(path)) into.push(fromFile(await fileOf(entry as FileSystemFileEntry), path));
        return;
    }
    if (!entry.isDirectory || IGNORED_SEGMENT.test(entry.name)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
        for (const child of batch) await walk(child, into);
    }
};

/** Files and whole folders dropped onto the dialog. */
export const sourcesFromDrop = async (transfer: DataTransfer): Promise<ImportSourceFile[]> => {
    const entries = Array.from(transfer.items)
        .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
        .filter((entry): entry is FileSystemEntry => !!entry);
    if (!entries.length) return sourcesFromFileList(transfer.files);
    const files: ImportSourceFile[] = [];
    for (const entry of entries) await walk(entry, files);
    return files;
};

/** Adds newly chosen files, ignoring any path that is already in the list. */
export const mergeSources = (current: ImportSourceFile[], added: ImportSourceFile[]) => {
    const paths = new Set(current.map((file) => file.path));
    return [...current, ...added.filter((file) => !paths.has(file.path) && paths.add(file.path))];
};
