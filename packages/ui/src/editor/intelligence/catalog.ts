/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { VariableResolver } from '@httpreq/api-client';

/**
 * What the editors know about the workspace, for suggestions: the variables of the active
 * environment and the JSON property names the other requests use. Monaco's providers are
 * registered once for the whole page, not per editor, so they cannot read React state; the app
 * root publishes it here instead and the providers read the latest when they are asked.
 */

type Listener = () => void;

let resolver: VariableResolver | null = null;
let jsonKeys: readonly string[] = [];
const listeners = new Set<Listener>();

const notify = () => listeners.forEach((listener) => listener());

export const editorCatalog = {
    variables: (): VariableResolver | null => resolver,
    jsonKeys: (): readonly string[] => jsonKeys,

    setVariables(next: VariableResolver | null): void {
        if (next === resolver) return;
        resolver = next;
        notify();
    },

    setJsonKeys(next: readonly string[]): void {
        if (next === jsonKeys) return;
        jsonKeys = next;
        notify();
    },

    /** Called when the catalog changes, e.g. to redraw variable highlighting. Returns the unsubscribe. */
    subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
