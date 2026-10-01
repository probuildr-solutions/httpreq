/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { PreparedRequest } from '@httpreq/shared';

/** POSIX-shell single quoting. */
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A cURL command equivalent to a prepared request. File contents are referenced by name
 * (`@file`) rather than inlined; `binaryFileName` names the file of a binary body.
 */
export const toCurl = (request: PreparedRequest, binaryFileName = 'file'): string => {
    const lines = [`curl -X ${request.method} ${quote(request.url)}`];
    for (const [name, value] of Object.entries(request.headers)) {
        lines.push(`-H ${quote(`${name}: ${value}`)}`);
    }
    const body = request.body;
    if (body?.kind === 'text') lines.push(`--data-raw ${quote(body.text)}`);
    if (body?.kind === 'bytes') lines.push(`--data-binary ${quote(`@${binaryFileName}`)}`);
    if (body?.kind === 'multipart') {
        for (const part of body.parts) {
            lines.push(
                'bytes' in part
                    ? `-F ${quote(`${part.name}=@${part.fileName}`)}`
                    : `-F ${quote(`${part.name}=${part.value}`)}`,
            );
        }
    }
    if (request.options.followRedirects) lines.push('-L');
    if (!request.options.verifyTls) lines.push('-k');
    return lines.join(' \\\n  ');
};
