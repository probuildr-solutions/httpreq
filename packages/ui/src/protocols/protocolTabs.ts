/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createGrpcConfig,
    createMqttConfig,
    createSoapConfig,
    type HttpRequest,
    type ProtocolId,
} from '@httpreq/shared';
import type { EditorTab } from '../store';

/**
 * What the editor shows for each protocol, as data: which tabs exist and which opens first. The
 * editor reads this table instead of branching on the protocol, so a new protocol is a new row
 * and a panel, not another `if` in the editor.
 */
export interface ProtocolView {
    tabs: readonly EditorTab[];
    defaultTab: EditorTab;
    /** Label of the protocol-specific tab. */
    protocolTabLabel: string;
    /** Whether Send applies; session protocols connect instead. */
    sends: boolean;
    /** Whether the request pane is shown beside a response pane. */
    hasResponsePane: boolean;
}

export const PROTOCOL_VIEWS: Record<ProtocolId, ProtocolView> = {
    http: {
        tabs: [
            'overview',
            'params',
            'body',
            'headers',
            'authorization',
            'scripts',
            'code',
            'sharing',
            'settings',
        ],
        defaultTab: 'params',
        protocolTabLabel: '',
        sends: true,
        hasResponsePane: true,
    },
    soap: {
        tabs: [
            'protocol',
            'headers',
            'params',
            'authorization',
            'scripts',
            'code',
            'overview',
            'settings',
        ],
        defaultTab: 'protocol',
        protocolTabLabel: 'SOAP',
        sends: true,
        hasResponsePane: true,
    },
    grpc: {
        tabs: ['protocol', 'headers', 'authorization', 'scripts', 'code', 'overview', 'settings'],
        defaultTab: 'protocol',
        protocolTabLabel: 'gRPC',
        sends: true,
        hasResponsePane: true,
    },
    mqtt: {
        tabs: ['protocol', 'authorization', 'code', 'overview'],
        defaultTab: 'protocol',
        protocolTabLabel: 'MQTT',
        sends: false,
        hasResponsePane: false,
    },
};

/** The tab to show: the remembered one if this protocol has it, else the protocol's first. */
export const effectiveTab = (
    protocol: ProtocolId,
    remembered: EditorTab | undefined,
): EditorTab => {
    const view = PROTOCOL_VIEWS[protocol];
    return remembered && view.tabs.includes(remembered) ? remembered : view.defaultTab;
};

/**
 * The edit that moves a request to another protocol. Nothing the user typed is discarded: each
 * protocol's configuration is kept while the request is on another one, so switching back
 * restores it. Only what the new protocol requires is adjusted (its verb and body kind).
 */
export const protocolPatch = (request: HttpRequest, protocol: ProtocolId): Partial<HttpRequest> => {
    switch (protocol) {
        case 'http':
            return { protocol: undefined };
        case 'soap':
            return {
                protocol: 'soap',
                soap: request.soap ?? createSoapConfig(),
                method: 'POST',
                body: { ...request.body, mode: 'text', textContentType: 'application/xml' },
            };
        case 'grpc':
            return {
                protocol: 'grpc',
                grpc: request.grpc ?? createGrpcConfig(),
                method: 'POST',
                body: { ...request.body, mode: 'json' },
            };
        case 'mqtt':
            return {
                protocol: 'mqtt',
                mqtt: request.mqtt ?? createMqttConfig(),
                method: 'POST',
                body: { ...request.body, mode: 'text' },
            };
    }
};
