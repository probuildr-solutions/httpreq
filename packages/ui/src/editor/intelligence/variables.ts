/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { parseTemplate, type VariableDefinition } from '@httpreq/api-client';

/**
 * The parts of `{{variable}}` support that do not depend on Monaco: where the cursor is relative
 * to a variable, and how a variable is described. The Monaco adapters (completion, hover,
 * decorations) only translate between these results and editor positions.
 */

/** An unfinished `{{name` at the cursor, and the range to replace when one is chosen. */
export interface VariableTrigger {
    /** What has been typed of the name so far. */
    query: string;
    /** Zero-based columns on the line: the range a chosen name replaces. */
    start: number;
    end: number;
    /** Whether `}}` already follows the cursor (editors that auto-close brackets add it). */
    closed: boolean;
}

const OPENING = /\{\{\s*([^{}\s]*)$/;
const REST_OF_REFERENCE = /^[^{}\s]*\s*\}\}/;

/** The variable reference being typed at `column` of `line`, or null when the cursor is elsewhere. */
export const variableTrigger = (line: string, column: number): VariableTrigger | null => {
    const before = line.slice(0, column);
    const opening = OPENING.exec(before);
    if (!opening) return null;
    const query = opening[1]!;
    const closing = REST_OF_REFERENCE.exec(line.slice(column));
    return {
        query,
        start: before.length - query.length,
        end: column + (closing?.[0].length ?? 0),
        closed: !!closing,
    };
};

/** A complete `{{name}}` on the line that the column touches, or null. */
export const variableAt = (
    line: string,
    column: number,
): { name: string; start: number; end: number } | null => {
    for (const segment of parseTemplate(line)) {
        if (segment.variable && column >= segment.start && column <= segment.end) {
            return { name: segment.variable, start: segment.start, end: segment.end };
        }
    }
    return null;
};

/** Every `{{name}}` in a text, with its offsets, for decorating a whole document. */
export const variablesIn = (text: string): { name: string; start: number; end: number }[] =>
    parseTemplate(text).flatMap((segment) =>
        segment.variable
            ? [{ name: segment.variable, start: segment.start, end: segment.end }]
            : [],
    );

/** The value to show for a variable: secrets are never put on screen by a hover or a hint. */
export const previewValue = (definition: VariableDefinition): string => {
    if (definition.dynamic) return 'generated when the request is sent';
    if (definition.secret) return '••••••••';
    return definition.value === '' ? '(empty)' : definition.value;
};

/** Ranks names for a query: those starting with it first, then those containing it. */
export const matchNames = (names: readonly string[], query: string, limit = 50): string[] => {
    const needle = query.toLowerCase();
    const starts: string[] = [];
    const contains: string[] = [];
    for (const name of names) {
        const lower = name.toLowerCase();
        if (lower.startsWith(needle)) starts.push(name);
        else if (lower.includes(needle)) contains.push(name);
    }
    return [...starts, ...contains].slice(0, limit);
};
