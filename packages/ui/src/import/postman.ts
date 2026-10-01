/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createCollection,
    createEmptyRequest,
    createFolder,
    createKeyValue,
    isHttpMethod,
    syncPathVariables,
    type AuthConfig,
    type Folder,
    type HttpRequest,
    type KeyValueItem,
    type MultipartField,
    type TextContentType,
} from '@httpreq/shared';
import { paramsFromUrl } from '@httpreq/workspace';
import { stringifyPretty } from '../indent';
import { ImportError } from './errors';
import type { ImportedEnvironment, ImportedVariable, ImportPlan } from './types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) =>
    typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Postman nests items this deep at most in practice; anything deeper is almost certainly a loop. */
const MAX_DEPTH = 32;

export const isPostmanCollection = (doc: Json) =>
    isObject(doc.info) &&
    (str(doc.info.schema).includes('collection') ||
        Array.isArray(doc.item) ||
        '_postman_id' in doc.info);

/** A Postman environment or globals export: a name and a `values` list. */
export const isPostmanEnvironment = (doc: Json) =>
    Array.isArray(doc.values) &&
    (typeof doc._postman_variable_scope === 'string' || typeof doc.name === 'string');

const description = (value: unknown) => (isObject(value) ? str(value.content) : str(value));

const variables = (items: unknown[]): ImportedVariable[] =>
    items.filter(isObject).flatMap((item) => {
        const key = str(item.key).trim();
        if (!key) return [];
        return [
            {
                key,
                value: str(item.value ?? item.currentValue ?? item.initialValue),
                enabled: item.enabled !== false && item.disabled !== true,
                secret: item.type === 'secret',
            },
        ];
    });

/** Postman keeps each auth parameter as a `{ key, value }` pair (v2.1) or as properties (v2.0). */
const authParams = (auth: Json, type: string): Record<string, string> => {
    const raw = auth[type];
    if (Array.isArray(raw)) {
        return Object.fromEntries(
            raw.filter(isObject).map((item) => [str(item.key), str(item.value)]),
        );
    }
    return isObject(raw)
        ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, str(value)]))
        : {};
};

const convertAuth = (value: unknown, warnings: Set<string>): AuthConfig | null => {
    if (!isObject(value)) return null;
    const type = str(value.type);
    const params = authParams(value, type);
    switch (type) {
        case 'noauth':
            return { type: 'none' };
        case 'inherit':
            return { type: 'inherit' };
        case 'bearer':
            return { type: 'bearer', token: params.token ?? '', prefix: 'Bearer' };
        case 'basic':
            return {
                type: 'basic',
                username: params.username ?? '',
                password: params.password ?? '',
            };
        case 'digest':
            return {
                type: 'digest',
                username: params.username ?? '',
                password: params.password ?? '',
            };
        case 'apikey':
            return {
                type: 'api-key',
                key: params.key ?? '',
                value: params.value ?? '',
                location: params.in === 'query' ? 'query' : 'header',
            };
        default:
            warnings.add(`“${type}” authorization is not supported and was left out.`);
            return null;
    }
};

/** The request URL: Postman stores it as a string or as parts plus a `raw` form. */
const convertUrl = (
    value: unknown,
): { url: string; disabled: KeyValueItem[]; pathVariables: KeyValueItem[] } => {
    if (!isObject(value)) return { url: str(value), disabled: [], pathVariables: [] };
    let url = str(value.raw);
    if (!url) {
        const host = Array.isArray(value.host) ? value.host.map(str).join('.') : str(value.host);
        const path = Array.isArray(value.path) ? value.path.map(str).join('/') : str(value.path);
        const protocol = str(value.protocol);
        const query = list(value.query)
            .filter((item) => isObject(item) && item.disabled !== true)
            .map((item) => `${str((item as Json).key)}=${str((item as Json).value)}`)
            .join('&');
        url = `${protocol ? `${protocol}://` : ''}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
    }
    const disabled = list(value.query)
        .filter((item): item is Json => isObject(item) && item.disabled === true)
        .map((item) =>
            createKeyValue({
                key: str(item.key),
                value: str(item.value),
                enabled: false,
                description: description(item.description) || undefined,
            }),
        );
    // Path variables (`:id`) stay in the URL; their values fill the path-variable table.
    const declared = new Map(
        list(value.variable)
            .filter(isObject)
            .map((variable) => [str(variable.key), variable] as const),
    );
    const pathVariables = syncPathVariables(url).map((row) => {
        const variable = declared.get(row.key);
        return variable
            ? {
                  ...row,
                  value: str(variable.value),
                  description: description(variable.description) || undefined,
              }
            : row;
    });
    return { url, disabled, pathVariables };
};

const TEXT_LANGUAGES: Record<string, TextContentType> = {
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript',
    text: 'text/plain',
};

const convertBody = (
    body: unknown,
    headers: KeyValueItem[],
    request: HttpRequest,
    warnings: Set<string>,
) => {
    if (!isObject(body) || body.disabled === true) return;
    const mode = str(body.mode);
    const contentType =
        headers
            .find((header) => header.key.toLowerCase() === 'content-type')
            ?.value.toLowerCase() ?? '';
    switch (mode) {
        case 'raw': {
            const raw = str(body.raw);
            const options =
                isObject(body.options) && isObject(body.options.raw) ? body.options.raw : {};
            const language = str(options.language).toLowerCase();
            if (language === 'json' || (!language && contentType.includes('json'))) {
                let json = raw;
                try {
                    json = stringifyPretty(JSON.parse(raw));
                } catch {
                    // Postman bodies often hold {{variables}} that make them invalid JSON; keep them as is.
                }
                request.body = { ...request.body, mode: 'json', json };
            } else {
                const textContentType =
                    TEXT_LANGUAGES[language] ??
                    (contentType.includes('xml') ? 'application/xml' : 'text/plain');
                request.body = { ...request.body, mode: 'text', text: raw, textContentType };
            }
            return;
        }
        case 'urlencoded':
            request.body = {
                ...request.body,
                mode: 'form-urlencoded',
                formUrlEncoded: list(body.urlencoded)
                    .filter(isObject)
                    .map((item) =>
                        createKeyValue({
                            key: str(item.key),
                            value: str(item.value),
                            enabled: item.disabled !== true,
                        }),
                    ),
            };
            return;
        case 'formdata':
            request.body = {
                ...request.body,
                mode: 'multipart',
                multipart: list(body.formdata)
                    .filter(isObject)
                    .map((item): MultipartField => {
                        const file = item.type === 'file';
                        return {
                            ...createKeyValue({
                                key: str(item.key),
                                value: file ? '' : str(item.value),
                                enabled: item.disabled !== true,
                            }),
                            kind: file ? 'file' : 'text',
                            file: null,
                        };
                    }),
            };
            if (list(body.formdata).some((item) => isObject(item) && item.type === 'file')) {
                warnings.add(
                    'File fields were imported without their files; choose them again before sending.',
                );
            }
            return;
        case 'file':
            request.body = { ...request.body, mode: 'binary', binary: null };
            warnings.add(
                'Binary bodies were imported without their files; choose them again before sending.',
            );
            return;
        case 'graphql': {
            const graphql = isObject(body.graphql) ? body.graphql : {};
            let variables: unknown = {};
            try {
                variables = graphql.variables ? JSON.parse(str(graphql.variables)) : {};
            } catch {
                variables = {};
            }
            request.body = {
                ...request.body,
                mode: 'json',
                json: stringifyPretty({ query: str(graphql.query), variables }),
            };
            return;
        }
    }
};

/** Converts a Postman collection (v2.0 or v2.1) into a collection. */
export const fromPostmanCollection = (doc: Json, fileName: string): ImportPlan => {
    if (!isObject(doc.info)) throw new ImportError('The Postman collection has no “info” section.');
    const schema = str(doc.info.schema);
    if (schema && !/v2\.[01]/.test(schema)) {
        throw new ImportError(
            'Only Postman Collection v2.0 and v2.1 are supported. Export the collection as v2.1 from Postman.',
        );
    }
    if (!Array.isArray(doc.item))
        throw new ImportError('The Postman collection has no “item” list.');

    const name =
        str(doc.info.name).trim() || fileName.replace(/\.[^.]+$/, '') || 'Postman collection';
    const collection = createCollection(name);
    collection.description = description(doc.info.description);
    const warnings = new Set<string>();
    collection.auth = convertAuth(doc.auth, warnings) ?? { type: 'none' };
    if (collection.auth.type === 'inherit') collection.auth = { type: 'none' };

    const folders: Folder[] = [];
    const requests: HttpRequest[] = [];
    let unsupportedMethods = 0;
    let scripts = false;

    const visit = (items: unknown[], parentId: string, depth: number) => {
        if (depth > MAX_DEPTH)
            throw new ImportError('The collection is nested too deeply to import.');
        for (const item of items) {
            if (!isObject(item)) continue;
            if (list(item.event).length) scripts = true;
            if (Array.isArray(item.item)) {
                const folder = createFolder(parentId, str(item.name).trim() || 'Folder');
                folder.description = description(item.description);
                folder.auth = convertAuth(item.auth, warnings) ?? { type: 'inherit' };
                folders.push(folder);
                visit(item.item, folder.id, depth + 1);
                continue;
            }
            const source = typeof item.request === 'string' ? { url: item.request } : item.request;
            if (!isObject(source)) continue;
            const method = (str(source.method) || 'GET').toUpperCase();
            if (!isHttpMethod(method)) {
                unsupportedMethods++;
                continue;
            }
            const request = createEmptyRequest(parentId);
            request.name = str(item.name).trim() || `${method} request`;
            request.method = method;
            request.description = description(source.description);
            const { url, disabled, pathVariables } = convertUrl(source.url);
            request.url = url;
            if (pathVariables.length) request.pathVariables = pathVariables;
            request.params = [...paramsFromUrl(url, []), ...disabled];
            request.headers = (Array.isArray(source.header) ? source.header : [])
                .filter(isObject)
                .map((header) =>
                    createKeyValue({
                        key: str(header.key),
                        value: str(header.value),
                        enabled: header.disabled !== true,
                        description: description(header.description) || undefined,
                    }),
                );
            convertBody(source.body, request.headers, request, warnings);
            request.auth = convertAuth(source.auth, warnings) ?? { type: 'inherit' };
            requests.push(request);
        }
    };
    visit(doc.item, collection.id, 0);

    if (unsupportedMethods) {
        warnings.add(
            `${unsupportedMethods} request(s) with methods HttpReq does not support were skipped.`,
        );
    }
    if (scripts) warnings.add('Postman scripts (pre-request and tests) were not imported.');
    if (requests.length === 0 && folders.length === 0) {
        throw new ImportError('The Postman collection is empty.');
    }

    const collectionVariables = variables(list(doc.variable));
    return {
        type: 'collection',
        format: 'postman-collection',
        collection,
        folders,
        requests,
        environment: collectionVariables.length
            ? { name, variables: collectionVariables }
            : undefined,
        warnings: [...warnings],
    };
};

/** Converts a Postman environment (or globals) export. */
export const fromPostmanEnvironment = (doc: Json, fileName: string): ImportedEnvironment => {
    const values = list(doc.values);
    if (values.some((item) => !isObject(item) || typeof item.key !== 'string')) {
        throw new ImportError('Every environment value needs a “key”.');
    }
    const fallback =
        doc._postman_variable_scope === 'globals'
            ? 'Globals'
            : fileName.replace(/\.[^.]+$/, '').replace(/\.postman_environment$/, '');
    return {
        name: str(doc.name).trim() || fallback || 'Environment',
        variables: variables(values),
    };
};
