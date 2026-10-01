/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    CodeGenerator,
    GrpcCodegenRequest,
    MqttCodegenRequest,
    MqttPublishInput,
} from '@httpreq/shared';
import { dq, lines, pad, shellQuote } from '../util';
import { UnsupportedCombination } from '../errors';

/* ---------------------------------- gRPC ---------------------------------- */

export const grpcurlGenerator: CodeGenerator<GrpcCodegenRequest> = {
    id: 'grpcurl',
    label: 'grpcurl',
    language: 'Shell',
    editorLanguage: 'shell',
    protocols: ['grpc'],
    generate: (request) => {
        const entry = request.protoFiles[0]?.name;
        const parts = ['grpcurl'];
        if (!request.tls) parts.push('-plaintext');
        else if (!request.verifyTls) parts.push('-insecure');
        if (entry) parts.push(`-import-path . -proto ${shellQuote(entry)}`);
        for (const header of request.metadata) {
            parts.push(`-H ${shellQuote(`${header.name}: ${header.value}`)}`);
        }
        if (request.deadlineMs > 0) parts.push(`-max-time ${Math.ceil(request.deadlineMs / 1000)}`);
        parts.push(`-d ${shellQuote(request.message)}`);
        parts.push(shellQuote(request.target));
        parts.push(shellQuote(`${request.service}/${request.method}`));
        return parts.join(' \\\n  ');
    },
};

export const nodeGrpcGenerator: CodeGenerator<GrpcCodegenRequest> = {
    id: 'node-grpc',
    label: 'Node.js – @grpc/grpc-js',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    protocols: ['grpc'],
    generate: (request, { indent }) => {
        const entry = request.protoFiles[0]?.name ?? 'service.proto';
        const p = pad(1, indent);
        let message: string;
        try {
            message = JSON.stringify(JSON.parse(request.message), null, indent);
        } catch {
            message = request.message;
        }
        return lines(
            "import grpc from '@grpc/grpc-js';",
            "import protoLoader from '@grpc/proto-loader';",
            '',
            `const definition = protoLoader.loadSync(${dq(entry)}, {`,
            `${p}keepCase: true,`,
            `${p}longs: String,`,
            `${p}enums: String,`,
            `${p}defaults: true,`,
            `${p}oneofs: true,`,
            '});',
            `const Service = grpc.loadPackageDefinition(definition).${request.service};`,
            '',
            `const credentials = ${
                !request.tls
                    ? 'grpc.credentials.createInsecure()'
                    : request.verifyTls
                      ? 'grpc.credentials.createSsl()'
                      : 'grpc.credentials.createSsl(null, null, null, { checkServerIdentity: () => undefined })'
            };`,
            `const client = new Service(${dq(request.target)}, credentials);`,
            '',
            'const metadata = new grpc.Metadata();',
            ...request.metadata.map(
                (header) => `metadata.add(${dq(header.name)}, ${dq(header.value)});`,
            ),
            '',
            `const message = ${message};`,
            request.deadlineMs > 0
                ? `const options = { deadline: Date.now() + ${request.deadlineMs} };`
                : 'const options = {};',
            '',
            request.serverStreaming
                ? lines(
                      `const call = client.${request.method}(message, metadata, options);`,
                      "call.on('data', (response) => console.log(response));",
                      "call.on('error', (error) => console.error(error.code, error.details));",
                      "call.on('end', () => client.close());",
                  )
                : lines(
                      `client.${request.method}(message, metadata, options, (error, response) => {`,
                      `${p}if (error) {`,
                      `${pad(2, indent)}console.error(error.code, error.details);`,
                      `${p}} else {`,
                      `${pad(2, indent)}console.log(response);`,
                      `${p}}`,
                      `${p}client.close();`,
                      '});',
                  ),
        );
    },
};

/* ---------------------------------- MQTT ---------------------------------- */

const mqttParts = (request: MqttCodegenRequest) => {
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

/** Hex payloads become bytes; everything else is sent as the text typed. */
const payloadIsHex = (publish: MqttPublishInput) => publish.format === 'hex';
const hexDigits = (payload: string) => payload.replace(/[\s:]/g, '');

export const mosquittoGenerator: CodeGenerator<MqttCodegenRequest> = {
    id: 'mosquitto',
    label: 'Mosquitto clients',
    language: 'Shell',
    editorLanguage: 'shell',
    protocols: ['mqtt'],
    generate: (request) => {
        const url = mqttParts(request);
        if (url.websocket) {
            throw new UnsupportedCombination(
                'The Mosquitto command-line clients do not speak MQTT over WebSockets. Use the Node.js or Python generator.',
            );
        }
        const common = [
            `-h ${shellQuote(url.host)}`,
            `-p ${url.port}`,
            `-i ${shellQuote(request.clientId)}`,
            `-V ${{ 3: 'mqttv31', 4: 'mqttv311', 5: 'mqttv5' }[request.protocolVersion]}`,
            `-k ${request.keepAliveSeconds}`,
            request.username && `-u ${shellQuote(request.username)}`,
            request.password && `-P ${shellQuote(request.password)}`,
            url.secure &&
                request.caCertificateFile &&
                `--cafile ${shellQuote(request.caCertificateFile)}`,
            url.secure &&
                request.clientCertificateFile &&
                `--cert ${shellQuote(request.clientCertificateFile)}`,
            url.secure && request.clientKeyFile && `--key ${shellQuote(request.clientKeyFile)}`,
            url.secure && !request.verifyTls && '--insecure',
            !request.cleanSession && '-c',
        ].filter((part): part is string => !!part);
        const subscribe =
            request.subscriptions.length > 0 &&
            `mosquitto_sub ${[
                ...common,
                ...request.subscriptions.map((sub) => `-t ${shellQuote(sub.topic)} -q ${sub.qos}`),
                '-v',
            ].join(' ')}`;
        const publish = request.publish;
        const publishCommand =
            publish &&
            `${payloadIsHex(publish) ? `printf '%s' ${shellQuote(hexDigits(publish.payload))} | xxd -r -p | ` : ''}mosquitto_pub ${[
                ...common,
                `-t ${shellQuote(publish.topic)}`,
                `-q ${publish.qos}`,
                publish.retain && '-r',
                payloadIsHex(publish) ? '-s' : `-m ${shellQuote(publish.payload)}`,
            ]
                .filter((part): part is string => !!part)
                .join(' ')}`;
        if (!subscribe && !publishCommand) {
            throw new UnsupportedCombination('Add a subscription or a publish topic first.');
        }
        return lines(subscribe, subscribe && publishCommand && '', publishCommand);
    },
};

const payloadExpression = (publish: MqttPublishInput, language: 'js' | 'python') =>
    payloadIsHex(publish)
        ? language === 'js'
            ? `Buffer.from(${dq(hexDigits(publish.payload))}, 'hex')`
            : `bytes.fromhex(${dq(hexDigits(publish.payload))})`
        : dq(publish.payload);

export const nodeMqttGenerator: CodeGenerator<MqttCodegenRequest> = {
    id: 'node-mqtt',
    label: 'Node.js – mqtt',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    protocols: ['mqtt'],
    generate: (request, { indent }) => {
        const url = mqttParts(request);
        const p = pad(1, indent);
        const publish = request.publish;
        const files = url.secure && (request.caCertificateFile || request.clientCertificateFile);
        return lines(
            "import mqtt from 'mqtt';",
            files && "import fs from 'node:fs';",
            '',
            `const client = mqtt.connect(${dq(request.url)}, {`,
            `${p}clientId: ${dq(request.clientId)},`,
            request.username && `${p}username: ${dq(request.username)},`,
            request.password && `${p}password: ${dq(request.password)},`,
            `${p}protocolVersion: ${request.protocolVersion},`,
            `${p}keepalive: ${request.keepAliveSeconds},`,
            `${p}clean: ${request.cleanSession},`,
            url.secure && !request.verifyTls && `${p}rejectUnauthorized: false,`,
            url.secure &&
                request.caCertificateFile &&
                `${p}ca: fs.readFileSync(${dq(request.caCertificateFile)}),`,
            url.secure &&
                request.clientCertificateFile &&
                `${p}cert: fs.readFileSync(${dq(request.clientCertificateFile)}),`,
            url.secure &&
                request.clientKeyFile &&
                `${p}key: fs.readFileSync(${dq(request.clientKeyFile)}),`,
            '});',
            '',
            "client.on('connect', () => {",
            ...request.subscriptions.map(
                (sub) =>
                    `${p}client.subscribe(${dq(sub.topic)}, { qos: ${sub.qos} }, (error) => error && console.error(error));`,
            ),
            publish &&
                `${p}client.publish(${dq(publish.topic)}, ${payloadExpression(publish, 'js')}, { qos: ${publish.qos}, retain: ${publish.retain} });`,
            '});',
            '',
            "client.on('message', (topic, message) => {",
            `${p}console.log(topic, message.toString());`,
            '});',
            "client.on('error', (error) => console.error(error));",
            publish &&
                request.subscriptions.length === 0 &&
                lines(
                    '',
                    '// Nothing to receive: close once the message is sent.',
                    "client.on('connect', () => setTimeout(() => client.end(), 500));",
                ),
        );
    },
};

export const pythonPahoGenerator: CodeGenerator<MqttCodegenRequest> = {
    id: 'python-paho',
    label: 'Python – paho-mqtt',
    language: 'Python',
    editorLanguage: 'python',
    protocols: ['mqtt'],
    generate: (request, { indent }) => {
        const url = mqttParts(request);
        const p = pad(1, indent);
        const publish = request.publish;
        const port = url.port || (url.secure ? '8883' : '1883');
        return lines(
            'import paho.mqtt.client as mqtt',
            '',
            `client = mqtt.Client(`,
            `${p}mqtt.CallbackAPIVersion.VERSION2,`,
            `${p}client_id=${dq(request.clientId)},`,
            `${p}protocol=mqtt.${{ 3: 'MQTTv31', 4: 'MQTTv311', 5: 'MQTTv5' }[request.protocolVersion]},`,
            url.websocket && `${p}transport="websockets",`,
            ')',
            (request.username || request.password) &&
                `client.username_pw_set(${dq(request.username)}, ${dq(request.password)})`,
            url.secure &&
                `client.tls_set(${[
                    request.caCertificateFile && `ca_certs=${dq(request.caCertificateFile)}`,
                    request.clientCertificateFile &&
                        `certfile=${dq(request.clientCertificateFile)}`,
                    request.clientKeyFile && `keyfile=${dq(request.clientKeyFile)}`,
                ]
                    .filter(Boolean)
                    .join(', ')})`,
            url.secure && !request.verifyTls && 'client.tls_insecure_set(True)',
            url.websocket && url.path && `client.ws_set_options(path=${dq(url.path)})`,
            '',
            'def on_connect(client, userdata, flags, reason_code, properties):',
            `${p}print("connected:", reason_code)`,
            ...request.subscriptions.map(
                (sub) => `${p}client.subscribe(${dq(sub.topic)}, qos=${sub.qos})`,
            ),
            publish &&
                `${p}client.publish(${dq(publish.topic)}, ${payloadExpression(publish, 'python')}, qos=${publish.qos}, retain=${publish.retain ? 'True' : 'False'})`,
            '',
            'def on_message(client, userdata, message):',
            `${p}print(message.topic, message.payload)`,
            '',
            'client.on_connect = on_connect',
            'client.on_message = on_message',
            `client.connect(${dq(url.host)}, ${port}, keepalive=${request.keepAliveSeconds})`,
            'client.loop_forever()',
        );
    },
};
