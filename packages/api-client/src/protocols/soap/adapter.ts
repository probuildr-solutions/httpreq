/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    createKeyValue,
    createSoapConfig,
    SOAP_ENVELOPE_NAMESPACE,
    type HttpRequest,
    type KeyValueItem,
    type SoapConfig,
} from '@httpreq/shared';
import { assertHeaderSafe } from './xml';

/** A body that already is a complete envelope is sent untouched. */
const FULL_ENVELOPE = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<([\w.-]+:)?Envelope[\s>]/;

export const isFullEnvelope = (xml: string): boolean => FULL_ENVELOPE.test(xml);

/**
 * Wraps `bodyXml` in a SOAP envelope for the configured version, with the configured header
 * blocks. A body that is already an envelope is returned as written (its own headers win).
 */
export const buildSoapEnvelope = (config: SoapConfig, bodyXml: string): string => {
    if (isFullEnvelope(bodyXml)) return bodyXml;
    const namespace = SOAP_ENVELOPE_NAMESPACE[config.version];
    const header = config.headerXml.trim()
        ? `  <soap:Header>\n${indent(config.headerXml.trim(), 4)}\n  </soap:Header>\n`
        : '';
    return (
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<soap:Envelope xmlns:soap="${namespace}">\n${header}` +
        `  <soap:Body>\n${indent(bodyXml.trim(), 4)}\n  </soap:Body>\n` +
        `</soap:Envelope>`
    );
};

const indent = (text: string, spaces: number) =>
    text
        .split('\n')
        .map((line) => (line ? ' '.repeat(spaces) + line : line))
        .join('\n');

const hasHeader = (headers: KeyValueItem[], name: string) =>
    headers.some((item) => item.enabled && item.key.trim().toLowerCase() === name.toLowerCase());

/** Content-Type and SOAPAction as the SOAP version requires. */
export const soapHeaders = (config: SoapConfig): { name: string; value: string }[] => {
    const action = config.action.trim();
    assertHeaderSafe('The SOAP action', action);
    if (action.includes('"')) {
        throw new AppError('INVALID_REQUEST', 'The SOAP action cannot contain a double quote.');
    }
    return config.version === '1.2'
        ? [
              {
                  name: 'Content-Type',
                  value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`,
              },
          ]
        : [
              { name: 'Content-Type', value: 'text/xml; charset=utf-8' },
              // SOAP 1.1 requires the header even when the action is empty.
              { name: 'SOAPAction', value: `"${action}"` },
          ];
};

/**
 * The plain HTTP request a SOAP request stands for: POST, the envelope as the body, and the SOAP
 * headers unless the user wrote their own. Nothing else about the request changes, which is what
 * lets SOAP reuse variables, authorization, scripts and the HTTP runtime as they are.
 */
export const soapToHttp = (request: HttpRequest): HttpRequest => {
    const config = request.soap ?? createSoapConfig();
    const added = soapHeaders(config)
        .filter((header) => !hasHeader(request.headers, header.name))
        .map((header) => createKeyValue({ key: header.name, value: header.value }));
    return {
        ...request,
        method: 'POST',
        headers: [...added, ...request.headers],
        body: {
            ...request.body,
            mode: 'text',
            text: buildSoapEnvelope(config, request.body.text),
            textContentType: 'application/xml',
        },
    };
};
