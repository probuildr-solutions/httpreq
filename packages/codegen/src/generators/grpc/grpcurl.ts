/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { GrpcCodegenRequest } from '@httpreq/shared';
import { defineProtocolGenerator } from '../../core/define';
import { shellDialect } from '../../core/dialects';
import { wholeSeconds } from '../../core/model';

const quote = shellDialect.literal;

export const grpcurlGenerator = defineProtocolGenerator<GrpcCodegenRequest>({
    protocol: 'grpc',
    id: 'grpcurl',
    label: 'grpcurl',
    language: 'Shell',
    editorLanguage: 'shell',
    fileExtension: 'sh',
    render(request, out) {
        const entry = request.protoFiles[0]?.name;
        const args = [
            ...(!request.tls ? ['-plaintext'] : request.verifyTls ? [] : ['-insecure']),
            ...(entry ? [`-import-path . -proto ${quote(entry)}`] : []),
            ...request.metadata.map((header) => `-H ${quote(`${header.name}: ${header.value}`)}`),
            ...(request.deadlineMs > 0 ? [`-max-time ${wholeSeconds(request.deadlineMs)}`] : []),
            `-d ${quote(request.message)}`,
            quote(request.target),
            quote(`${request.service}/${request.method}`),
        ];
        out.line(['grpcurl', ...args.map((arg) => `  ${arg}`)].join(' \\n'));
    },
});
