/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ObjectName, SqlDialect, SqlValue } from './dialect';

/**
 * Statements for the programmable objects of a relational database: views, functions, stored
 * procedures, triggers and sequences. MySQL and PostgreSQL do not share a model for these (a
 * PostgreSQL trigger runs a separate function; a MySQL trigger has its own body; PostgreSQL has
 * functions with `OUT` parameters and `RETURNS TABLE`), so each operation is written per dialect
 * rather than forced into one shape.
 */

/* ---------- Views ---------- */

export interface ViewDesign extends ObjectName {
    /** The SELECT that defines the view. */
    query: string;
    materialized?: boolean;
    /** MySQL: `WITH CHECK OPTION`. */
    checkOption?: boolean;
}

const stripSemicolon = (text: string) => text.trim().replace(/;+\s*$/, '');

export const createViewTemplate = (dialect: SqlDialect, name: Partial<ObjectName> = {}): string =>
    `CREATE VIEW ${dialect.qualify({ ...name, name: name.name ?? 'view_name' })} AS\nSELECT *\nFROM table_name;`;

export const createViewSql = (
    dialect: SqlDialect,
    view: ViewDesign,
    options: { replace?: boolean } = {},
): string => {
    const target = dialect.qualify(view);
    const query = stripSemicolon(view.query);
    if (view.materialized && dialect.id === 'postgresql')
        return `CREATE MATERIALIZED VIEW ${target} AS\n${query}\nWITH DATA;`;
    return `CREATE ${options.replace ? 'OR REPLACE ' : ''}VIEW ${target} AS\n${query}${
        view.checkOption && dialect.id === 'mysql' ? '\nWITH CHECK OPTION' : ''
    };`;
};

/** Editing a view: PostgreSQL's materialized views cannot be replaced, so they are dropped first. */
export const alterViewSql = (dialect: SqlDialect, view: ViewDesign): string[] =>
    view.materialized && dialect.id === 'postgresql'
        ? [dropViewSql(dialect, view), createViewSql(dialect, view)]
        : [createViewSql(dialect, view, { replace: true })];

export const dropViewSql = (
    dialect: SqlDialect,
    view: ObjectName & { materialized?: boolean },
    ifExists = false,
): string =>
    `DROP ${view.materialized && dialect.id === 'postgresql' ? 'MATERIALIZED ' : ''}VIEW ${ifExists ? 'IF EXISTS ' : ''}${dialect.qualify(view)};`;

export const refreshMaterializedViewSql = (dialect: SqlDialect, view: ObjectName): string =>
    `REFRESH MATERIALIZED VIEW ${dialect.qualify(view)};`;

/** Reads the SELECT out of a `CREATE VIEW … AS select` statement the server reported. */
export const viewQueryFromDefinition = (definition: string): string => {
    const match = /\bAS\b\s*([\s\S]*)$/i.exec(
        definition.replace(/\s+WITH\s+(?:CASCADED\s+|LOCAL\s+)?CHECK\s+OPTION\s*;?\s*$/i, ''),
    );
    return match ? stripSemicolon(match[1]!) : stripSemicolon(definition);
};

/* ---------- Functions and procedures ---------- */

export interface RoutineParameter {
    name: string;
    mode: 'IN' | 'OUT' | 'INOUT';
    type: string;
    /** PostgreSQL: a default value expression (only the trailing parameters may have one). */
    default?: string;
}

export interface RoutineDesign extends ObjectName {
    kind: 'function' | 'procedure';
    parameters: RoutineParameter[];
    /** The return type of a function. */
    returns?: string;
    language?: string;
    /** The body, without the surrounding `BEGIN … END` or `$$`. */
    body: string;
    deterministic?: boolean;
    /** `SQL SECURITY` (MySQL) / `SECURITY` (PostgreSQL): whose privileges the routine runs with. */
    security?: 'DEFINER' | 'INVOKER';
    /** MySQL: the routine's `COMMENT`. */
    comment?: string;
    /** PostgreSQL: the role that owns the routine. */
    owner?: string;
}

const parameterList = (dialect: SqlDialect, routine: RoutineDesign) =>
    routine.parameters
        .map((p) => {
            const name = dialect.quote(p.name);
            // A MySQL function takes only IN parameters, and does not write the mode.
            if (dialect.id === 'mysql' && routine.kind === 'function') return `${name} ${p.type}`;
            const base = `${p.mode} ${name} ${p.type}`;
            return dialect.id === 'postgresql' && p.default?.trim()
                ? `${base} DEFAULT ${p.default.trim()}`
                : base;
        })
        .join(', ');

export const createRoutineTemplate = (
    dialect: SqlDialect,
    kind: 'function' | 'procedure',
    name: Partial<ObjectName> = {},
): string => {
    const target = dialect.qualify({ ...name, name: name.name ?? `${kind}_name` });
    if (dialect.id === 'mysql') {
        return kind === 'function'
            ? `CREATE FUNCTION ${target}(input INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN input;\nEND;`
            : `CREATE PROCEDURE ${target}(IN input INT)\nBEGIN\n    SELECT input;\nEND;`;
    }
    return kind === 'function'
        ? `CREATE OR REPLACE FUNCTION ${target}(input integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN input;\nEND;\n$$;`
        : `CREATE OR REPLACE PROCEDURE ${target}(input integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RAISE NOTICE '%', input;\nEND;\n$$;`;
};

/** The statement that creates the routine described by the designer-like form. */
export const createRoutineSql = (
    dialect: SqlDialect,
    routine: RoutineDesign,
    options: { replace?: boolean } = {},
): string[] => {
    const target = dialect.qualify(routine);
    const word = routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
    if (dialect.id === 'mysql') {
        // MySQL has no OR REPLACE for routines: editing is a drop followed by a create.
        const head =
            `CREATE ${word} ${target}(${parameterList(dialect, routine)})` +
            (routine.kind === 'function' ? `\nRETURNS ${routine.returns ?? 'INT'}` : '') +
            (routine.kind === 'function'
                ? routine.deterministic
                    ? '\nDETERMINISTIC'
                    : '\nNOT DETERMINISTIC'
                : '') +
            (routine.security ? `\nSQL SECURITY ${routine.security}` : '') +
            (routine.comment?.trim()
                ? `\nCOMMENT ${dialect.literal({ kind: 'text', value: routine.comment.trim() })}`
                : '');
        const body = routine.body.trim();
        const create = /^begin\b/i.test(body) ? `${head}\n${body}` : `${head}\nBEGIN\n${body}\nEND`;
        const statements = [`${create.replace(/;+\s*$/, '')};`];
        return options.replace
            ? [dropRoutineSql(dialect, routine, true), ...statements]
            : statements;
    }
    const language = routine.language ?? 'plpgsql';
    const tag = dollarTag(routine.body);
    const returns = routine.kind === 'function' ? `\nRETURNS ${routine.returns ?? 'void'}` : '';
    const security = routine.security ? `\nSECURITY ${routine.security}` : '';
    const owner = routine.owner?.trim()
        ? [
              `ALTER ${word} ${target}(${routine.parameters
                  .filter((p) => p.mode !== 'OUT')
                  .map((p) => p.type)
                  .join(', ')}) OWNER TO ${dialect.quote(routine.owner.trim())};`,
          ]
        : [];
    return [
        `CREATE ${options.replace ? 'OR REPLACE ' : ''}${word} ${target}(${parameterList(dialect, routine)})${returns}\nLANGUAGE ${language}${security}\nAS ${tag}\n${routine.body.trim()}\n${tag};`,
        ...owner,
    ];
};

/** A dollar-quote tag that does not occur in the body. */
const dollarTag = (body: string): string => {
    let tag = '$$';
    let n = 0;
    while (body.includes(tag)) tag = `$body${n++ || ''}$`;
    return tag;
};

export const dropRoutineSql = (
    dialect: SqlDialect,
    routine: ObjectName & { kind: 'function' | 'procedure'; parameters?: RoutineParameter[] },
    ifExists = false,
): string => {
    const word = routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
    // PostgreSQL identifies a routine by its argument types, because names can be overloaded.
    const args =
        dialect.id === 'postgresql' && routine.parameters
            ? `(${routine.parameters
                  .filter((p) => p.mode !== 'OUT')
                  .map((p) => p.type)
                  .join(', ')})`
            : '';
    return `DROP ${word} ${ifExists ? 'IF EXISTS ' : ''}${dialect.qualify(routine)}${args};`;
};

/** The statement that runs a routine with the given arguments (one per IN/INOUT parameter). */
export const callRoutineSql = (
    dialect: SqlDialect,
    routine: ObjectName & { kind: 'function' | 'procedure'; parameters: RoutineParameter[] },
    args: SqlValue[],
): string => {
    const target = dialect.qualify(routine);
    const list = args.map((value) => dialect.literal(value)).join(', ');
    if (routine.kind === 'procedure') return `CALL ${target}(${list});`;
    return dialect.id === 'mysql'
        ? `SELECT ${target}(${list}) AS result;`
        : `SELECT * FROM ${target}(${list});`;
};

/**
 * The statements that run a routine with the given argument values, and show what it returned.
 * A MySQL procedure's OUT and INOUT parameters travel through session variables, so the call is
 * wrapped in the `SET @…` statements that feed them and a `SELECT @…` that reads them back; a
 * PostgreSQL function is selected from, and a procedure called with NULL standing in for OUT.
 * `values` holds one value per IN or INOUT parameter, by name.
 */
export const callStatements = (
    dialect: SqlDialect,
    routine: ObjectName & { kind: 'function' | 'procedure'; parameters: RoutineParameter[] },
    values: Record<string, SqlValue>,
): string[] => {
    const target = dialect.qualify(routine);
    const value = (p: RoutineParameter): SqlValue => values[p.name] ?? { kind: 'null' };
    if (dialect.id === 'postgresql') {
        const args = routine.parameters
            .filter((p) => routine.kind === 'procedure' || p.mode !== 'OUT')
            .map((p) => (p.mode === 'OUT' ? 'NULL' : dialect.literal(value(p))));
        return routine.kind === 'procedure'
            ? [`CALL ${target}(${args.join(', ')});`]
            : [`SELECT * FROM ${target}(${args.join(', ')});`];
    }
    if (routine.kind === 'function') {
        return [
            `SELECT ${target}(${routine.parameters.map((p) => dialect.literal(value(p))).join(', ')}) AS result;`,
        ];
    }
    const statements: string[] = [];
    const outputs: string[] = [];
    const args = routine.parameters.map((p, index) => {
        if (p.mode === 'IN') return dialect.literal(value(p));
        const variable = `@httpreq_${index + 1}`;
        statements.push(
            `SET ${variable} = ${p.mode === 'INOUT' ? dialect.literal(value(p)) : 'NULL'};`,
        );
        outputs.push(`${variable} AS ${dialect.quote(p.name)}`);
        return variable;
    });
    statements.push(`CALL ${target}(${args.join(', ')});`);
    if (outputs.length) statements.push(`SELECT ${outputs.join(', ')};`);
    return statements;
};

/** The parameters a caller must supply values for. */
export const inputParameters = (parameters: RoutineParameter[]): RoutineParameter[] =>
    parameters.filter((p) => p.mode !== 'OUT');

/**
 * Reads the parameter list out of a routine's definition, for the execute dialog. Best effort:
 * a routine whose signature cannot be read is run with no arguments the user can still edit.
 */
export const parametersFromDefinition = (
    dialect: SqlDialect,
    definition: string,
): RoutineParameter[] => {
    const head = /\b(?:FUNCTION|PROCEDURE)\s+(?:[`"\w.]+)\s*\(/i.exec(definition);
    if (!head) return [];
    let depth = 1;
    let index = head.index + head[0].length;
    const start = index;
    for (; index < definition.length && depth > 0; index++) {
        if (definition[index] === '(') depth++;
        else if (definition[index] === ')') depth--;
    }
    const inside = definition.slice(start, index - 1);
    const parts: string[] = [];
    let current = '';
    depth = 0;
    for (const char of inside) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else current += char;
    }
    if (current.trim()) parts.push(current);
    return parts.map((part, position): RoutineParameter => {
        const match =
            /^\s*(IN\s+OUT|INOUT|IN|OUT)?\s*([`"]?[\w$]+[`"]?)?\s+(.+?)\s*(?:(?:DEFAULT|=)\s+.+)?$/is.exec(
                part,
            );
        if (!match) return { name: `arg${position + 1}`, mode: 'IN', type: part.trim() };
        const mode = (match[1] ?? 'IN')
            .replace(/\s+/g, '')
            .toUpperCase() as RoutineParameter['mode'];
        // PostgreSQL allows an unnamed parameter: `integer` alone has no name to split off.
        if (!match[2]) return { name: `arg${position + 1}`, mode, type: match[3]!.trim() };
        void dialect;
        return { name: match[2].replace(/[`"]/g, ''), mode, type: match[3]!.trim() };
    });
};

/* ---------- Triggers ---------- */

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';

export interface TriggerDesign extends ObjectName {
    table: string;
    timing: TriggerTiming;
    events: TriggerEvent[];
    /** MySQL: the trigger body. PostgreSQL: the body of the function the trigger runs. */
    body: string;
    /** PostgreSQL: a `WHEN` condition. */
    when?: string;
    forEachRow?: boolean;
    /** MySQL: run before or after another trigger on the same table and event. */
    order?: { position: 'FOLLOWS' | 'PRECEDES'; trigger: string };
    /** PostgreSQL: `UPDATE OF col, …` limits an UPDATE trigger to those columns. */
    updateOf?: string[];
}

/** What the triggers of each engine allow, for the form. */
export const triggerOptions = (dialect: SqlDialect) => ({
    timings: (dialect.id === 'mysql'
        ? ['BEFORE', 'AFTER']
        : ['BEFORE', 'AFTER', 'INSTEAD OF']) as TriggerTiming[],
    events: (dialect.id === 'mysql'
        ? ['INSERT', 'UPDATE', 'DELETE']
        : ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as TriggerEvent[],
    // MySQL allows exactly one event per trigger; PostgreSQL several.
    multipleEvents: dialect.id === 'postgresql',
    canEnable: dialect.id === 'postgresql',
    /** A `WHEN (…)` condition. */
    condition: dialect.id === 'postgresql',
    /** `FOR EACH STATEMENT`; MySQL triggers are always row-level. */
    statementLevel: dialect.id === 'postgresql',
    /** `FOLLOWS` / `PRECEDES` another trigger. */
    ordering: dialect.id === 'mysql',
});

/** Why a trigger design cannot be created, in the engine's own rules; empty when it can. */
export const validateTrigger = (dialect: SqlDialect, trigger: TriggerDesign): string[] => {
    const problems: string[] = [];
    const options = triggerOptions(dialect);
    if (!trigger.name.trim()) problems.push('The trigger needs a name.');
    if (!trigger.table.trim()) problems.push('Choose the table the trigger belongs to.');
    if (trigger.events.length === 0) problems.push('Choose at least one event.');
    if (!options.timings.includes(trigger.timing))
        problems.push(`${trigger.timing} triggers are not available on this engine.`);
    if (trigger.events.length > 1 && !options.multipleEvents)
        problems.push('This engine allows one event per trigger.');
    for (const event of trigger.events)
        if (!options.events.includes(event))
            problems.push(`${event} triggers are not available on this engine.`);
    if (!trigger.body.trim()) problems.push('The trigger needs a body.');
    if (dialect.id === 'postgresql') {
        const statement = trigger.forEachRow === false;
        if (trigger.events.includes('TRUNCATE') && !statement)
            problems.push('A TRUNCATE trigger runs once per statement.');
        if (trigger.timing === 'INSTEAD OF' && statement)
            problems.push('An INSTEAD OF trigger runs once per row.');
        if (trigger.when?.trim() && trigger.events.includes('TRUNCATE'))
            problems.push('A TRUNCATE trigger cannot have a condition.');
    }
    if (trigger.order && !trigger.order.trigger.trim())
        problems.push('Choose the trigger to order this one against.');
    return problems;
};

export const createTriggerTemplate = (dialect: SqlDialect, table: ObjectName): string =>
    dialect.id === 'mysql'
        ? `CREATE TRIGGER ${dialect.quote('trigger_name')}\nBEFORE INSERT ON ${dialect.qualify(table)}\nFOR EACH ROW\nBEGIN\n    -- NEW.column = ...;\nEND;`
        : `CREATE OR REPLACE FUNCTION ${dialect.qualify({ schema: table.schema, name: 'trigger_function' })}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER ${dialect.quote('trigger_name')}\nBEFORE INSERT ON ${dialect.qualify(table)}\nFOR EACH ROW\nEXECUTE FUNCTION ${dialect.qualify({ schema: table.schema, name: 'trigger_function' })}();`;

export const createTriggerSql = (dialect: SqlDialect, trigger: TriggerDesign): string[] => {
    const tableName = dialect.qualify({ ...trigger, name: trigger.table });
    if (dialect.id === 'mysql') {
        const event = trigger.events[0] ?? 'INSERT';
        const body = trigger.body.trim();
        const wrapped = /^begin\b/i.test(body) ? body : `BEGIN\n${body}\nEND`;
        const order = trigger.order
            ? `\n${trigger.order.position} ${dialect.quote(trigger.order.trigger)}`
            : '';
        return [
            `CREATE TRIGGER ${dialect.qualify(trigger)}\n${trigger.timing} ${event} ON ${tableName}\nFOR EACH ROW${order}\n${wrapped.replace(/;+\s*$/, '')};`,
        ];
    }
    const fn = dialect.qualify({ schema: trigger.schema, name: `${trigger.name}_fn` });
    const tag = dollarTag(trigger.body);
    return [
        `CREATE OR REPLACE FUNCTION ${fn}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS ${tag}\n${trigger.body.trim()}\n${tag};`,
        `CREATE TRIGGER ${dialect.quote(trigger.name)}\n${trigger.timing} ${trigger.events
            .map((event) =>
                event === 'UPDATE' && trigger.updateOf?.length
                    ? `UPDATE OF ${trigger.updateOf.map((column) => dialect.quote(column)).join(', ')}`
                    : event,
            )
            .join(
                ' OR ',
            )} ON ${tableName}\nFOR EACH ${trigger.forEachRow === false ? 'STATEMENT' : 'ROW'}${
            trigger.when ? `\nWHEN (${trigger.when})` : ''
        }\nEXECUTE FUNCTION ${fn}();`,
    ];
};

export const dropTriggerSql = (
    dialect: SqlDialect,
    trigger: ObjectName & { table: string },
    ifExists = false,
): string =>
    dialect.id === 'mysql'
        ? `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}${dialect.qualify(trigger)};`
        : `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}${dialect.quote(trigger.name)} ON ${dialect.qualify({ schema: trigger.schema, name: trigger.table })};`;

/** Enabling and disabling exist only where the engine has them (PostgreSQL). */
export const setTriggerEnabledSql = (
    dialect: SqlDialect,
    trigger: ObjectName & { table: string },
    enabled: boolean,
): string | null =>
    dialect.id === 'postgresql'
        ? `ALTER TABLE ${dialect.qualify({ schema: trigger.schema, name: trigger.table })} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${dialect.quote(trigger.name)};`
        : null;

/* ---------- Sequences (PostgreSQL) ---------- */

export interface SequenceDesign extends ObjectName {
    start?: string;
    increment?: string;
    minValue?: string;
    maxValue?: string;
    cycle?: boolean;
}

export const createSequenceSql = (dialect: SqlDialect, sequence: SequenceDesign): string => {
    const part = (keyword: string, value?: string) =>
        value !== undefined && /^-?\d+$/.test(value.trim()) ? ` ${keyword} ${value.trim()}` : '';
    return `CREATE SEQUENCE ${dialect.qualify(sequence)}${part('INCREMENT BY', sequence.increment)}${part('MINVALUE', sequence.minValue)}${part('MAXVALUE', sequence.maxValue)}${part('START WITH', sequence.start)}${sequence.cycle ? ' CYCLE' : ''};`;
};

export const dropSequenceSql = (dialect: SqlDialect, sequence: ObjectName): string =>
    `DROP SEQUENCE ${dialect.qualify(sequence)};`;

export const restartSequenceSql = (
    dialect: SqlDialect,
    sequence: ObjectName,
    value: string,
): string =>
    `ALTER SEQUENCE ${dialect.qualify(sequence)} RESTART WITH ${/^-?\d+$/.test(value.trim()) ? value.trim() : '1'};`;

/* ---------- Routine validation ---------- */

/** What the routine form offers for each engine. */
export const routineOptions = (dialect: SqlDialect, kind: 'function' | 'procedure') => ({
    modes: (dialect.id === 'mysql' && kind === 'function'
        ? ['IN']
        : ['IN', 'OUT', 'INOUT']) as RoutineParameter['mode'][],
    languages: dialect.id === 'postgresql' ? ['plpgsql', 'sql'] : [],
    parameterDefaults: dialect.id === 'postgresql',
    deterministic: dialect.id === 'mysql' && kind === 'function',
    security: true,
    comment: dialect.id === 'mysql',
    owner: dialect.id === 'postgresql',
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Why a routine cannot be created; empty when it can. */
export const validateRoutine = (dialect: SqlDialect, routine: RoutineDesign): string[] => {
    const problems: string[] = [];
    const options = routineOptions(dialect, routine.kind);
    if (!routine.name.trim()) problems.push(`The ${routine.kind} needs a name.`);
    const seen = new Set<string>();
    routine.parameters.forEach((p, index) => {
        const label = `Parameter ${index + 1}`;
        if (!p.name.trim()) problems.push(`${label} needs a name.`);
        else if (!IDENTIFIER.test(p.name.trim()))
            problems.push(`${label}: "${p.name}" is not a plain identifier.`);
        else if (seen.has(p.name.toLowerCase()))
            problems.push(`${label}: "${p.name}" is used twice.`);
        seen.add(p.name.toLowerCase());
        if (!p.type.trim()) problems.push(`${label} needs a data type.`);
        if (!options.modes.includes(p.mode))
            problems.push(`${label}: ${p.mode} is not available for a ${routine.kind}.`);
    });
    if (routine.kind === 'function' && !routine.returns?.trim())
        problems.push('A function needs a return type.');
    if (!routine.body.trim()) problems.push(`The ${routine.kind} needs a body.`);
    return problems;
};
