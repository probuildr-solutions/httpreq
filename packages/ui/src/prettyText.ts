/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { INDENT_SIZE, stringifyPretty } from './indent';

/** Structured body formats the response viewer can pretty-print. */
export type PrettyKind = 'json' | 'xml';

export interface PrettyResult {
    text: string;
    /** False when the text is not valid for its kind; `text` is then the input, unchanged. */
    ok: boolean;
}

/** Indents JSON text; invalid JSON comes back unchanged with `ok: false`. */
export const prettyJsonText = (text: string): PrettyResult => {
    try {
        return { text: stringifyPretty(JSON.parse(text)), ok: true };
    } catch {
        return { text, ok: false };
    }
};

const TOKEN = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^<>]+>)/;
const tagName = (tag: string) => tag.match(/^<\/?\s*([^\s/>]+)/)?.[1] ?? '';

/**
 * Indents XML one element per line. It checks that tags nest and close properly as it goes, and
 * anything that does not (or is not XML at all) comes back unchanged with `ok: false`, so a
 * malformed body is shown as it arrived instead of being mangled.
 */
export const prettyXmlText = (text: string): PrettyResult => {
    const tokens = text
        .split(TOKEN)
        .map((token) => token.trim())
        .filter(Boolean);
    if (!tokens.some((token) => token.startsWith('<') && !token.startsWith('<?'))) {
        return { text, ok: false };
    }
    const lines: string[] = [];
    const stack: string[] = [];
    const pad = () => ' '.repeat(stack.length * INDENT_SIZE);
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        const special = /^<(!|\?)/.test(token);
        if (!token.startsWith('<') || special) {
            lines.push(pad() + token);
        } else if (token.startsWith('</')) {
            if (stack.pop() !== tagName(token)) return { text, ok: false };
            lines.push(pad() + token);
        } else if (token.endsWith('/>')) {
            lines.push(pad() + token);
        } else {
            const name = tagName(token);
            const next = tokens[index + 1];
            const after = tokens[index + 2];
            // `<name>text</name>` stays on one line.
            if (next !== undefined && !next.startsWith('<') && after?.startsWith('</')) {
                if (tagName(after) !== name) return { text, ok: false };
                lines.push(pad() + token + next + after);
                index += 2;
                continue;
            }
            lines.push(pad() + token);
            stack.push(name);
        }
    }
    return stack.length ? { text, ok: false } : { text: lines.join('\n'), ok: true };
};

export const prettyText = (text: string, kind: PrettyKind): PrettyResult =>
    kind === 'json' ? prettyJsonText(text) : prettyXmlText(text);
