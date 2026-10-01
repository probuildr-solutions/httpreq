/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { MqttCodegenRequest } from '@httpreq/shared';
import { defineProtocolGenerator } from '../../core/define';
import { shellDialect } from '../../core/dialects';
import { UnsupportedCombination } from '../../errors';
import { MOSQUITTO_VERSIONS, hexDigits, mqttParts, payloadIsHex } from './shared';

const quote = shellDialect.literal;

/** One mosquitto command, its options one per continuation line. */
const command = (name: string, options: string[]) =>
    [name, ...options.map((option) => `  ${option}`)].join(' \\\n');

export const mosquittoGenerator = defineProtocolGenerator<MqttCodegenRequest>({
    protocol: 'mqtt',
    id: 'mosquitto',
    label: 'Mosquitto clients',
    language: 'Shell',
    editorLanguage: 'shell',
    fileExtension: 'sh',
    render(request, out) {
        const url = mqttParts(request);
        if (url.websocket) {
            throw new UnsupportedCombination(
                'The Mosquitto command-line clients do not speak MQTT over WebSockets. Use the Node.js or Python generator.',
            );
        }
        const common = [
            `-h ${quote(url.host)}`,
            `-p ${url.port}`,
            `-i ${quote(request.clientId)}`,
            `-V ${MOSQUITTO_VERSIONS[request.protocolVersion]}`,
            `-k ${request.keepAliveSeconds}`,
            request.username && `-u ${quote(request.username)}`,
            request.password && `-P ${quote(request.password)}`,
            url.secure &&
                request.caCertificateFile &&
                `--cafile ${quote(request.caCertificateFile)}`,
            url.secure &&
                request.clientCertificateFile &&
                `--cert ${quote(request.clientCertificateFile)}`,
            url.secure && request.clientKeyFile && `--key ${quote(request.clientKeyFile)}`,
            url.secure && !request.verifyTls && '--insecure',
            !request.cleanSession && '-c',
        ].filter((part): part is string => !!part);

        const subscribe =
            request.subscriptions.length > 0 &&
            command('mosquitto_sub', [
                ...common,
                ...request.subscriptions.map((sub) => `-t ${quote(sub.topic)} -q ${sub.qos}`),
                '-v',
            ]);
        const { publish } = request;
        const publishCommand =
            publish &&
            command(
                `${payloadIsHex(publish) ? `printf '%s' ${quote(hexDigits(publish.payload))} | xxd -r -p | ` : ''}mosquitto_pub`,
                [
                    ...common,
                    `-t ${quote(publish.topic)}`,
                    `-q ${publish.qos}`,
                    ...(publish.retain ? ['-r'] : []),
                    payloadIsHex(publish) ? '-s' : `-m ${quote(publish.payload)}`,
                ],
            );
        if (!subscribe && !publishCommand) {
            throw new UnsupportedCombination('Add a subscription or a publish topic first.');
        }
        if (subscribe) out.line(subscribe);
        if (subscribe && publishCommand) out.blank();
        if (publishCommand) out.line(publishCommand);
    },
});
