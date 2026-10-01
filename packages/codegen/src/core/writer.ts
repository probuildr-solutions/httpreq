/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Builds source text one line at a time and owns indentation, so a generator states the structure
 * of the program (`out.block('{', '}', () => …)`) and never counts spaces. Blank lines are
 * collapsed and never lead or trail the output, which lets a generator write `out.blank()`
 * between sections without checking whether the section before it was empty.
 */
export class CodeWriter {
    private readonly rows: string[] = [];
    private depth = 0;
    private pendingBlank = false;

    /** `unit` is one level of indentation: spaces, or a tab for Go. */
    constructor(readonly unit: string) {}

    /** The indentation of the line about to be written; block literals line up with it. */
    get indentation(): string {
        return this.unit.repeat(this.depth);
    }

    /**
     * Writes `text` at the current depth. Only its first line is indented: any further lines are a
     * multi-line literal that already carries the indentation the language needs (see
     * `StringDialect.block`), and re-indenting them would change the string.
     */
    line(text = ''): this {
        if (text === '') return this.blank();
        const [first = '', ...rest] = text.split('\n');
        this.push(first === '' ? '' : this.indentation + first);
        for (const part of rest) this.push(part);
        return this;
    }

    /** Several lines; falsy entries are skipped so a generator can write optional lines inline. */
    lines(...parts: (string | false | null | undefined)[]): this {
        for (const part of parts) if (typeof part === 'string') this.line(part);
        return this;
    }

    blank(): this {
        if (this.rows.length > 0) this.pendingBlank = true;
        return this;
    }

    /** Runs `body` one level deeper. */
    indent(body: () => void): this {
        this.depth += 1;
        try {
            body();
        } finally {
            this.depth -= 1;
        }
        return this;
    }

    /** `open`, the indented body, then `close`: `out.block('func main() {', '}', …)`. */
    block(open: string, close: string, body: () => void): this {
        this.line(open);
        this.indent(body);
        return this.line(close);
    }

    toString(): string {
        return this.rows.join('\n');
    }

    private push(row: string) {
        if (this.pendingBlank) {
            this.rows.push('');
            this.pendingBlank = false;
        }
        this.rows.push(row);
    }
}
