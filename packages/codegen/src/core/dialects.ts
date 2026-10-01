/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * How each language writes a string literal. Escaping is the part of code generation that goes
 * wrong silently (a body containing a quote, a backslash or a line separator that one language
 * treats specially), so it lives here once per language and generators only ask for "a literal".
 *
 * A dialect offers two forms:
 * - `literal`: one line, every special character escaped. Always available.
 * - `block`: a multi-line literal for bodies that are readable as lines (JSON, XML). It returns
 *   `null` when the text cannot be written that way without changing it (a carriage return, a
 *   delimiter inside the text, a control character), and the caller falls back to `literal`.
 *   `indent` is the indentation of the line the literal starts on; languages whose literals strip
 *   indentation (Java, C#, Swift, PHP, Ruby) use it to line the closing delimiter up with the code.
 */
export interface StringDialect {
    literal(text: string): string;
    block(text: string, indent: string): string | null;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Lone surrogates cannot be encoded as UTF-8, and Go, Rust and Swift reject them in literals. */
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '\ufffd');

const hasLoneSurrogate = (text: string): boolean => wellFormed(text) !== text;

/** Control characters other than tab and line feed: not representable in a raw multi-line literal. */
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_BLOCK = /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const unicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** JSON string syntax with extra characters written as escapes. */
const jsonLiteral =
    (extra?: RegExp) =>
    (text: string): string => {
        const quoted = JSON.stringify(text);
        return extra ? quoted.replace(extra, unicodeEscape) : quoted;
    };

const prefixed = (lines: string[], indent: string): string[] =>
    lines.map((line) => (line === '' ? '' : indent + line));

const trimEnd = (lines: string[]): string[] => lines.map((line) => line.replace(/[ \t]+$/, ''));

/** The longest run of `char` in `text`. */
const longestRun = (text: string, char: string): number =>
    Math.max(0, ...(text.match(new RegExp(`${char}+`, 'g')) ?? []).map((run) => run.length));

export const jsDialect: StringDialect = {
    literal: jsonLiteral(),
    block: (text) =>
        text.includes('\r')
            ? null
            : `\`${text.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${')}\``,
};

export const pythonDialect: StringDialect = {
    literal: jsonLiteral(),
    block: (text) => {
        if (UNSAFE_IN_BLOCK.test(text)) return null;
        const escaped = text.replace(/\\/g, '\\\\');
        for (const quote of ['"""', "'''"]) {
            if (!escaped.includes(quote) && !escaped.endsWith(quote[0]!)) {
                return `${quote}${escaped}${quote}`;
            }
        }
        return null;
    },
};

export const javaDialect: StringDialect = {
    literal: jsonLiteral(),
    block: (text, indent) => {
        if (UNSAFE_IN_BLOCK.test(text) || text === '') return null;
        const escaped = text
            .replace(/\\/g, '\\\\')
            .replace(/"{3,}/g, (run) => run.replace(/"/g, '\\"'));
        const lines = trimEnd(escaped.split('\n'));
        const endsWithNewline = lines.at(-1) === '';
        if (endsWithNewline) lines.pop();
        const body = prefixed(lines, indent);
        // A trailing backslash joins the last line to the closing delimiter, so no newline is added.
        if (!endsWithNewline) body[body.length - 1] += '\\';
        return ['"""', ...body, `${indent}"""`].join('\n');
    },
};

export const csharpDialect: StringDialect = {
    // C# treats U+0085, U+2028 and U+2029 as line terminators, which a string literal cannot hold.
    literal: jsonLiteral(/[\u0085\u2028\u2029]/g),
    block: (text, indent) => {
        if (UNSAFE_IN_BLOCK.test(text) || /[\u0085\u2028\u2029]/.test(text) || text === '') {
            return null;
        }
        const delimiter = '"'.repeat(Math.max(3, longestRun(text, '"') + 1));
        return [delimiter, ...prefixed(text.split('\n'), indent), `${indent}${delimiter}`].join(
            '\n',
        );
    },
};

export const goDialect: StringDialect = {
    literal: (text) => jsonLiteral()(wellFormed(text)),
    // A raw string is exact, so its lines are not indented; Go forbids a backtick or a NUL in one,
    // and drops carriage returns.
    block: (text) =>
        ['`', '\r', '\u0000', '\ufeff'].some((char) => text.includes(char)) ||
        hasLoneSurrogate(text)
            ? null
            : `\`${text}\``,
};

export const phpDialect: StringDialect = {
    literal: (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
    block: (text, indent) => {
        if (UNSAFE_IN_BLOCK.test(text) || text === '') return null;
        const lines = text.split('\n');
        let marker = 'BODY';
        while (lines.some((line) => line.trim().startsWith(marker))) marker += '_';
        return [`<<<'${marker}'`, ...prefixed(lines, indent), `${indent}${marker}`].join('\n');
    },
};

export const rubyDialect: StringDialect = {
    literal: (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
    block: (text, indent) => {
        if (UNSAFE_IN_BLOCK.test(text) || text === '') return null;
        const lines = text.split('\n');
        const endsWithNewline = lines.at(-1) === '';
        if (endsWithNewline) lines.pop();
        let marker = 'BODY';
        while (lines.some((line) => line.trim() === marker)) marker += '_';
        // A heredoc always ends with a newline; `chomp` removes it when the text had none.
        return [
            `<<~'${marker}'${endsWithNewline ? '' : '.chomp'}`,
            ...prefixed(lines, indent),
            `${indent}${marker}`,
        ].join('\n');
    },
};

/** PowerShell reads the typographic single quotes as a quote, so they are doubled like `'`. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

export const powershellDialect: StringDialect = {
    literal: (text) => `'${text.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`,
    // A here-string's terminator must start its line, so nothing is indented.
    block: (text) =>
        text.includes('\r') ||
        text === '' ||
        text.split('\n').some((line) => /^['\u2018\u2019\u201a\u201b]@/.test(line))
            ? null
            : `@'\n${text}\n'@`,
};

export const swiftDialect: StringDialect = {
    literal: (text) =>
        `"${[...wellFormed(text)]
            .map((char) => {
                const code = char.codePointAt(0)!;
                if (char === '"' || char === '\\') return `\\${char}`;
                if (char === '\n') return '\\n';
                if (char === '\r') return '\\r';
                if (char === '\t') return '\\t';
                return code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char;
            })
            .join('')}"`,
    block: (text, indent) => {
        if (UNSAFE_IN_BLOCK.test(text) || hasLoneSurrogate(text) || text === '') return null;
        // A raw string (`#"""`) needs no escaping of backslashes, as long as the text cannot
        // end it early or start an interpolation.
        const raw = text.includes('\\');
        if (raw && (text.includes('"""#') || text.includes('\\#('))) return null;
        const body = raw ? text : text.replace(/"{3,}/g, (run) => run.replace(/"/g, '\\"'));
        const hashes = raw ? '#' : '';
        return [
            `${hashes}"""`,
            ...prefixed(body.split('\n'), indent),
            `${indent}"""${hashes}`,
        ].join('\n');
    },
};

/** POSIX shell single quotes: nothing is special inside them except the quote itself. */
export const shellDialect: StringDialect = {
    literal: (text) => `'${text.replace(/'/g, `'\\''`)}'`,
    block: (text) => `'${text.replace(/'/g, `'\\''`)}'`,
};

/** A literal for the text, as a block when the language and the text allow it. */
export const literalOrBlock = (
    dialect: StringDialect,
    text: string,
    indent: string,
    preferBlock: boolean,
): string =>
    (preferBlock && text.includes('\n') ? dialect.block(text, indent) : null) ??
    dialect.literal(text);
