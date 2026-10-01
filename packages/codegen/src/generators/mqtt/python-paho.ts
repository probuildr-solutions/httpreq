/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { MqttCodegenRequest } from '@httpreq/shared';
import { defineProtocolGenerator } from '../../core/define';
import { pythonDialect } from '../../core/dialects';
import { MQTT_VERSION_NAMES, mqttParts, payloadExpression } from './shared';

const str = pythonDialect.literal;

export const pythonPahoGenerator = defineProtocolGenerator<MqttCodegenRequest>({
    protocol: 'mqtt',
    id: 'python-paho',
    label: 'Python – paho-mqtt',
    language: 'Python',
    editorLanguage: 'python',
    fileExtension: 'py',
    requirements: 'Python 3, paho-mqtt 2.x',
    render(request, out) {
        const url = mqttParts(request);
        const { publish } = request;
        const port = url.port || (url.secure ? '8883' : '1883');
        out.line('import paho.mqtt.client as mqtt').blank();

        out.block('client = mqtt.Client(', ')', () => {
            out.line('mqtt.CallbackAPIVersion.VERSION2,');
            out.line(`client_id=${str(request.clientId)},`);
            out.line(`protocol=mqtt.${MQTT_VERSION_NAMES[request.protocolVersion]},`);
            if (url.websocket) out.line('transport="websockets",');
        });
        if (request.username || request.password) {
            out.line(`client.username_pw_set(${str(request.username)}, ${str(request.password)})`);
        }
        if (url.secure) {
            const tls = [
                request.caCertificateFile && `ca_certs=${str(request.caCertificateFile)}`,
                request.clientCertificateFile && `certfile=${str(request.clientCertificateFile)}`,
                request.clientKeyFile && `keyfile=${str(request.clientKeyFile)}`,
            ].filter(Boolean);
            out.line(`client.tls_set(${tls.join(', ')})`);
            if (!request.verifyTls) out.line('client.tls_insecure_set(True)');
        }
        if (url.websocket && url.path) out.line(`client.ws_set_options(path=${str(url.path)})`);
        out.blank();

        out.line('def on_connect(client, userdata, flags, reason_code, properties):');
        out.indent(() => {
            out.line('print("connected:", reason_code)');
            request.subscriptions.forEach((sub) =>
                out.line(`client.subscribe(${str(sub.topic)}, qos=${sub.qos})`),
            );
            if (publish) {
                out.line(
                    `client.publish(${str(publish.topic)}, ${payloadExpression(publish, 'python')}, qos=${publish.qos}, retain=${publish.retain ? 'True' : 'False'})`,
                );
            }
        });
        out.blank();
        out.line('def on_message(client, userdata, message):');
        out.indent(() => out.line('print(message.topic, message.payload)'));
        out.blank();
        out.line('client.on_connect = on_connect');
        out.line('client.on_message = on_message');
        out.line(
            `client.connect(${str(url.host)}, ${port}, keepalive=${request.keepAliveSeconds})`,
        );
        out.line('client.loop_forever()');
    },
});
