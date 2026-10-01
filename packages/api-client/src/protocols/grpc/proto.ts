/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import * as protobuf from 'protobufjs';
import {
    AppError,
    type ProtoDescription,
    type ProtoFile,
    type ProtoMethod,
    type ProtoService,
} from '@httpreq/shared';

/**
 * `.proto` handling shared by the editor (service and method discovery, message skeletons) and the
 * desktop transport (encoding and decoding). Definitions are untrusted input: they are bounded in
 * size and count, imports are resolved only from the files the user supplied or from the bundled
 * well-known types, and nothing is ever read from the file system or fetched from the network.
 */

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLE_DEPTH = 3;

const fail = (message: string, cause?: unknown): never => {
    throw new AppError('INVALID_REQUEST', message, cause ? { cause } : undefined);
};

const findFile = (files: ProtoFile[], name: string) =>
    files.find((file) => file.name === name) ??
    files.find((file) => file.name.endsWith(`/${name}`) || name.endsWith(`/${file.name}`));

/** Parses the files into one reflection root, resolving `import`s from `files` or the built-ins. */
export const loadProtoRoot = (files: ProtoFile[]): protobuf.Root => {
    if (files.length === 0) fail('Add a .proto file to describe the service.');
    if (files.length > MAX_FILES) fail(`At most ${MAX_FILES} .proto files are supported.`);
    if (files.reduce((total, file) => total + file.content.length, 0) > MAX_TOTAL_BYTES) {
        fail('The .proto files are larger than 4 MB.');
    }
    const root = new protobuf.Root();
    const loaded = new Set<string>();

    const load = (name: string, content: string, from: string) => {
        if (loaded.has(name)) return;
        loaded.add(name);
        let imports: string[] = [];
        try {
            const result = protobuf.parse(content, root, {
                keepCase: true,
                alternateCommentMode: true,
            });
            imports = [...(result.imports ?? []), ...(result.weakImports ?? [])];
        } catch (cause) {
            fail(`${name}: ${(cause as Error).message}`, cause);
        }
        for (const imported of imports) {
            const supplied = findFile(files, imported);
            if (supplied) {
                load(supplied.name, supplied.content, name);
                continue;
            }
            const builtin = protobuf.common.get(imported);
            if (builtin) {
                if (!loaded.has(imported)) {
                    loaded.add(imported);
                    root.addJSON(builtin.nested ?? {});
                }
                continue;
            }
            fail(
                `${from === name ? name : name}: the import “${imported}” was not found. Add that file.`,
            );
        }
    };

    const [entry, ...rest] = files as [ProtoFile, ...ProtoFile[]];
    load(entry.name, entry.content, entry.name);
    // Files that nothing imports are still part of the project (extra services, shared types).
    for (const file of rest) load(file.name, file.content, file.name);
    try {
        root.resolveAll();
    } catch (cause) {
        fail((cause as Error).message, cause);
    }
    return root;
};

const collectServices = (namespace: protobuf.NamespaceBase, into: protobuf.Service[]) => {
    for (const nested of namespace.nestedArray) {
        if (nested instanceof protobuf.Service) into.push(nested);
        else if (nested instanceof protobuf.Namespace) collectServices(nested, into);
    }
};

const fullName = (service: protobuf.Service) => service.fullName.replace(/^\./, '');

/** The services and methods a set of `.proto` files defines. */
export const describeProto = (files: ProtoFile[]): ProtoDescription => {
    const root = loadProtoRoot(files);
    const services: protobuf.Service[] = [];
    collectServices(root, services);
    return {
        services: services.map((service): ProtoService => ({
            fullName: fullName(service),
            name: service.name,
            methods: service.methodsArray.map((method): ProtoMethod => ({
                name: method.name,
                requestType: method.requestType,
                responseType: method.responseType,
                clientStreaming: !!method.requestStream,
                serverStreaming: !!method.responseStream,
            })),
        })),
    };
};

export interface ResolvedMethod {
    method: protobuf.Method;
    requestType: protobuf.Type;
    responseType: protobuf.Type;
    /** The gRPC path: `/package.Service/Method`. */
    path: string;
}

export const resolveMethod = (
    root: protobuf.Root,
    service: string,
    name: string,
): ResolvedMethod => {
    const found = root.lookup(service);
    if (!(found instanceof protobuf.Service)) fail(`The service “${service}” is not defined.`);
    const method = (found as protobuf.Service).methods[name];
    if (!method) fail(`The service “${service}” has no method “${name}”.`);
    const resolved = method as protobuf.Method;
    resolved.resolve();
    return {
        method: resolved,
        requestType: resolved.resolvedRequestType as protobuf.Type,
        responseType: resolved.resolvedResponseType as protobuf.Type,
        path: `/${fullName(found as protobuf.Service)}/${name}`,
    };
};

const sampleField = (field: protobuf.Field, depth: number, seen: string[]): unknown => {
    field.resolve();
    const resolved = field.resolvedType;
    if (resolved instanceof protobuf.Type) {
        return depth >= MAX_SAMPLE_DEPTH || seen.includes(resolved.fullName)
            ? {}
            : sampleType(resolved, depth + 1, [...seen, resolved.fullName]);
    }
    if (resolved instanceof protobuf.Enum) return Object.keys(resolved.values)[0] ?? 0;
    switch (field.type) {
        case 'string':
        case 'bytes':
            return '';
        case 'bool':
            return false;
        case 'int64':
        case 'uint64':
        case 'sint64':
        case 'fixed64':
        case 'sfixed64':
            return '0';
        default:
            return 0;
    }
};

const sampleType = (
    type: protobuf.Type,
    depth: number,
    seen: string[],
): Record<string, unknown> => {
    const sample: Record<string, unknown> = {};
    for (const field of type.fieldsArray) {
        sample[field.name] = field.map ? {} : field.repeated ? [] : sampleField(field, depth, seen);
    }
    return sample;
};

/** A JSON skeleton of a method's request message, to start editing from. */
export const sampleRequestJson = (files: ProtoFile[], service: string, method: string): string => {
    const { requestType } = resolveMethod(loadProtoRoot(files), service, method);
    return JSON.stringify(sampleType(requestType, 0, [requestType.fullName]), null, 2);
};

const camelCase = (name: string) =>
    name.replace(/_+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());

/**
 * Maps the keys of a JSON message onto the declared field names, accepting either `snake_case`
 * or `camelCase`, and rejects keys the message does not have: a typo would otherwise be dropped
 * silently and the call would go out without the value.
 */
const normalizeMessage = (type: protobuf.Type, value: unknown, path: string): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const aliases = new Map(type.fieldsArray.map((field) => [camelCase(field.name), field.name]));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const declared = type.fields[key] ? key : aliases.get(key);
        const field = declared ? type.fields[declared] : undefined;
        if (!declared || !field) {
            fail(
                `“${path ? `${path}.` : ''}${key}” is not a field of ${type.fullName.replace(/^\./, '')}.`,
            );
            continue;
        }
        field.resolve();
        const target = field.resolvedType;
        const at = `${path ? `${path}.` : ''}${declared}`;
        if (target instanceof protobuf.Type) {
            result[declared] = field.map
                ? mapValues(item, (entry) => normalizeMessage(target, entry, at))
                : Array.isArray(item)
                  ? item.map((entry, index) => normalizeMessage(target, entry, `${at}[${index}]`))
                  : normalizeMessage(target, item, at);
        } else result[declared] = item;
    }
    return result;
};

const mapValues = (value: unknown, convert: (item: unknown) => unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]))
        : value;

/** Encodes JSON text as the protobuf wire message of `type`. */
export const encodeMessage = (type: protobuf.Type, json: string): Uint8Array => {
    let parsed: unknown;
    try {
        parsed = json.trim() ? JSON.parse(json) : {};
    } catch (cause) {
        return fail(`The request message is not valid JSON: ${(cause as Error).message}`, cause);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('The request message must be a JSON object.');
    }
    const normalized = normalizeMessage(type, parsed, '') as Record<string, unknown>;
    try {
        return type.encode(type.fromObject(normalized)).finish();
    } catch (cause) {
        return fail(
            `The request message does not fit ${type.name}: ${(cause as Error).message}`,
            cause,
        );
    }
};

/** Decodes a wire message into plain JSON (64-bit integers as strings, enums by name). */
export const decodeMessage = (type: protobuf.Type, bytes: Uint8Array): unknown =>
    type.toObject(type.decode(bytes), {
        longs: String,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true,
    });
