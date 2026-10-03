/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Small, dependency-free helpers for the SQL bodies of triggers, routines and events: a formatter
 * that re-indents blocks, and a check for the mistakes that make a body unrunnable before it ever
 * reaches the server (an unclosed quote, comment or parenthesis).
 */

const INDENT = '    ';

/** Lines that open a block and lines that close one, matched on their first words. */
const OPENS =
    /^(?:BEGIN\b|LOOP\b|REPEAT\b|(?:[A-Za-z_]\w*:\s*)?(?:LOOP|REPEAT|WHILE\b.*\bDO)\b|CASE\b|IF\b.*\bTHEN\b|ELSEIF\b.*\bTHEN\b|ELSIF\b.*\bTHEN\b|ELSE\b|DECLARE\b.*\bHANDLER\b.*\bBEGIN\b)/i;
const CLOSES = /^(?:END\b|UNTIL\b)/i;
const DEDENT_THEN_INDENT = /^(?:ELSE\b|ELSEIF\b|ELSIF\b|WHEN\b.*\bTHEN\b(?!.*\bEND\b))/i;

/**
 * Re-indents a body by its blocks (`BEGIN`/`END`, `IF`/`END IF`, loops, `CASE`) with four spaces,
 * trims trailing whitespace and collapses runs of blank lines. It does not reorder, rename or
 * recase anything, and leaves the inside of string literals and comments alone because it only
 * ever touches the leading whitespace of a line.
 */
export const formatSqlBody = (text: string): string => {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let depth = 0;
    let inBlockComment = false;
    let blank = 0;
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        const trimmed = line.trim();
        if (inBlockComment) {
            out.push(line);
            if (trimmed.includes('*/')) inBlockComment = false;
            continue;
        }
        if (trimmed === '') {
            if (++blank <= 1 && out.length > 0) out.push('');
            continue;
        }
        blank = 0;
        if (/^\/\*/.test(trimmed) && !trimmed.includes('*/')) {
            out.push(INDENT.repeat(depth) + trimmed);
            inBlockComment = true;
            continue;
        }
        const closes = CLOSES.test(trimmed);
        const middle = DEDENT_THEN_INDENT.test(trimmed);
        if (closes || middle) depth = Math.max(0, depth - 1);
        out.push(INDENT.repeat(depth) + trimmed);
        const opens =
            OPENS.test(trimmed) &&
            !/\bEND\s*(?:IF|LOOP|WHILE|CASE|REPEAT)?\s*;?\s*$/i.test(trimmed);
        if (opens && !closes) depth++;
        else if (middle && !closes) depth++;
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
};

/**
 * Mistakes visible without a server: an unterminated string, quoted name or comment, and
 * parentheses that do not balance. Text inside strings and comments is not counted.
 */
export const checkSqlBody = (text: string): string[] => {
    const problems: string[] = [];
    let parens = 0;
    let line = 1;
    let index = 0;
    const lineOf = () => line;
    while (index < text.length) {
        const char = text[index]!;
        const next = text[index + 1];
        if (char === '\n') line++;
        if (char === '-' && next === '-') {
            while (index < text.length && text[index] !== '\n') index++;
            continue;
        }
        if (char === '#') {
            while (index < text.length && text[index] !== '\n') index++;
            continue;
        }
        if (char === '/' && next === '*') {
            const start = lineOf();
            const end = text.indexOf('*/', index + 2);
            if (end < 0) {
                problems.push(`The comment opened on line ${start} is never closed.`);
                return problems;
            }
            line += text.slice(index, end).split('\n').length - 1;
            index = end + 2;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            const start = lineOf();
            let closed = false;
            index++;
            while (index < text.length) {
                const c = text[index]!;
                if (c === '\n') line++;
                if (c === char) {
                    if (text[index + 1] === char) {
                        index += 2;
                        continue;
                    }
                    closed = true;
                    index++;
                    break;
                }
                if (c === '\\' && char !== '`') index++;
                index++;
            }
            if (!closed) {
                problems.push(
                    `The ${char === '`' ? 'quoted name' : 'string'} opened on line ${start} is never closed.`,
                );
                return problems;
            }
            continue;
        }
        if (char === '(') parens++;
        if (char === ')') {
            parens--;
            if (parens < 0) {
                problems.push(`There is a ")" without a "(" on line ${lineOf()}.`);
                parens = 0;
            }
        }
        index++;
    }
    if (parens > 0) problems.push(`${parens} "(" ${parens === 1 ? 'is' : 'are'} never closed.`);
    return problems;
};
