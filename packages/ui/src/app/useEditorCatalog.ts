/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect } from 'react';
import type { VariableResolver } from '@httpreq/api-client';
import type { HttpRequest } from '@httpreq/shared';
import { editorCatalog } from '../editor/intelligence/catalog';
import { collectJsonKeys } from '../editor/intelligence/jsonKeys';

/** Reading every JSON body is cheap, but not worth doing on the render that triggered it. */
const KEY_SCAN_DELAY_MS = 400;

/**
 * Publishes what the editors suggest from: the variables of the active environment and the JSON
 * property names the workspace's requests use. Monaco's providers are page-wide and cannot read
 * React state, so the app root keeps the catalog current and they read it when asked.
 */
export function useEditorCatalog(
    resolver: VariableResolver,
    requests: readonly HttpRequest[],
): void {
    useEffect(() => {
        editorCatalog.setVariables(resolver);
        return () => editorCatalog.setVariables(null);
    }, [resolver]);

    useEffect(() => {
        const timer = setTimeout(
            () => editorCatalog.setJsonKeys(collectJsonKeys(requests)),
            KEY_SCAN_DELAY_MS,
        );
        return () => clearTimeout(timer);
    }, [requests]);
}
