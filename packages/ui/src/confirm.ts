/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel: string;
    /** Adds a third choice (e.g. "Don't save") between Cancel and the confirm action. */
    alternateLabel?: string;
    danger?: boolean;
}

export type ConfirmResult = 'confirm' | 'alternate' | 'cancel';

interface ConfirmState {
    request: (ConfirmOptions & { resolve: (result: ConfirmResult) => void }) | null;
}

/** The confirmation currently waiting for an answer, if any. */
export const useConfirmStore = create<ConfirmState>(() => ({ request: null }));

/** Opens the app's confirmation dialog and resolves with the user's choice. */
export const confirmAction = (options: ConfirmOptions) =>
    new Promise<ConfirmResult>((resolve) => {
        useConfirmStore.getState().request?.resolve('cancel');
        useConfirmStore.setState({ request: { ...options, resolve } });
    });

/** Answers the pending confirmation and closes the dialog. */
export const settleConfirm = (result: ConfirmResult) => {
    const { request } = useConfirmStore.getState();
    if (!request) return;
    useConfirmStore.setState({ request: null });
    request.resolve(result);
};
