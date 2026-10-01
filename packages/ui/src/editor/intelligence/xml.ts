/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Helpers for editing XML and SOAP bodies. Monaco's XML grammar highlights tags but never closes
 * them, and SOAP envelopes are mostly nested tags, so the useful piece is knowing which element
 * is still open at the cursor.
 */

// Comments, CDATA, processing instructions and tags, in the order they must be recognised.
const MARKUP =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?!--)[^>]*>|<(\/)?([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/)?>/g;

/**
 * The elements opened but not yet closed in `text`, outermost first. A trailing, unfinished tag
 * (the user is typing it) is ignored.
 */
export const openElements = (text: string): string[] => {
    const stack: string[] = [];
    for (const match of text.matchAll(MARKUP)) {
        const [, closing, name, , selfClosing] = match;
        if (!name || selfClosing) continue;
        if (closing) {
            // A stray close tag is dropped; one that matches pops everything opened inside it.
            const at = stack.lastIndexOf(name);
            if (at >= 0) stack.length = at;
        } else {
            stack.push(name);
        }
    }
    return stack;
};

/**
 * The element a `</` typed at the end of `before` should close, or null when nothing is open.
 * `before` is the text up to the cursor, including the `</` and any letters typed after it.
 */
export const elementToClose = (before: string): { name: string; partial: string } | null => {
    const typing = /<\/([A-Za-z_][\w:.-]*)?$/.exec(before);
    if (!typing) return null;
    const name = openElements(before.slice(0, typing.index)).at(-1);
    return name ? { name, partial: typing[1] ?? '' } : null;
};

/** Names of the elements used in a document, for suggesting a tag name after `<`. */
export const elementNames = (text: string): string[] => {
    const names = new Set<string>();
    for (const match of text.matchAll(MARKUP)) {
        const name = match[2];
        if (name) names.add(name);
    }
    return [...names];
};
