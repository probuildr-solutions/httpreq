/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type { ExportFormat, ExportTarget } from './formats';

interface ExportDialogState {
    opened: boolean;
    /** Kept after closing, so the dialog does not go blank while it fades out. */
    target: ExportTarget | null;
    /** The last format chosen, offered again next time. */
    format: ExportFormat;
}

export const useExportDialog = create<ExportDialogState>(() => ({
    opened: false,
    target: null,
    format: 'postman',
}));

/** Opens the Export dialog for a collection or a request, from anywhere in the app. */
export const openExportDialog = (target: ExportTarget) =>
    useExportDialog.setState({ opened: true, target });

export const closeExportDialog = () => useExportDialog.setState({ opened: false });

export const setExportFormat = (format: ExportFormat) => useExportDialog.setState({ format });
