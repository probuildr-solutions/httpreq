/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { MqttCodegenRequest } from '@httpreq/shared';
import { defineProtocolGenerator } from '../../core/define';
import { jsDialect } from '../../core/dialects';
import { mqttParts, payloadExpression } from './shared';

const str = jsDialect.literal;

export const nodeMqttGenerator = defineProtocolGenerator<MqttCodegenRequest>({
    protocol: 'mqtt',
    id: 'node-mqtt',
    label: 'Node.js – mqtt',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    fileExtension: 'mjs',
    requirements: 'Node.js 20+, mqtt',
    render(request, out) {
        const url = mqttParts(request);
        const { publish } = request;
        const readsFiles =
            url.secure && (request.caCertificateFile || request.clientCertificateFile);
        out.line('import mqtt from "mqtt";');
        if (readsFiles) out.line('import fs from "node:fs";');
        out.blank();

        out.block(`const client = mqtt.connect(${str(request.url)}, {`, '});', () => {
            out.line(`clientId: ${str(request.clientId)},`);
            if (request.username) out.line(`username: ${str(request.username)},`);
            if (request.password) out.line(`password: ${str(request.password)},`);
            out.line(`protocolVersion: ${request.protocolVersion},`);
            out.line(`keepalive: ${request.keepAliveSeconds},`);
            out.line(`clean: ${request.cleanSession},`);
            if (url.secure && !request.verifyTls) out.line('rejectUnauthorized: false,');
            if (url.secure && request.caCertificateFile) {
                out.line(`ca: fs.readFileSync(${str(request.caCertificateFile)}),`);
            }
            if (url.secure && request.clientCertificateFile) {
                out.line(`cert: fs.readFileSync(${str(request.clientCertificateFile)}),`);
            }
            if (url.secure && request.clientKeyFile) {
                out.line(`key: fs.readFileSync(${str(request.clientKeyFile)}),`);
            }
        });
        out.blank();

        out.block('client.on("connect", () => {', '});', () => {
            request.subscriptions.forEach((sub) =>
                out.line(
                    `client.subscribe(${str(sub.topic)}, { qos: ${sub.qos} }, (error) => error && console.error(error));`,
                ),
            );
            if (publish) {
                out.line(
                    `client.publish(${str(publish.topic)}, ${payloadExpression(publish, 'js')}, { qos: ${publish.qos}, retain: ${publish.retain} });`,
                );
                // Nothing to receive: close once the message is on its way.
                if (request.subscriptions.length === 0) {
                    out.line('setTimeout(() => client.end(), 500);');
                }
            }
        });
        out.blank();
        out.block('client.on("message", (topic, message) => {', '});', () =>
            out.line('console.log(topic, message.toString());'),
        );
        out.line('client.on("error", (error) => console.error(error));');
    },
});
