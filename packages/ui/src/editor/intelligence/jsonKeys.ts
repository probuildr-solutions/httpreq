/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { HttpRequest } from '@httpreq/shared';

/**
 * Property names the workspace already uses in JSON bodies, most used first. Requests of one API
 * share a vocabulary (`id`, `email`, `createdAt`…), so the keys of the other requests are the
 * best suggestion for the property names of this one. Variables are tolerated: a body with
 * `{{x}}` in value position still contributes its keys.
 */

const MAX_KEYS = 300;
const MAX_BODY_LENGTH = 200_000;

/** Collects the keys of one JSON text into `counts`, skipping what it cannot read. */
const collect = (text: string, counts: Map<string, number>): void => {
    if (text.length > MAX_BODY_LENGTH) return;
    let value: unknown;
    try {
        // A variable is replaced by a number, which is valid as a value and inside a string alike.
        value = JSON.parse(text.replace(/\{\{[^{}\n]*\}\}/g, '0'));
    } catch {
        return;
    }
    const visit = (node: unknown, depth: number) => {
        if (depth > 12 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach((item) => visit(item, depth + 1));
            return;
        }
        for (const [key, child] of Object.entries(node)) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
            visit(child, depth + 1);
        }
    };
    visit(value, 0);
};

export const collectJsonKeys = (requests: readonly HttpRequest[]): string[] => {
    const counts = new Map<string, number>();
    for (const request of requests) {
        if (request.body.mode === 'json' && request.body.json.trim()) {
            collect(request.body.json, counts);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_KEYS)
        .map(([key]) => key);
};

/**
 * Whether the cursor is where a property name goes: inside a string that is directly after `{`
 * or `,` in an object. Reads the text before the cursor backwards, ignoring what the string
 * contains. Returns the typed part of the name, or null when the cursor is somewhere else.
 */
export const propertyNameAt = (before: string): { partial: string; start: number } | null => {
    // The open string the cursor is in: find its opening quote on this line.
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    let quote = -1;
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\') i += 1;
        else if (line[i] === '"') quote = quote === -1 ? i : -1;
    }
    if (quote === -1) return null;
    const preceding = before.slice(0, lineStart + quote).trimEnd();
    const last = preceding[preceding.length - 1];
    if (last !== '{' && last !== ',') return null;
    if (last === ',' && !insideObject(preceding)) return null;
    return { partial: line.slice(quote + 1), start: lineStart + quote + 1 };
};

/** Whether the innermost open bracket before the end of `text` is `{` rather than `[`. */
const insideObject = (text: string): boolean => {
    const stack: string[] = [];
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i]!;
        if (inString) {
            if (char === '\\') i += 1;
            else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') stack.pop();
    }
    return stack[stack.length - 1] === '{';
};
