/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createId, type KeyValueItem } from './model';

/**
 * Path variables are `:name` segments in a request URL (`/users/:userId`). Their values live in
 * the request's path-variable table, so the URL keeps the readable template. A `:` that is not
 * at the start of a path segment (a port, a scheme) is never a path variable.
 */
const SEGMENT = /(?<=\/):([A-Za-z_][\w.-]*)(?=\/|$)/g;

/** The path part of a URL: everything before the query string or fragment. */
const pathEnd = (url: string) => {
    const end = url.search(/[?#]/);
    return end < 0 ? url.length : end;
};

/** Distinct path-variable names in a URL, in order of appearance. */
export const pathVariableNames = (url: string): string[] => {
    const path = url.slice(0, pathEnd(url));
    return [...new Set([...path.matchAll(SEGMENT)].map((match) => match[1]!))];
};

/** The path-variable rows for a URL: one per `:name`, keeping the values already typed. */
export const syncPathVariables = (url: string, previous: KeyValueItem[] = []): KeyValueItem[] =>
    pathVariableNames(url).map(
        (key) =>
            previous.find((item) => item.key === key) ?? {
                id: createId(),
                key,
                value: '',
                enabled: true,
            },
    );

/** Keeps `{{variables}}` intact while percent-encoding everything else in a path value. */
const encodeSegment = (value: string) =>
    value
        .split(/(\{\{[^}]*\}\})/)
        .map((part, index) => (index % 2 ? part : encodeURIComponent(part)))
        .join('');

/** Substitutes path-variable values into the URL. Variables without a value stay as written. */
export const applyPathVariables = (url: string, variables: KeyValueItem[] = []): string => {
    const values = new Map(
        variables.filter((item) => item.enabled && item.value !== '').map((i) => [i.key, i.value]),
    );
    if (values.size === 0) return url;
    const end = pathEnd(url);
    const path = url
        .slice(0, end)
        .replace(SEGMENT, (match, name: string) =>
            values.has(name) ? encodeSegment(values.get(name)!) : match,
        );
    return path + url.slice(end);
};
