/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { HttpMethod, TreeNodeKind } from '@httpreq/shared';

/**
 * The text colour of each HTTP verb. The class names are spelled out in full so Tailwind can see
 * them; the colours themselves are the `--color-method-*` tokens, which adapt to dark mode.
 */
export const methodText: Record<HttpMethod, string> = {
    GET: 'text-method-get',
    POST: 'text-method-post',
    PUT: 'text-method-put',
    PATCH: 'text-method-patch',
    DELETE: 'text-method-delete',
    HEAD: 'text-method-head',
    OPTIONS: 'text-method-options',
};

/** WebSocket requests are labelled with one colour, as HTTP verbs are. */
export const WEBSOCKET_TEXT = 'text-primary-text';

/** Tree nodes that open in a tab rather than containing other nodes. */
export const isLeafRow = (kind: TreeNodeKind) => kind === 'request' || kind === 'websocket';

/** The single tab panel that shows the active request; every request tab controls it. */
export const REQUEST_PANEL_ID = 'request-panel';
export const requestTabId = (id: string) => `request-tab-${id}`;
