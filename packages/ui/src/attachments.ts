/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createId, type FileReference } from '@httpreq/shared';

/**
 * Files chosen for binary and multipart bodies. Requests store only a `FileReference`; the bytes
 * stay in memory for this session and are never written to workspace storage.
 */
const files = new Map<string, File>();

/** Keeps a chosen file in memory for this session and returns the reference that is saved with the
 * request. The bytes are never written to storage.
 */
export const rememberFile = (file: File): FileReference => {
    const reference: FileReference = {
        id: createId(),
        name: file.name,
        size: file.size,
        type: file.type,
    };
    files.set(reference.id, file);
    return reference;
};

/** Whether the file behind a reference is still available; it is gone after a restart. */
export const hasAttachment = (reference: FileReference | null | undefined) =>
    !!reference && files.has(reference.id);

/** The bytes of a remembered file, or undefined when it was not selected in this session. */
export const readAttachment = async (reference: FileReference): Promise<Uint8Array | undefined> => {
    const file = files.get(reference.id);
    return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
};

export const formatBytes = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
