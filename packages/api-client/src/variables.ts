/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createId, type Environment } from '@httpreq/shared';

/** `{{name}}`; whitespace inside the braces is tolerated, as in other API clients. */
export const VARIABLE_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export interface TemplateSegment {
    text: string;
    /** Set when the segment is a `{{variable}}` reference. */
    variable?: string;
    start: number;
    end: number;
}

/** Splits text into literal and variable segments, for highlighting. */
export const parseTemplate = (text: string): TemplateSegment[] => {
    const segments: TemplateSegment[] = [];
    let last = 0;
    for (const match of text.matchAll(VARIABLE_PATTERN)) {
        const start = match.index;
        if (start > last) segments.push({ text: text.slice(last, start), start: last, end: start });
        segments.push({ text: match[0], variable: match[1], start, end: start + match[0].length });
        last = start + match[0].length;
    }
    if (last < text.length)
        segments.push({ text: text.slice(last), start: last, end: text.length });
    return segments;
};

export const hasVariables = (text: string) => new RegExp(VARIABLE_PATTERN.source).test(text);

/** True when the text consists only of variable references (and whitespace). */
export const isTemplateOnly = (text: string) =>
    hasVariables(text) && text.replace(VARIABLE_PATTERN, '').trim() === '';

export interface VariableDefinition {
    name: string;
    value: string;
    secret: boolean;
    /** Where the value comes from, e.g. the environment name, or "Dynamic". */
    source: string;
    dynamic?: boolean;
}

/** Built-in values generated fresh for every reference. */
export const DYNAMIC_VARIABLES: Record<string, { description: string; generate: () => string }> = {
    $guid: { description: 'A random UUID v4', generate: () => createId() },
    $timestamp: {
        description: 'Current Unix time in seconds',
        generate: () => String(Math.floor(Date.now() / 1000)),
    },
    $isoTimestamp: {
        description: 'Current time in ISO 8601',
        generate: () => new Date().toISOString(),
    },
    $randomInt: {
        description: 'A random integer from 0 to 1000',
        generate: () => String(Math.floor(Math.random() * 1001)),
    },
};

const MAX_DEPTH = 5;

export interface VariableResolver {
    /** Describes a variable without generating dynamic values. */
    lookup(name: string): VariableDefinition | undefined;
    /** Substitutes every known variable; unknown references are left as written. */
    resolve(text: string): string;
    /** Names referenced by `resolve` calls that had no definition. */
    readonly unresolved: ReadonlySet<string>;
    /** Names of every variable available, for autocomplete. */
    names(): string[];
}

export interface ResolverOptions {
    /** Leaves secret variables as `{{name}}` (for sharing, e.g. "Copy as cURL"). */
    keepSecrets?: boolean;
}

/**
 * Resolves `{{variables}}` from the active environment. Values may reference other variables;
 * nesting is followed up to a fixed depth, so cycles can never hang the resolver.
 */
export const createVariableResolver = (
    environment: Environment | null | undefined,
    options: ResolverOptions = {},
): VariableResolver => {
    const values = new Map<string, VariableDefinition>();
    for (const variable of environment?.variables ?? []) {
        if (!variable.enabled || !variable.key) continue;
        values.set(variable.key, {
            name: variable.key,
            value: variable.value,
            secret: variable.secret,
            source: environment!.name,
        });
    }
    const unresolved = new Set<string>();

    const lookup = (name: string): VariableDefinition | undefined => {
        const defined = values.get(name);
        if (defined) return defined;
        const dynamic = DYNAMIC_VARIABLES[name];
        return dynamic
            ? { name, value: dynamic.description, secret: false, source: 'Dynamic', dynamic: true }
            : undefined;
    };

    const substitute = (text: string, depth: number): string =>
        text.replace(VARIABLE_PATTERN, (match, name: string) => {
            const defined = values.get(name);
            if (defined) {
                if (options.keepSecrets && defined.secret) return match;
                return depth < MAX_DEPTH ? substitute(defined.value, depth + 1) : defined.value;
            }
            const dynamic = DYNAMIC_VARIABLES[name];
            if (dynamic) return dynamic.generate();
            unresolved.add(name);
            return match;
        });

    return {
        lookup,
        resolve: (text) => (text.includes('{{') ? substitute(text, 0) : text),
        unresolved,
        names: () => [...values.keys(), ...Object.keys(DYNAMIC_VARIABLES)],
    };
};
