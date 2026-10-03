/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useEffect, useState } from 'react';
import { notifications } from '../../../kit';
import { useProfiles } from '../../db/profiles';
import { useDbManager } from '../../db/useDbManager';
import { useTabActions } from '../../tabs/useTabActions';
import { patchAdmin, useAdmin } from '../adminStore';
import { openAdminDialog } from '../dialogStore';

/** What an object editor needs from its tab: where it works and which engine it speaks. */
export function useEditorTab(id: string) {
    const tab = useAdmin((state) => state.tabs[id]);
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === tab?.profileId));
    return {
        tab,
        profile,
        engine: profile?.settings.engine ?? 'mysql',
        profileId: tab?.profileId ?? '',
    };
}

/**
 * Lists names from the server (databases, schemas, tables, triggers) for a form's selects. A
 * failure or a disconnected server gives an empty list; the form still works with typed names.
 */
export function useMetaNames(
    profileId: string,
    kind: 'databases' | 'schemas' | 'tables' | 'triggers' | 'columns',
    scope: { database?: string; schema?: string; name?: string } | null,
    pick: (item: Record<string, unknown>) => string | null = (item) =>
        typeof item.name === 'string' ? item.name : null,
): string[] {
    const { listMeta } = useDbManager();
    const [names, setNames] = useState<string[]>([]);
    const key = JSON.stringify(scope);
    useEffect(() => {
        let cancelled = false;
        if (!profileId || scope === null) {
            setNames([]);
            return;
        }
        void listMeta(profileId, kind, scope)
            .then((items) => {
                if (cancelled) return;
                setNames(
                    (items as Record<string, unknown>[])
                        .map(pick)
                        .filter((name): name is string => !!name),
                );
            })
            .catch(() => !cancelled && setNames([]));
        return () => {
            cancelled = true;
        };
        // `scope` is compared by value through `key`; `pick` is a fixed function per call site.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId, kind, key, listMeta]);
    return names;
}

/**
 * Saving an object: the statements are shown in the shared confirmation dialog and run there, one
 * at a time, so a failure names the statement that failed. When they succeed the explorer reloads
 * what is open, and the editor closes without asking about its (now applied) changes.
 */
export function useSaveObject(id: string, profileId: string) {
    const manager = useDbManager();
    const actions = useTabActions();

    const save = useCallback(
        (title: string, statements: string[], done: string, description?: string) => {
            openAdminDialog({
                kind: 'statements',
                title,
                description,
                statements,
                profileId,
                confirmLabel: 'Save',
                onDone: () => {
                    notifications.show({ color: 'teal', message: done });
                    patchAdmin(id, { dirty: false });
                    manager.refresh(profileId);
                    void actions.closeTabs([id]);
                },
            });
        },
        [id, profileId, manager, actions],
    );

    const cancel = useCallback(() => void actions.closeTabs([id]), [actions, id]);
    return { save, cancel };
}

/** The listed names, with the current value kept in the list when the server did not return it. */
export const withCurrent = (names: string[], current: string | undefined | null): string[] =>
    current && !names.includes(current) ? [current, ...names] : names;
