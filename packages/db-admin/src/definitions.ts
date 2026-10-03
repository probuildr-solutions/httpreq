/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ObjectName, SqlDialect } from './dialect';
import {
    parametersFromDefinition,
    type RoutineDesign,
    type TriggerDesign,
    type TriggerEvent,
    type TriggerTiming,
} from './objects';

/**
 * Reads the statements a server reports for an existing object back into the model the forms edit.
 * Best effort: a definition that does not look as expected returns `null`, and the caller falls
 * back to showing the SQL as text rather than guessing.
 */

const unquote = (text: string): string => text.replace(/^[`"]|[`"]$/g, '');

/** Splits `schema.name` into its parts, ignoring quotes. */
const lastName = (qualified: string): string =>
    unquote(qualified.trim().split('.').pop() ?? qualified);

/** The text between the first `$tag$` pair, or null. */
const dollarBody = (definition: string): string | null => {
    const open = /\$([A-Za-z_]*)\$/.exec(definition);
    if (!open) return null;
    const tag = open[0];
    const start = open.index + tag.length;
    const end = definition.indexOf(tag, start);
    return end < 0 ? null : definition.slice(start, end).replace(/^\n|\n$/g, '');
};

/* ---------- Routines ---------- */

export const routineFromDefinition = (
    dialect: SqlDialect,
    definition: string,
    name: ObjectName,
    kind: 'function' | 'procedure',
): RoutineDesign | null => {
    const parameters = parametersFromDefinition(dialect, definition);
    const design: RoutineDesign = { ...name, kind, parameters, body: '' };
    if (dialect.id === 'postgresql') {
        const body = dollarBody(definition);
        if (body === null) return null;
        design.body = body.trim();
        design.language = /\bLANGUAGE\s+(\w+)/i.exec(definition)?.[1]?.toLowerCase() ?? 'plpgsql';
        if (kind === 'function')
            design.returns =
                /\bRETURNS\s+([\s\S]+?)\s+(?:LANGUAGE|AS|SECURITY|IMMUTABLE|STABLE|VOLATILE)\b/i
                    .exec(definition)?.[1]
                    ?.trim();
        if (/\bSECURITY\s+DEFINER\b/i.test(definition)) design.security = 'DEFINER';
        return design;
    }
    // MySQL: everything from BEGIN (or the single statement after the characteristics) is the body.
    const head = /\b(?:FUNCTION|PROCEDURE)\s+[`"\w.]+\s*\(/i.exec(definition);
    if (!head) return null;
    let depth = 1;
    let index = head.index + head[0].length;
    for (; index < definition.length && depth > 0; index++) {
        if (definition[index] === '(') depth++;
        else if (definition[index] === ')') depth--;
    }
    const rest = definition.slice(index);
    if (kind === 'function')
        design.returns = /^\s*RETURNS\s+([^\n]+?)\s*(?:\n|$)/i.exec(rest)?.[1]?.trim() ?? 'INT';
    design.deterministic =
        /\bDETERMINISTIC\b/i.test(rest) && !/\bNOT\s+DETERMINISTIC\b/i.test(rest);
    const security = /\bSQL\s+SECURITY\s+(DEFINER|INVOKER)\b/i.exec(rest)?.[1];
    if (security) design.security = security.toUpperCase() as 'DEFINER' | 'INVOKER';
    const comment = /\bCOMMENT\s+'((?:[^']|'')*)'/i.exec(rest)?.[1];
    if (comment) design.comment = comment.replace(/''/g, "'");
    const begin = /\bBEGIN\b/i.exec(rest);
    const characteristics = /(?:^|\n)\s*(?:RETURN|SELECT|INSERT|UPDATE|DELETE|SET|CALL)\b/i.exec(
        rest,
    );
    const start = begin?.index ?? characteristics?.index;
    if (start === undefined) return null;
    design.body = rest
        .slice(start)
        .replace(/^\s*BEGIN\b/i, '')
        .replace(/\bEND\s*;?\s*$/i, '')
        .trim();
    return design;
};

/* ---------- Triggers ---------- */

export const triggerFromDefinition = (
    dialect: SqlDialect,
    definition: string,
    name: ObjectName,
    table: string,
    functionBody?: string,
): TriggerDesign | null => {
    const header =
        /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+((?:INSERT|UPDATE(?:\s+OF\s+[^\n]+?)?|DELETE|TRUNCATE)(?:\s+OR\s+(?:INSERT|UPDATE(?:\s+OF\s+[^\n]+?)?|DELETE|TRUNCATE))*)\s+ON\s+([^\s]+)/i.exec(
            definition,
        );
    if (!header) return null;
    const timing = header[1]!.replace(/\s+/g, ' ').toUpperCase() as TriggerTiming;
    const events = [...header[2]!.matchAll(/INSERT|UPDATE|DELETE|TRUNCATE/gi)].map(
        (m) => m[0].toUpperCase() as TriggerEvent,
    );
    const design: TriggerDesign = {
        ...name,
        table: lastName(header[3]!) || table,
        timing,
        events: [...new Set(events)],
        body: '',
    };
    const updateOf = /UPDATE\s+OF\s+(.+?)(?=\s+OR\s|$)/i.exec(header[2]!)?.[1];
    if (updateOf)
        design.updateOf = updateOf
            .split(',')
            .map((column) => unquote(column.trim()))
            .filter(Boolean);
    if (dialect.id === 'postgresql') {
        design.forEachRow = !/\bFOR\s+EACH\s+STATEMENT\b/i.test(definition);
        const when = /\bWHEN\s*\(([\s\S]*?)\)\s*EXECUTE\b/i.exec(definition)?.[1];
        if (when) design.when = when.trim();
        if (functionBody === undefined) return null;
        design.body = functionBody;
        return design;
    }
    const order = /\bFOR\s+EACH\s+ROW\s+(FOLLOWS|PRECEDES)\s+([`"\w]+)/i.exec(definition);
    if (order)
        design.order = {
            position: order[1]!.toUpperCase() as 'FOLLOWS' | 'PRECEDES',
            trigger: unquote(order[2]!),
        };
    const body = /\bFOR\s+EACH\s+ROW\s+(?:(?:FOLLOWS|PRECEDES)\s+[`"\w]+\s+)?([\s\S]*)$/i.exec(
        definition,
    )?.[1];
    if (body === undefined) return null;
    design.body = body
        .trim()
        .replace(/^BEGIN\b/i, '')
        .replace(/\bEND\s*;?\s*$/i, '')
        .trim();
    return design;
};

/** The name of the function a PostgreSQL trigger runs, from `EXECUTE FUNCTION schema.name()`. */
export const triggerFunctionName = (
    definition: string,
): { schema?: string; name: string } | null => {
    const match = /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([^\s(]+)/i.exec(definition);
    if (!match) return null;
    const parts = match[1]!.split('.').map(unquote);
    const name = parts.pop();
    return name ? { schema: parts.pop(), name } : null;
};

/** The body of a PostgreSQL function definition (`$$ … $$`), for a trigger's function. */
export const functionBodyFromDefinition = (definition: string): string | null => {
    const body = dollarBody(definition);
    return body === null ? null : body.trim();
};
