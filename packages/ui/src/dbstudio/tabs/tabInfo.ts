/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useMemo } from 'react';
import { type AdminKind, useAdmin } from '../admin/adminStore';
import { useProfiles } from '../db/profiles';
import { isQueryDirty, useQueries } from '../db/queryStore';
import { isDirty, useStudioStore } from '../studioStore';
import { useTabMeta } from './tabMetaStore';

export type TabKind = 'query' | 'file' | AdminKind;

/** What the tab strip needs to draw a tab, whatever kind of tab it is. */
export interface TabInfo {
    id: string;
    kind: TabKind;
    title: string;
    /** The connection, database and schema it works on, as one line. */
    subtitle: string;
    dirty: boolean;
    pinned: boolean;
    /** The file the tab was opened from or saved to, when it has one. */
    fileName?: string;
}

/** `Connection › database › schema`, leaving out what the tab has not chosen. */
export const contextLine = (...parts: (string | null | undefined)[]): string =>
    parts.filter((part): part is string => !!part).join(' › ');

/** All open tabs in strip order, each described the same way. */
export const useTabInfos = (): TabInfo[] => {
    const order = useStudioStore((state) => state.order);
    const files = useStudioStore((state) => state.tabs);
    const queries = useQueries((state) => state.tabs);
    const admin = useAdmin((state) => state.tabs);
    const profiles = useProfiles((state) => state.profiles);
    const meta = useTabMeta((state) => state.meta);

    return useMemo(() => {
        const infos: TabInfo[] = [];
        const profileName = (id: string | null) => profiles.find((p) => p.id === id)?.name;
        for (const id of order) {
            const pinned = meta[id]?.pinned === true;
            const custom = meta[id]?.customTitle;
            const query = queries[id];
            const adminTab = admin[id];
            const file = files[id];
            if (query) {
                infos.push({
                    id,
                    kind: 'query',
                    title: query.title,
                    subtitle: contextLine(
                        profileName(query.profileId),
                        query.database,
                        query.schema,
                    ),
                    dirty: isQueryDirty(query),
                    pinned,
                    fileName: query.source?.name,
                });
            } else if (adminTab) {
                infos.push({
                    id,
                    kind: adminTab.kind,
                    title: adminTab.title,
                    subtitle: contextLine(
                        profileName(adminTab.profileId),
                        adminTab.database,
                        adminTab.schema,
                    ),
                    dirty: adminTab.dirty,
                    pinned,
                });
            } else if (file) {
                infos.push({
                    id,
                    kind: 'file',
                    title: custom ?? file.file.name,
                    subtitle: '',
                    dirty: isDirty(file),
                    pinned,
                    fileName: file.file.name,
                });
            }
        }
        return infos;
    }, [order, files, queries, admin, profiles, meta]);
};
