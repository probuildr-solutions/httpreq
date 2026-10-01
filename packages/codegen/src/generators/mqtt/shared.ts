/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { MqttCodegenRequest, MqttPublishInput } from '@httpreq/shared';
import { jsDialect, pythonDialect } from '../../core/dialects';

/** The broker URL taken apart: what each client needs separately. */
export const mqttParts = (request: MqttCodegenRequest) => {
    const url = new URL(request.url);
    const scheme = url.protocol.replace(/:$/, '');
    return {
        scheme,
        host: url.hostname,
        port: url.port,
        path: url.pathname === '/' ? '' : url.pathname,
        secure: scheme === 'mqtts' || scheme === 'wss',
        websocket: scheme === 'ws' || scheme === 'wss',
    };
};

export const MQTT_VERSION_NAMES = { 3: 'MQTTv31', 4: 'MQTTv311', 5: 'MQTTv5' } as const;
export const MOSQUITTO_VERSIONS = { 3: 'mqttv31', 4: 'mqttv311', 5: 'mqttv5' } as const;

/** Hex payloads are sent as bytes; everything else as the text typed. */
export const payloadIsHex = (publish: MqttPublishInput) => publish.format === 'hex';
export const hexDigits = (payload: string) => payload.replace(/[\s:]/g, '');

/** The publish payload as an expression in JavaScript or Python. */
export const payloadExpression = (publish: MqttPublishInput, language: 'js' | 'python') =>
    payloadIsHex(publish)
        ? language === 'js'
            ? `Buffer.from(${jsDialect.literal(hexDigits(publish.payload))}, "hex")`
            : `bytes.fromhex(${pythonDialect.literal(hexDigits(publish.payload))})`
        : (language === 'js' ? jsDialect : pythonDialect).literal(publish.payload);
