/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Validation of a JSON request body that knows `{{variables}}`.
 *
 * A body is written with variables that are substituted before it is sent, so `"id": {{user_id}}`
 * is valid here although it is not JSON yet. Monaco's own JSON validation rejects that and
 * underlines it, which is why validation is done here instead: a variable stands in for any value
 * (and anywhere inside a string), and everything else is checked strictly. Only the first problem
 * in the structure is reported, as a parser cannot say anything reliable after it; duplicate keys
 * are reported as warnings because they do not stop the parse.
 */

export interface JsonDiagnostic {
    message: string;
    /** Offset of the problem in the text, and how many characters it covers. */
    offset: number;
    length: number;
    severity: 'error' | 'warning';
}

type TokenKind = 'punctuation' | 'string' | 'number' | 'literal' | 'variable' | 'word' | 'end';

interface Token {
    kind: TokenKind;
    text: string;
    offset: number;
}

/** Thrown by the parser at the first structural problem. */
class SyntaxProblem extends Error {
    constructor(
        message: string,
        readonly offset: number,
        readonly length: number,
    ) {
        super(message);
    }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const VARIABLE = /\{\{[^{}\n]*\}\}/y;
const LITERAL = /(?:true|false|null)(?![\w$])/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

class Scanner {
    private position = 0;
    readonly duplicateKeys: JsonDiagnostic[] = [];

    constructor(private readonly text: string) {}

    next(): Token {
        this.skipWhitespace();
        const { text } = this;
        const offset = this.position;
        if (offset >= text.length) return { kind: 'end', text: '', offset };
        const char = text[offset]!;

        // A variable starts with `{{`, so it is tried before the single `{` of an object.
        const variable = this.match(VARIABLE);
        if (variable) return { kind: 'variable', text: variable, offset };
        if ('{}[],:'.includes(char)) {
            this.position += 1;
            return { kind: 'punctuation', text: char, offset };
        }
        if (char === '"') return this.string(offset);
        if (char === "'") {
            throw new SyntaxProblem('Strings must use double quotes.', offset, 1);
        }
        const number = this.match(NUMBER);
        if (number) return { kind: 'number', text: number, offset };
        const literal = this.match(LITERAL);
        if (literal) return { kind: 'literal', text: literal, offset };
        // A bare word is a token too: whether it is wrong depends on where the parser finds it.
        const bare = this.match(WORD);
        if (bare) return { kind: 'word', text: bare, offset };
        throw new SyntaxProblem(`Unexpected character “${char}”.`, offset, 1);
    }

    /** Where the scanner is, for errors about what ended the text. */
    get end(): number {
        return this.text.length;
    }

    private match(pattern: RegExp): string | undefined {
        pattern.lastIndex = this.position;
        const found = pattern.exec(this.text)?.[0];
        if (found) this.position += found.length;
        return found;
    }

    private skipWhitespace(): void {
        const { text } = this;
        for (;;) {
            const char = text[this.position];
            if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                this.position += 1;
            } else if (
                char === '/' &&
                (text[this.position + 1] === '/' || text[this.position + 1] === '*')
            ) {
                const block = text[this.position + 1] === '*';
                const close = block
                    ? text.indexOf('*/', this.position + 2)
                    : text.indexOf('\n', this.position);
                const length =
                    (close === -1 ? text.length : block ? close + 2 : close) - this.position;
                throw new SyntaxProblem(
                    'Comments are not allowed in JSON.',
                    this.position,
                    Math.max(2, length),
                );
            } else {
                return;
            }
        }
    }

    private string(start: number): Token {
        const { text } = this;
        let index = start + 1;
        while (index < text.length) {
            const char = text[index]!;
            if (char === '"') {
                this.position = index + 1;
                return { kind: 'string', text: text.slice(start, index + 1), offset: start };
            }
            if (char === '\n' || char === '\r') break;
            if (char < ' ') {
                throw new SyntaxProblem(
                    'Control characters in a string must be escaped.',
                    index,
                    1,
                );
            }
            if (char === '\\') {
                const escape = text[index + 1];
                if (escape === 'u') {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
                        throw new SyntaxProblem(
                            '\\u must be followed by four hexadecimal digits.',
                            index,
                            2,
                        );
                    }
                    index += 6;
                    continue;
                }
                if (escape === undefined || !ESCAPES.has(escape)) {
                    throw new SyntaxProblem(`Invalid escape sequence \\${escape ?? ''}.`, index, 2);
                }
                index += 2;
                continue;
            }
            index += 1;
        }
        throw new SyntaxProblem(
            'This string is not closed. Add the closing double quote.',
            start,
            1,
        );
    }
}

class Parser {
    private current: Token;

    constructor(private readonly scanner: Scanner) {
        this.current = scanner.next();
    }

    parseDocument(): void {
        this.value();
        if (this.current.kind !== 'end') {
            throw new SyntaxProblem(
                'Unexpected content after the end of the JSON value.',
                this.current.offset,
                Math.max(1, this.current.text.length),
            );
        }
    }

    private advance(): Token {
        const token = this.current;
        this.current = this.scanner.next();
        return token;
    }

    private is(text: string): boolean {
        return this.current.kind === 'punctuation' && this.current.text === text;
    }

    private unexpected(expected: string): SyntaxProblem {
        const { current } = this;
        if (current.kind === 'end') {
            return new SyntaxProblem(
                `The JSON ends unexpectedly. Expected ${expected}.`,
                Math.max(0, this.scanner.end - 1),
                1,
            );
        }
        return new SyntaxProblem(
            `Expected ${expected}.`,
            current.offset,
            Math.max(1, current.text.length),
        );
    }

    private value(): void {
        const { current } = this;
        if (current.kind === 'punctuation' && current.text === '{') return this.object();
        if (current.kind === 'punctuation' && current.text === '[') return this.array();
        if (
            current.kind === 'string' ||
            current.kind === 'number' ||
            current.kind === 'literal' ||
            current.kind === 'variable'
        ) {
            this.advance();
            return;
        }
        if (current.kind === 'word') {
            throw new SyntaxProblem(
                `“${current.text}” is not valid here. Use true, false, null, a number, or a double-quoted string.`,
                current.offset,
                current.text.length,
            );
        }
        throw this.unexpected('a value');
    }

    private object(): void {
        const open = this.advance();
        const seen = new Set<string>();
        if (this.is('}')) {
            this.advance();
            return;
        }
        for (;;) {
            const key = this.current;
            if (key.kind !== 'string') {
                if (this.is('}')) {
                    throw new SyntaxProblem(
                        'Remove the trailing comma before the closing brace.',
                        this.lastComma,
                        1,
                    );
                }
                if (key.kind === 'word') {
                    throw new SyntaxProblem(
                        `Property names must be in double quotes: "${key.text}".`,
                        key.offset,
                        key.text.length,
                    );
                }
                throw this.unexpected('a property name in double quotes');
            }
            this.advance();
            const name = key.text;
            if (seen.has(name)) {
                this.scanner.duplicateKeys.push({
                    message: `Duplicate key ${name}. Only the last one is used.`,
                    offset: key.offset,
                    length: key.text.length,
                    severity: 'warning',
                });
            }
            seen.add(name);
            if (!this.is(':')) throw this.unexpected("':' after the property name");
            this.advance();
            this.value();
            if (this.is(',')) {
                this.lastComma = this.advance().offset;
                continue;
            }
            if (this.is('}')) {
                this.advance();
                return;
            }
            if (this.current.kind === 'end') {
                throw new SyntaxProblem(
                    `The object opened here is never closed. Add '}'.`,
                    open.offset,
                    1,
                );
            }
            throw this.unexpected("',' or '}'");
        }
    }

    private array(): void {
        const open = this.advance();
        if (this.is(']')) {
            this.advance();
            return;
        }
        for (;;) {
            if (this.is(']')) {
                throw new SyntaxProblem(
                    'Remove the trailing comma before the closing bracket.',
                    this.lastComma,
                    1,
                );
            }
            this.value();
            if (this.is(',')) {
                this.lastComma = this.advance().offset;
                continue;
            }
            if (this.is(']')) {
                this.advance();
                return;
            }
            if (this.current.kind === 'end') {
                throw new SyntaxProblem(
                    `The array opened here is never closed. Add ']'.`,
                    open.offset,
                    1,
                );
            }
            throw this.unexpected("',' or ']'");
        }
    }

    private lastComma = 0;
}

/** Problems in a JSON body, or an empty list when it is valid (or empty: no body is not an error). */
export const jsonDiagnostics = (text: string): JsonDiagnostic[] => {
    if (!text.trim()) return [];
    const scanner = new Scanner(text);
    try {
        new Parser(scanner).parseDocument();
    } catch (error) {
        if (!(error instanceof SyntaxProblem)) throw error;
        return [
            ...scanner.duplicateKeys,
            {
                message: error.message,
                offset: error.offset,
                length: error.length,
                severity: 'error',
            },
        ];
    }
    return scanner.duplicateKeys;
};

/** `line 3, column 5` for an offset, counting from 1. */
export const lineAndColumn = (text: string, offset: number): { line: number; column: number } => {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
};

/** The first error as one sentence with its position, for a badge or a tooltip; null when valid. */
export const firstJsonError = (text: string): string | null => {
    const error = jsonDiagnostics(text).find((diagnostic) => diagnostic.severity === 'error');
    if (!error) return null;
    const { line, column } = lineAndColumn(text, error.offset);
    return `${error.message} (line ${line}, column ${column})`;
};
