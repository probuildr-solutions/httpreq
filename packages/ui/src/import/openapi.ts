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
    type AuthConfig,
    type Folder,
    type HttpRequest,
    type KeyValueItem,
    type MultipartField,
} from '@httpreq/shared';
import { urlWithParams } from '@httpreq/workspace';
import { stringifyPretty } from '../indent';
import { ImportError } from './errors';
import type { ImportedVariable, ImportPlan } from './types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const OPERATIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

/** Whether a parsed document claims to be an OpenAPI 3 or Swagger 2 specification. */
export const isOpenApiDocument = (doc: Json) =>
    typeof doc.openapi === 'string' || doc.swagger !== undefined;

/** Follows a local `#/…` reference; external references cannot be resolved offline. */
const resolver = (doc: Json) => {
    const resolve = (value: unknown, seen = new Set<string>()): unknown => {
        if (!isObject(value) || typeof value.$ref !== 'string') return value;
        const ref = value.$ref;
        if (!ref.startsWith('#/') || seen.has(ref)) return {};
        let target: unknown = doc;
        for (const part of ref.slice(2).split('/')) {
            const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
            target = isObject(target) ? target[key] : undefined;
        }
        return resolve(target, new Set([...seen, ref]));
    };
    return resolve;
};

/** A plausible example value for a JSON schema, used to pre-fill request bodies. */
const exampleFor = (
    schema: unknown,
    resolve: (value: unknown) => unknown,
    depth = 0,
    refs: string[] = [],
): unknown => {
    if (depth > 8) return null;
    if (isObject(schema) && typeof schema.$ref === 'string') {
        // A schema that refers back to itself stops here instead of recursing forever.
        if (refs.includes(schema.$ref)) return {};
        return exampleFor(resolve(schema), resolve, depth + 1, [...refs, schema.$ref]);
    }
    if (!isObject(schema)) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (Array.isArray(schema.allOf)) {
        return schema.allOf.reduce<Json>((merged, part) => {
            const value = exampleFor(part, resolve, depth + 1, refs);
            return isObject(value) ? { ...merged, ...value } : merged;
        }, {});
    }
    for (const key of ['oneOf', 'anyOf'] as const) {
        const options = schema[key];
        if (Array.isArray(options) && options.length) {
            return exampleFor(options[0], resolve, depth + 1, refs);
        }
    }
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === 'object' || isObject(schema.properties)) {
        const result: Json = {};
        for (const [name, property] of Object.entries(
            isObject(schema.properties) ? schema.properties : {},
        )) {
            if (isObject(property) && property.readOnly === true) continue;
            result[name] = exampleFor(property, resolve, depth + 1, refs);
        }
        return result;
    }
    if (type === 'array') return [exampleFor(schema.items, resolve, depth + 1, refs)];
    if (type === 'integer' || type === 'number') return 0;
    if (type === 'boolean') return true;
    if (type === 'string') {
        switch (schema.format) {
            case 'date-time':
                return '2024-01-01T00:00:00Z';
            case 'date':
                return '2024-01-01';
            case 'email':
                return 'user@example.com';
            case 'uuid':
                return '00000000-0000-0000-0000-000000000000';
            case 'uri':
            case 'url':
                return 'https://example.com';
            default:
                return 'string';
        }
    }
    return null;
};

const exampleText = (value: unknown) =>
    value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value);

/** OpenAPI `{name}` path templates become `{{name}}` variables. */
const pathTemplate = (path: string) => path.replace(/\{([^}/]+)\}/g, '{{$1}}');

const variableName = (name: string) => name.replace(/[^\w.-]+/g, '_');

interface SchemeUse {
    auth: AuthConfig;
    variables: ImportedVariable[];
}

const secretVariable = (key: string): ImportedVariable => ({
    key,
    value: '',
    enabled: true,
    secret: true,
});

/** Maps a security scheme to an authorization the app supports, with the variables it uses. */
const authForScheme = (scheme: unknown): SchemeUse | null => {
    if (!isObject(scheme)) return null;
    const type = str(scheme.type).toLowerCase();
    const httpScheme = str(scheme.scheme).toLowerCase();
    if ((type === 'http' && httpScheme === 'bearer') || type === 'openidconnect') {
        return {
            auth: { type: 'bearer', token: '{{bearer_token}}', prefix: 'Bearer' },
            variables: [secretVariable('bearer_token')],
        };
    }
    if ((type === 'http' && httpScheme === 'basic') || type === 'basic') {
        return {
            auth: { type: 'basic', username: '{{username}}', password: '{{password}}' },
            variables: [
                { key: 'username', value: '', enabled: true, secret: false },
                secretVariable('password'),
            ],
        };
    }
    if (type === 'apikey' && (scheme.in === 'header' || scheme.in === 'query')) {
        return {
            auth: {
                type: 'api-key',
                key: str(scheme.name) || 'X-API-Key',
                value: '{{api_key}}',
                location: scheme.in,
            },
            variables: [secretVariable('api_key')],
        };
    }
    return null;
};

/** Converts an OpenAPI 3.x or Swagger 2.0 document into a collection. */
export const fromOpenApi = (doc: Json, fileName: string): ImportPlan => {
    const swagger = doc.swagger !== undefined;
    const version = str(swagger ? String(doc.swagger) : doc.openapi);
    if (swagger ? version !== '2.0' : !/^3\.\d+(\.\d+)?/.test(version)) {
        throw new ImportError(
            `OpenAPI version “${version || 'unknown'}” is not supported. Use OpenAPI 3.x or Swagger 2.0.`,
        );
    }
    if (!isObject(doc.info)) throw new ImportError('The specification has no “info” section.');
    if (!isObject(doc.paths)) throw new ImportError('The specification has no “paths” section.');

    const resolve = resolver(doc);
    const title = str(doc.info.title).trim() || fileName.replace(/\.[^.]+$/, '') || 'API';
    const collection = createCollection(title);
    collection.description = str(doc.info.description);
    const warnings: string[] = [];
    const variables: ImportedVariable[] = [];
    const addVariables = (items: ImportedVariable[]) => {
        for (const item of items) {
            if (!variables.some((existing) => existing.key === item.key)) variables.push(item);
        }
    };

    // Base URL: the first server (with its variables' defaults), or host + basePath in Swagger 2.
    let baseUrl = '';
    if (swagger) {
        const host = str(doc.host);
        const scheme = str(list(doc.schemes)[0]) || 'https';
        baseUrl = host ? `${scheme}://${host}${str(doc.basePath)}` : str(doc.basePath);
    } else {
        const server = list(doc.servers).find(isObject);
        if (server) {
            baseUrl = str(server.url).replace(/\{([^}]+)\}/g, (match, name: string) => {
                const variable = isObject(server.variables) ? server.variables[name] : undefined;
                return isObject(variable) && variable.default !== undefined
                    ? String(variable.default)
                    : match;
            });
        }
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
    addVariables([{ key: 'base_url', value: baseUrl, enabled: true, secret: false }]);

    // Security: the global requirement becomes the collection's authorization.
    const schemes =
        (swagger
            ? doc.securityDefinitions
            : isObject(doc.components)
              ? doc.components.securitySchemes
              : undefined) ?? {};
    const authFor = (requirement: unknown): AuthConfig | null => {
        const first = list(requirement).find(isObject);
        if (!first)
            return list(requirement).length === 0 && Array.isArray(requirement)
                ? { type: 'none' }
                : null;
        for (const name of Object.keys(first)) {
            const use = authForScheme(resolve(isObject(schemes) ? schemes[name] : undefined));
            if (use) {
                addVariables(use.variables);
                return use.auth;
            }
        }
        warnings.push('Some security schemes (such as OAuth 2.0 flows) were not imported.');
        return null;
    };
    if (doc.security !== undefined) collection.auth = authFor(doc.security) ?? { type: 'none' };

    const folders: Folder[] = [];
    const folderFor = (tag: string) => {
        let folder = folders.find((item) => item.name === tag);
        if (!folder) {
            folder = createFolder(collection.id, tag);
            const described = list(doc.tags).find((item) => isObject(item) && item.name === tag);
            if (isObject(described)) folder.description = str(described.description);
            folders.push(folder);
        }
        return folder;
    };

    const requests: HttpRequest[] = [];
    let skipped = 0;
    for (const [path, rawItem] of Object.entries(doc.paths)) {
        const item = resolve(rawItem);
        if (!isObject(item)) continue;
        if (isObject(item.trace) || isObject(item.connect)) skipped++;
        const shared = list(item.parameters);
        for (const method of OPERATIONS) {
            const operation = item[method];
            if (!isObject(operation)) continue;
            const upper = method.toUpperCase();
            if (!isHttpMethod(upper)) continue;
            const tag = str(list(operation.tags)[0]);
            const parent = tag ? folderFor(tag).id : collection.id;
            const request = createEmptyRequest(parent);
            request.method = upper;
            request.name =
                str(operation.summary).trim() ||
                str(operation.operationId).trim() ||
                `${upper} ${path}`;
            request.description = str(operation.description);

            // Operation parameters override path-level ones with the same name and location.
            const parameters = new Map<string, Json>();
            for (const raw of [...shared, ...list(operation.parameters)]) {
                const parameter = resolve(raw);
                if (isObject(parameter))
                    parameters.set(`${str(parameter.in)}:${str(parameter.name)}`, parameter);
            }
            const params: KeyValueItem[] = [];
            const headers: KeyValueItem[] = [];
            const formFields: MultipartField[] = [];
            let bodySchema: unknown;
            for (const parameter of parameters.values()) {
                const name = str(parameter.name);
                const example =
                    parameter.example ??
                    (isObject(parameter.schema)
                        ? exampleFor(parameter.schema, resolve)
                        : parameter.default);
                const value =
                    parameter.example !== undefined || parameter.default !== undefined
                        ? exampleText(example)
                        : '';
                const description = str(parameter.description) || undefined;
                switch (parameter.in) {
                    case 'query':
                        params.push(
                            createKeyValue({
                                key: name,
                                value,
                                description,
                                enabled: parameter.required === true,
                            }),
                        );
                        break;
                    case 'header':
                        if (!/^(accept|content-type|authorization)$/i.test(name)) {
                            headers.push(
                                createKeyValue({
                                    key: name,
                                    value,
                                    description,
                                    enabled: parameter.required === true,
                                }),
                            );
                        }
                        break;
                    case 'body':
                        bodySchema = parameter.schema;
                        break;
                    case 'formData':
                        formFields.push({
                            ...createKeyValue({ key: name, description }),
                            kind: parameter.type === 'file' ? 'file' : 'text',
                            file: null,
                        });
                        break;
                }
            }

            const enabledParams = params.filter((param) => param.enabled);
            request.url = urlWithParams(`{{base_url}}${pathTemplate(path)}`, enabledParams);
            request.params = [...enabledParams, ...params.filter((param) => !param.enabled)];
            request.headers = headers;

            // Request body: JSON first, then forms, XML and plain text.
            const content = swagger
                ? null
                : isObject(resolve(operation.requestBody))
                  ? (resolve(operation.requestBody) as Json).content
                  : null;
            const consumes = list(operation.consumes ?? doc.consumes).map(str);
            if (isObject(content)) {
                const types = Object.keys(content);
                const pick = (test: (type: string) => boolean) => types.find(test);
                const jsonType = pick((type) => /json/i.test(type));
                const formType = pick((type) => /x-www-form-urlencoded/i.test(type));
                const multipartType = pick((type) => /multipart\/form-data/i.test(type));
                const xmlType = pick((type) => /xml/i.test(type));
                const textType = pick((type) => /^text\//i.test(type));
                const media = (type: string) =>
                    isObject(content[type]) ? (content[type] as Json) : {};
                const mediaExample = (type: string) => {
                    const entry = media(type);
                    if (entry.example !== undefined) return entry.example;
                    const first = isObject(entry.examples)
                        ? Object.values(entry.examples)[0]
                        : undefined;
                    const resolved = resolve(first);
                    if (isObject(resolved) && resolved.value !== undefined) return resolved.value;
                    return exampleFor(entry.schema, resolve);
                };
                const fieldsOf = (type: string) => {
                    const schema = resolve(media(type).schema);
                    return isObject(schema) && isObject(schema.properties)
                        ? Object.entries(schema.properties)
                        : [];
                };
                if (jsonType) {
                    const example = mediaExample(jsonType);
                    request.body = {
                        ...request.body,
                        mode: 'json',
                        json:
                            typeof example === 'string' ? example : stringifyPretty(example ?? {}),
                    };
                } else if (formType) {
                    request.body = {
                        ...request.body,
                        mode: 'form-urlencoded',
                        formUrlEncoded: fieldsOf(formType).map(([key, schema]) =>
                            createKeyValue({
                                key,
                                value: exampleText(exampleFor(schema, resolve)),
                            }),
                        ),
                    };
                } else if (multipartType) {
                    request.body = {
                        ...request.body,
                        mode: 'multipart',
                        multipart: fieldsOf(multipartType).map(([key, schema]) => {
                            const resolved = resolve(schema);
                            const file =
                                isObject(resolved) &&
                                (resolved.format === 'binary' || resolved.format === 'base64');
                            return {
                                ...createKeyValue({
                                    key,
                                    value: file ? '' : exampleText(exampleFor(schema, resolve)),
                                }),
                                kind: file ? 'file' : 'text',
                                file: null,
                            };
                        }),
                    };
                } else if (xmlType || textType) {
                    const example = mediaExample((xmlType ?? textType)!);
                    request.body = {
                        ...request.body,
                        mode: 'text',
                        text: typeof example === 'string' ? example : '',
                        textContentType: xmlType ? 'application/xml' : 'text/plain',
                    };
                }
            } else if (bodySchema !== undefined) {
                request.body = {
                    ...request.body,
                    mode: 'json',
                    json: stringifyPretty(exampleFor(bodySchema, resolve) ?? {}),
                };
            } else if (formFields.length) {
                const multipart =
                    formFields.some((field) => field.kind === 'file') ||
                    consumes.some((type) => /multipart/i.test(type));
                request.body = multipart
                    ? { ...request.body, mode: 'multipart', multipart: formFields }
                    : {
                          ...request.body,
                          mode: 'form-urlencoded',
                          formUrlEncoded: formFields.map((field) =>
                              createKeyValue({
                                  key: field.key,
                                  value: field.value,
                                  description: field.description,
                                  enabled: field.enabled,
                              }),
                          ),
                      };
            }

            if (operation.security !== undefined) {
                const auth = authFor(operation.security);
                if (auth) request.auth = auth;
            }
            requests.push(request);
        }
    }
    if (skipped) warnings.push(`${skipped} TRACE/CONNECT operation(s) were skipped.`);
    if (requests.length === 0) {
        throw new ImportError('The specification does not define any operations to import.');
    }

    return {
        type: 'collection',
        format: swagger ? 'swagger' : 'openapi',
        collection,
        folders,
        requests,
        environment: {
            name: title,
            variables: variables.map((item) => ({ ...item, key: variableName(item.key) })),
        },
        warnings: [...new Set(warnings)],
    };
};
