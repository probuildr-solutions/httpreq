/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { GrpcCodegenRequest } from '@httpreq/shared';
import { defineProtocolGenerator } from '../../core/define';
import { jsDialect } from '../../core/dialects';
import { parseLosslessJson, renderJson } from '../../core/json';
import { jsonStyle } from '../http/javascript/shared';

const str = jsDialect.literal;

export const nodeGrpcGenerator = defineProtocolGenerator<GrpcCodegenRequest>({
    protocol: 'grpc',
    id: 'node-grpc',
    label: 'Node.js – @grpc/grpc-js',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    fileExtension: 'mjs',
    requirements: 'Node.js 20+, @grpc/grpc-js, @grpc/proto-loader',
    render(request, out) {
        const entry = request.protoFiles[0]?.name ?? 'service.proto';
        out.line('import grpc from "@grpc/grpc-js";');
        out.line('import protoLoader from "@grpc/proto-loader";').blank();

        out.block(`const definition = protoLoader.loadSync(${str(entry)}, {`, '});', () => {
            out.line('keepCase: true,');
            out.line('longs: String,');
            out.line('enums: String,');
            out.line('defaults: true,');
            out.line('oneofs: true,');
        });
        out.line(
            `const Service = grpc.loadPackageDefinition(definition).${request.service};`,
        ).blank();

        out.line(
            `const credentials = ${
                !request.tls
                    ? 'grpc.credentials.createInsecure()'
                    : request.verifyTls
                      ? 'grpc.credentials.createSsl()'
                      : 'grpc.credentials.createSsl(null, null, null, { checkServerIdentity: () => undefined })'
            };`,
        );
        out.line(`const client = new Service(${str(request.target)}, credentials);`).blank();

        out.line('const metadata = new grpc.Metadata();');
        request.metadata.forEach((header) =>
            out.line(`metadata.add(${str(header.name)}, ${str(header.value)});`),
        );
        out.blank();

        const value = parseLosslessJson(request.message);
        const message = value
            ? renderJson(value, out.indentation, jsonStyle(out.unit))
            : `JSON.parse(${str(request.message)})`;
        out.line(`const message = ${message};`);
        out.line(
            request.deadlineMs > 0
                ? `const options = { deadline: Date.now() + ${request.deadlineMs} };`
                : 'const options = {};',
        ).blank();

        if (request.serverStreaming) {
            out.line(`const call = client.${request.method}(message, metadata, options);`);
            out.line('call.on("data", (response) => console.log(response));');
            out.line('call.on("error", (error) => console.error(error.code, error.details));');
            out.line('call.on("end", () => client.close());');
            return;
        }
        out.block(
            `client.${request.method}(message, metadata, options, (error, response) => {`,
            '});',
            () => {
                out.block('if (error) {', '} else {', () =>
                    out.line('console.error(error.code, error.details);'),
                );
                out.indent(() => out.line('console.log(response);'));
                out.line('}');
                out.line('client.close();');
            },
        );
    },
});
