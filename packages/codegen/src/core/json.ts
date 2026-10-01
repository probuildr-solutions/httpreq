/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

export type JsonValue =
    null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * `text` without insignificant whitespace, with every string rewritten in its canonical escaped
 * form, so two spellings of the same document compare equal. Only valid JSON should be passed in.
 */
const canonicalize = (text: string): string => {
    let out = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index]!;
        if (char === '"') {
            let end = index + 1;
            while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
            out += JSON.stringify(JSON.parse(text.slice(index, end + 1)) as string);
            index = end + 1;
        } else {
            if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') out += char;
            index += 1;
        }
    }
    return out;
};

const hasKey = (value: JsonValue, name: string): boolean =>
    Array.isArray(value)
        ? value.some((item) => hasKey(item, name))
        : value !== null && typeof value === 'object'
          ? Object.entries(value).some(([key, item]) => key === name || hasKey(item, name))
          : false;

/**
 * The value of a JSON object or array, but only when writing it back out would not change the
 * document. A generator may then present the body as a native data structure (an object literal,
 * a dictionary) instead of an escaped string. Anything that would not survive the round trip
 * through a JavaScript value (`1.0`, integers beyond 2^53, duplicate keys, integer-like keys that
 * JavaScript reorders) returns `undefined`, and the body stays a string, byte for byte.
 */
export const parseLosslessJson = (text: string): JsonValue | undefined => {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (value === null || typeof value !== 'object') return undefined;
    if (JSON.stringify(value) !== canonicalize(text)) return undefined;
    // `{ __proto__: x }` sets a prototype in JavaScript rather than a key.
    if (hasKey(value as JsonValue, '__proto__')) return undefined;
    return value as JsonValue;
};

/** How a language spells JSON data: its constants, keys and punctuation. */
export interface JsonStyle {
    /** One level of indentation. */
    indent: string;
    key(name: string): string;
    string(value: string): string;
    constants: { null: string; true: string; false: string };
    /** Between a key and its value, e.g. `: `. */
    separator: string;
}

const INLINE_LIMIT = 60;

const isScalar = (value: JsonValue): value is null | boolean | number | string =>
    value === null || typeof value !== 'object';

const scalar = (value: null | boolean | number | string, style: JsonStyle): string => {
    if (value === null) return style.constants.null;
    if (typeof value === 'boolean') return value ? style.constants.true : style.constants.false;
    if (typeof value === 'number') return String(value);
    return style.string(value);
};

/**
 * Writes `value` as a data literal. The first line carries no indentation (the caller places it
 * after an assignment or an argument name); continuation lines are indented from `base`, the
 * indentation of that first line.
 */
export const renderJson = (value: JsonValue, base: string, style: JsonStyle): string => {
    if (isScalar(value)) return scalar(value, style);
    const inner = base + style.indent;
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        if (value.every(isScalar)) {
            const inline = `[${value.map((item) => scalar(item, style)).join(', ')}]`;
            if (inline.length <= INLINE_LIMIT && !inline.includes('\n')) return inline;
        }
        const items = value.map((item) => `${inner}${renderJson(item, inner, style)},`);
        return ['[', ...items, `${base}]`].join('\n');
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const members = entries.map(
        ([key, item]) =>
            `${inner}${style.key(key)}${style.separator}${renderJson(item, inner, style)},`,
    );
    return ['{', ...members, `${base}}`].join('\n');
};
