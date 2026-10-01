/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { AuthConfig, HttpRequest, KeyValueItem, TextContentType } from '@httpreq/shared';
import { childrenOf, type ExportSource } from './source';

/**
 * Postman Collection Format v2.1.0, the current published schema, which Postman, Insomnia,
 * Bruno, Hoppscotch and most other API tools import.
 */
export const POSTMAN_SCHEMA =
    'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

type Json = Record<string, unknown>;

const pairs = (values: Record<string, string | boolean | undefined>) =>
    Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => ({
            key,
            value,
            type: typeof value === 'boolean' ? 'boolean' : 'string',
        }));

const OAUTH2_GRANTS: Record<string, string> = {
    authorization_code: 'authorization_code',
    authorization_code_pkce: 'authorization_code_with_pkce',
    client_credentials: 'client_credentials',
    password: 'password_credentials',
};

/** Postman's `auth` object; `undefined` means "inherit from parent", which is Postman's default. */
export const postmanAuth = (auth: AuthConfig, warnings: Set<string>): Json | undefined => {
    switch (auth.type) {
        case 'inherit':
            return undefined;
        case 'none':
            return { type: 'noauth' };
        case 'bearer':
            if (auth.prefix && auth.prefix !== 'Bearer') {
                warnings.add(
                    `The “${auth.prefix}” token prefix is written as a standard Bearer token.`,
                );
            }
            return { type: 'bearer', bearer: pairs({ token: auth.token }) };
        case 'basic':
            return {
                type: 'basic',
                basic: pairs({ username: auth.username, password: auth.password }),
            };
        case 'digest':
            return {
                type: 'digest',
                digest: pairs({ username: auth.username, password: auth.password }),
            };
        case 'api-key':
            return {
                type: 'apikey',
                apikey: pairs({ key: auth.key, value: auth.value, in: auth.location }),
            };
        case 'jwt':
            return {
                type: 'jwt',
                jwt: pairs({
                    algorithm: auth.algorithm,
                    secret: auth.secret,
                    isSecretBase64Encoded: auth.secretBase64,
                    payload: auth.payload,
                    header: auth.header,
                    addTokenTo: auth.addTo === 'query' ? 'queryParam' : 'header',
                    headerPrefix: auth.headerPrefix,
                    queryParamKey: auth.queryParamKey,
                }),
            };
        case 'oauth2': {
            const grant = OAUTH2_GRANTS[auth.grantType];
            if (!grant) {
                warnings.add(
                    'The OAuth 2.0 refresh-token grant has no Postman equivalent; it is written as an authorization-code grant.',
                );
            }
            return {
                type: 'oauth2',
                oauth2: pairs({
                    grant_type: grant ?? 'authorization_code',
                    authUrl: auth.authUrl,
                    accessTokenUrl: auth.tokenUrl,
                    clientId: auth.clientId,
                    clientSecret: auth.clientSecret,
                    scope: auth.scope,
                    redirect_uri: auth.callbackUrl,
                    username: auth.username,
                    password: auth.password,
                    client_authentication: auth.clientAuthentication === 'body' ? 'body' : 'header',
                    headerPrefix: auth.headerPrefix,
                    addTokenTo: 'header',
                }),
            };
        }
    }
};

/** Headers, query parameters and form fields; query parameters carry no `type`. */
const keyValues = (items: KeyValueItem[], typed = true) =>
    items
        .filter((item) => item.key || item.value)
        .map((item) => ({
            key: item.key,
            value: item.value,
            ...(item.enabled ? {} : { disabled: true }),
            ...(item.description ? { description: item.description } : {}),
            ...(typed ? { type: 'text' } : {}),
        }));

/** Splits a URL into Postman's parts, keeping `{{variables}}` intact; `raw` stays authoritative. */
export const postmanUrl = (
    raw: string,
    params: KeyValueItem[],
    pathVariables: KeyValueItem[] = [],
) => {
    const [beforeHash] = raw.split('#');
    const [base = ''] = (beforeHash ?? '').split('?');
    const protocolMatch = /^([a-z][\w+.-]*):\/\//i.exec(base);
    const rest = protocolMatch ? base.slice(protocolMatch[0].length) : base;
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : rest.slice(slash + 1);
    const portMatch = /:(\d+|\{\{[^{}]+\}\})$/.exec(authority);
    const host = portMatch ? authority.slice(0, portMatch.index) : authority;
    const query = keyValues(params, false);
    return {
        raw,
        ...(protocolMatch ? { protocol: protocolMatch[1] } : {}),
        host: host ? (host.startsWith('{{') ? [host] : host.split('.')) : [],
        ...(portMatch ? { port: portMatch[1] } : {}),
        path: path ? path.split('/') : [],
        ...(query.length ? { query } : {}),
        ...(pathVariables.length
            ? {
                  variable: pathVariables.map((item) => ({
                      key: item.key,
                      value: item.value,
                      ...(item.description ? { description: item.description } : {}),
                  })),
              }
            : {}),
    };
};

const RAW_LANGUAGE: Record<TextContentType, string> = {
    'text/plain': 'text',
    'application/xml': 'xml',
    'text/html': 'html',
    'application/javascript': 'javascript',
};

const postmanBody = (request: HttpRequest): Json | undefined => {
    const { body } = request;
    switch (body.mode) {
        case 'none':
            return undefined;
        case 'json':
            return { mode: 'raw', raw: body.json, options: { raw: { language: 'json' } } };
        case 'text':
            return {
                mode: 'raw',
                raw: body.text,
                options: { raw: { language: RAW_LANGUAGE[body.textContentType] } },
            };
        case 'form-urlencoded':
            return { mode: 'urlencoded', urlencoded: keyValues(body.formUrlEncoded) };
        case 'multipart':
            return {
                mode: 'formdata',
                formdata: body.multipart
                    .filter((field) => field.key)
                    .map((field) => ({
                        key: field.key,
                        ...(field.kind === 'file'
                            ? { type: 'file', src: field.file?.name ?? '' }
                            : { type: 'text', value: field.value }),
                        ...(field.enabled ? {} : { disabled: true }),
                        ...(field.description ? { description: field.description } : {}),
                    })),
            };
        case 'binary':
            return { mode: 'file', file: { src: body.binary?.name ?? '' } };
    }
};

const script = (listen: 'prerequest' | 'test', code: string) => ({
    listen,
    script: { type: 'text/javascript', exec: code.split(/\r?\n/) },
});

const postmanItem = (request: HttpRequest, warnings: Set<string>): Json => {
    const events = [];
    if (request.scripts.preRequest.trim())
        events.push(script('prerequest', request.scripts.preRequest));
    const after = [request.scripts.postResponse, request.scripts.tests]
        .filter((code) => code.trim())
        .join('\n\n');
    if (after) events.push(script('test', after));
    const auth = postmanAuth(request.auth, warnings);
    const body = postmanBody(request);
    return {
        name: request.name,
        ...(events.length ? { event: events } : {}),
        protocolProfileBehavior: {
            followRedirects: request.settings.followRedirects,
            strictSSL: request.settings.verifyTls,
            disableCookies: !request.settings.sendCookies,
        },
        request: {
            method: request.method,
            header: keyValues(request.headers),
            ...(body ? { body } : {}),
            url: postmanUrl(request.url, request.params, request.pathVariables),
            ...(auth ? { auth } : {}),
            ...(request.description ? { description: request.description } : {}),
        },
        response: [],
    };
};

/** A Postman v2.1.0 collection, with the export's environment as collection variables. */
export const toPostmanCollection = (source: ExportSource) => {
    const warnings = new Set<string>(source.skipped);
    const items = (parentId: string): Json[] => {
        const { folders, requests } = childrenOf(source, parentId);
        return [
            ...folders.map((folder) => {
                const auth = postmanAuth(folder.auth, warnings);
                return {
                    name: folder.name,
                    ...(folder.description ? { description: folder.description } : {}),
                    item: items(folder.id),
                    ...(auth ? { auth } : {}),
                };
            }),
            ...requests.map((request) => postmanItem(request, warnings)),
        ];
    };
    const auth = postmanAuth(source.auth, warnings);
    const document = {
        info: {
            _postman_id: source.rootId,
            name: source.name,
            ...(source.description ? { description: source.description } : {}),
            schema: POSTMAN_SCHEMA,
        },
        item: items(source.rootId),
        ...(auth ? { auth } : {}),
        variable: (source.environment?.variables ?? []).map((variable) => ({
            key: variable.key,
            value: variable.value,
            type: variable.secret ? 'secret' : 'string',
            ...(variable.enabled ? {} : { disabled: true }),
        })),
    };
    return { document, warnings: [...warnings] };
};
