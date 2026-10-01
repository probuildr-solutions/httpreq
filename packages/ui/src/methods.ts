/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { PROTOCOLS, type HttpMethod, type ProtocolId, type TreeNodeKind } from '@httpreq/shared';

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

/** Colours of the non-HTTP protocol badges, reusing the verb tokens so dark mode already works. */
const PROTOCOL_TEXT: Record<Exclude<ProtocolId, 'http'>, string> = {
    soap: 'text-method-patch',
    grpc: 'text-method-put',
    mqtt: 'text-method-options',
};

/** The badge of a request: its protocol for SOAP, gRPC and MQTT, its verb for HTTP. */
export const requestBadge = (
    method: HttpMethod | undefined,
    protocol?: ProtocolId,
): { label: string; color: string } => {
    if (protocol && protocol !== 'http') {
        return { label: PROTOCOLS[protocol].badge, color: PROTOCOL_TEXT[protocol] };
    }
    const verb = method ?? 'GET';
    return {
        label: verb === 'DELETE' ? 'DEL' : verb === 'OPTIONS' ? 'OPT' : verb,
        color: methodText[verb],
    };
};
