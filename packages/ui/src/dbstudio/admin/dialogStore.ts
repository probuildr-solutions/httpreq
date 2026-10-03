/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type { ExplorerRow } from '../db/explorerRows';

/**
 * The dialogs the explorer's menus open. The menus live deep in the tree, the dialogs are drawn
 * once at the top of the panel, and this store is the one place between them, so a menu item is a
 * function call instead of a piece of state threaded through every row.
 */
export type AdminDialog =
    | {
          kind: 'statements';
          title: string;
          description?: string;
          statements: string[];
          profileId: string;
          confirmLabel?: string;
          danger?: boolean;
          /** Runs after the statements succeeded (the explorer is refreshed first). */
          onDone?: () => void;
      }
    | { kind: 'routine'; row: ExplorerRow }
    | {
          kind: 'export';
          profileId: string;
          source:
              | { kind: 'table'; database?: string; schema?: string; name: string }
              | { kind: 'query'; text: string; label?: string };
      }
    | {
          kind: 'import';
          profileId: string | null;
          target?: { database?: string; schema?: string; name: string };
          /** A file already chosen (from the Open file dialog). */
          file?: { token: string; name: string; size: number };
      }
    | {
          kind: 'script';
          profileId: string | null;
          file: { token: string; name: string; size: number };
      }
    | {
          kind: 'prompt';
          title: string;
          label: string;
          initial?: string;
          confirmLabel?: string;
          /** An error message for a value that cannot be used, or null. */
          validate?: (value: string) => string | null;
          onSubmit: (value: string) => void;
      };

interface State {
    dialog: AdminDialog | null;
}

export const useAdminDialog = create<State>(() => ({ dialog: null }));

export const openAdminDialog = (dialog: AdminDialog) => useAdminDialog.setState({ dialog });
export const closeAdminDialog = () => useAdminDialog.setState({ dialog: null });
