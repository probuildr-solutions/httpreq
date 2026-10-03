/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';

interface DialogState {
    /** `'new'`, a profile id, or null when closed. */
    target: string | null;
    open: (target: string) => void;
    close: () => void;
}

export const useConnectionDialog = create<DialogState>((set) => ({
    target: null,
    open: (target) => set({ target }),
    close: () => set({ target: null }),
}));

export const openConnectionDialog = (target: string = 'new') =>
    useConnectionDialog.getState().open(target);
