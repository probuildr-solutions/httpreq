/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import { useStudioStore } from '../studioStore';

/**
 * The tabs that administer a database object instead of editing text: a table's rows, a table's
 * structure, a relationship diagram, a collection's documents, an object's indexes or triggers.
 * They share the tab strip with query and file tabs; what each one shows is its own component's
 * business, kept in `state` so switching tabs does not lose a filter, a draft design or a scroll.
 */
export type AdminKind = 'table' | 'design' | 'er' | 'documents' | 'indexes' | 'triggers';

export interface AdminTab {
    /** `a` followed by 16 hex characters. */
    id: string;
    kind: AdminKind;
    title: string;
    profileId: string;
    database?: string;
    schema?: string;
    /** The table or collection the tab is about; absent for a diagram of a whole schema. */
    name?: string;
    /** Unapplied changes: a design that differs from the server, a document being edited. */
    dirty: boolean;
    /** Feature state that must survive switching tabs. */
    state: Record<string, unknown>;
}

interface AdminState {
    tabs: Record<string, AdminTab>;
}

export const useAdmin = create<AdminState>(() => ({ tabs: {} }));

export const resetAdmin = () => useAdmin.setState({ tabs: {} });

export const isAdminTabId = (id: string): boolean => /^a[0-9a-f]{16}$/.test(id);

const newId = (): string =>
    `a${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const patchAdmin = (
    id: string,
    patch: Partial<AdminTab> | ((tab: AdminTab) => Partial<AdminTab>),
) =>
    useAdmin.setState((state) => {
        const tab = state.tabs[id];
        if (!tab) return state;
        const changes = typeof patch === 'function' ? patch(tab) : patch;
        return { tabs: { ...state.tabs, [id]: { ...tab, ...changes } } };
    });

export type AdminTabSpec = Pick<AdminTab, 'kind' | 'title' | 'profileId'> &
    Partial<Pick<AdminTab, 'database' | 'schema' | 'name' | 'state'>>;

const sameTarget = (tab: AdminTab, spec: AdminTabSpec) =>
    tab.kind === spec.kind &&
    tab.profileId === spec.profileId &&
    (tab.database ?? '') === (spec.database ?? '') &&
    (tab.schema ?? '') === (spec.schema ?? '') &&
    (tab.name ?? '') === (spec.name ?? '');

/**
 * Opens an admin tab and makes it the active one. A tab for the same object and kind that is
 * already open is reused (its state kept), unless `fresh` asks for another.
 */
export const openAdminTab = (spec: AdminTabSpec, options: { fresh?: boolean } = {}): string => {
    const existing = options.fresh
        ? undefined
        : Object.values(useAdmin.getState().tabs).find((tab) => sameTarget(tab, spec));
    const id = existing?.id ?? newId();
    if (!existing) {
        useAdmin.setState((state) => ({
            tabs: { ...state.tabs, [id]: { ...spec, id, dirty: false, state: spec.state ?? {} } },
        }));
    }
    useStudioStore.setState((state) => ({
        order: state.order.includes(id) ? state.order : [...state.order, id],
        activeId: id,
    }));
    return id;
};

export const closeAdminTabNow = (id: string) =>
    useAdmin.setState((state) => {
        const tabs = { ...state.tabs };
        delete tabs[id];
        return { tabs };
    });
